import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandFailure, commandPath } from "./command-path.js";
import { pinnedToKeg } from "./homebrew.js";
import { logProblem } from "./launch.js";

// Start at login on macOS: a launchd agent,
// ~/Library/LaunchAgents/app.getengram.daemon.plist. launchd loads the
// agents there when the user logs in, and starts the daemon (RunAtLoad), and
// again after a crash (KeepAlive). `engram install` loads it there and then.

export const PLIST_LABEL = "app.getengram.daemon";

// Bump when generatePlist() changes in a way existing installs must pick up.
// A plist is written once at install time and never revisited, so upgrading
// the CLI alone does NOT fix a defect that lives in the plist — the stale file
// keeps launching the old thing. Every machine installed before v2 is still
// pointing launchd at `worker-main.js`, the pre-0.4.2 entry point that has no
// ABI preflight, which is why the self-heal shipped in 0.4.2 has never once
// run on them (engram#469).
//
// v2: launch `worker.js` (preflight bootstrap) and give the job a PATH.
export const PLIST_VERSION = 2;

/** What marks which version of the plist an install has: a variable in the job's environment. */
const VERSION_ENV = "ENGRAM_PLIST_VERSION";

/** Each launchctl call; one that hangs counts as one that failed. */
const LAUNCHCTL_TIMEOUT_MS = 15_000;

/** How long a reload waits for launchd to let go of the job it unloads. */
const UNLOAD_WAIT_MS = 5_000;

export function plistDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

export function plistPath(): string {
  return join(plistDir(), `${PLIST_LABEL}.plist`);
}

export interface PlistPaths {
  /** Node, through any links. */
  node: string;
  /** This build's dist/daemon/worker.js. */
  worker: string;
  /**
   * ~/.engram/daemon.log: the job's output goes there. Null for none, while
   * it can't be written (engram#679): launchd doesn't start a job whose log
   * it can't open, ever, and the daemon doesn't need one to capture.
   */
  log: string | null;
  home: string;
  /** The PATH the daemon runs with. */
  path: string;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Half of a UTF-16 pair without the other half: no file name has one, and launchd can't read one. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A value as the text of a <string>, which launchd reads back exactly
 * (engram#616): `&`, `<` and `>` escaped, as macOS's own plist writer
 * escapes them. A raw `<` made a plist launchd couldn't load, so start at
 * login quietly did nothing; a raw `&`, one launchd loads but plutil and
 * every other tool that reads plists through CoreFoundation refuses.
 *
 * A control character is refused instead, as in a systemd unit: XML 1.0
 * forbids most of them. Exported for tests.
 */
export function xmlText(s: string): string {
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error(`a path with a control character in it: ${JSON.stringify(s)}`);
  if (LONE_SURROGATE.test(s)) throw new Error(`a path that isn't valid Unicode: ${JSON.stringify(s)}`);
  return s.replace(/[&<>]/g, (c) => ESCAPES[c]);
}

/**
 * The plist for the paths given. Pure: tests pass made-up paths.
 *
 * KeepAlive SuccessfulExit=false: a daemon that crashes is started again,
 * one that stops (`engram stop`, or another daemon already running) is not.
 * HOME is the CLI's own. launchd hands a job a bare PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin), without npm, which the ABI self-heal in
 * preflight.ts runs (`npm rebuild better-sqlite3`): the caller puts Node's
 * own directory, where npm is, first.
 */
export function generatePlist(p: PlistPaths): string {
  return render({
    node: xmlText(p.node),
    worker: xmlText(p.worker),
    log: p.log === null ? null : xmlText(p.log),
    home: xmlText(p.home),
    path: xmlText(p.path),
  });
}

/**
 * The plist with each value's text in place. Every v2 plist has this text,
 * but for the values, and for the log, which one without a log leaves out.
 */
function render(v: PlistPaths): string {
  const log =
    v.log === null
      ? ""
      : `
  <key>StandardOutPath</key>
  <string>${v.log}</string>
  <key>StandardErrorPath</key>
  <string>${v.log}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${v.node}</string>
    <string>${v.worker}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>${log}
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${v.home}</string>
    <key>PATH</key>
    <string>${v.path}</string>
    <key>${VERSION_ENV}</key>
    <string>${PLIST_VERSION}</string>
  </dict>
</dict>
</plist>`;
}

const UNESCAPES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };

let templatePatterns: RegExp[] | undefined;

/**
 * render()'s text as patterns, each value a capture: the plist with a log,
 * and the one without. A value never holds a `<` (xmlText escapes it), and
 * the log, there twice, is the same both times.
 */
function templates(): RegExp[] {
  return (templatePatterns ??= [template("\0log\0"), template(null)]);
}

function template(log: string | null): RegExp {
  const seen = new Set<string>();
  const source = render({ node: "\0node\0", worker: "\0worker\0", log, home: "\0home\0", path: "\0path\0" })
    .replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")
    .replace(/\0(\w+)\0/g, (_, name: string) => {
      if (seen.has(name)) return `\\k<${name}>`;
      seen.add(name);
      return `(?<${name}>[^<]*)`;
    });
  return new RegExp(`^${source}$`);
}

/**
 * The paths in a plist exactly as generatePlist() writes one; null for any
 * other text. Exported for tests.
 *
 * Not read as a plist in general, because no reader here could read one as
 * launchd does: launchd parses plists with libxpc's own reader, not with
 * CoreFoundation's, which plutil and the rest of macOS use, and the two
 * disagree on much of what isn't plain XML. libxpc takes a raw `&` as it
 * is, for one, where CoreFoundation refuses the file. What generatePlist()
 * writes is plain XML, which both read back as the paths it was made from.
 */
export function pathsIn(text: string): PlistPaths | null {
  let v: Record<string, string> | undefined;
  for (const pattern of templates()) {
    v = pattern.exec(text)?.groups;
    if (v) break;
  }
  if (!v) return null;
  const unescape = (s: string): string => s.replace(/&(?:amp|lt|gt);/g, (e) => UNESCAPES[e]);
  const paths: PlistPaths = {
    node: unescape(v.node),
    worker: unescape(v.worker),
    log: v.log === undefined ? null : unescape(v.log),
    home: unescape(v.home),
    path: unescape(v.path),
  };
  try {
    // Escaped just as xmlText escapes, and nothing else: not a raw `&`, not `&#38;`.
    return generatePlist(paths) === text ? paths : null;
  } catch {
    return null; // a value xmlText refuses
  }
}

/** The version a plist says it is; 1 for one from before the stamp. */
function stampIn(text: string): number {
  const m = new RegExp(`<key>${VERSION_ENV}</key>\\s*<string>([0-9]+)</string>`).exec(text);
  return m ? Number(m[1]) : 1;
}

/**
 * launchd won't load an agent that others can write, or that someone other
 * than the user or root owns. Unknowable without POSIX owners (Windows, in
 * tests). Exported for tests.
 */
export function refusedByLaunchd(st: Pick<Stats, "mode" | "uid">): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  return (st.mode & 0o022) !== 0 || (st.uid !== uid && st.uid !== 0);
}

export type PlistState =
  | { kind: "none" }
  | {
      kind: "ours";
      /**
       * launchd may not start the daemon from it: it won't load it (others
       * can write it), it isn't as this CLI writes one of its version, the
       * Node or the worker it names is gone (Node switched or removed, the
       * CLI moved), or the log it names can't be written (engram#679).
       */
      broken: boolean;
      /** Its version; 1 for a plist from before the stamp. */
      version: number;
      /**
       * An older CLI wrote it: an older version, or one that names Node or
       * the worker in a Homebrew version, which the next `brew upgrade`
       * removes (engram#652). Or it names no log, and the log can be
       * written again (engram#679). `engram start` and auto-capture rewrite
       * it.
       */
      outdated: boolean;
    };

/**
 * The plist at plistPath(). The label is Engram's, so whatever is there is
 * ours to repair.
 */
export function readPlist(): PlistState {
  let st: Stats;
  let text: string;
  try {
    st = statSync(plistPath());
    // A byte order mark is dropped: launchd reads past one, so the plist
    // after it is the one launchd loads.
    text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(plistPath()));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "none" };
    // Unreadable, or not UTF-8 as every plist of ours is.
    return { kind: "ours", broken: true, version: 1, outdated: true };
  }
  const version = stampIn(text);
  let broken = refusedByLaunchd(st);
  let outdated = version < PLIST_VERSION;
  // An older version's is rewritten anyway, by `engram start`, and a newer
  // one's is a later CLI's to judge, not this one's.
  if (version === PLIST_VERSION) {
    const paths = pathsIn(text);
    broken ||=
      paths === null ||
      !existsSync(paths.node) ||
      !existsSync(paths.worker) ||
      // launchd would never start the job (engram#679).
      (paths.log !== null && logProblem(paths.log) !== null);
    outdated =
      paths !== null &&
      (pinnedToKeg(paths.node) || pinnedToKeg(paths.worker) || (paths.log === null && logProblem() === null));
  }
  return { kind: "ours", broken, version, outdated };
}

/**
 * Write the plist in one step: a temporary file beside it, renamed over it,
 * so launchd never reads half of one. 0644: launchd won't load an agent that
 * others can write. A link in its place is replaced, not written through.
 */
export function writePlistFile(text: string): void {
  mkdirSync(plistDir(), { recursive: true });
  const temp = join(plistDir(), `.${PLIST_LABEL}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, plistPath());
  } catch (err: unknown) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** launchctl, from an absolute directory on PATH; null when there is none. */
export function launchctlPath(): string | null {
  return commandPath("launchctl");
}

/** Arguments, never a shell command line: a path is only ever one argument. */
function launchctl(args: string[]): string {
  const file = launchctlPath();
  if (file === null) throw new Error("launchctl isn't on PATH");
  return execFileSync(file, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: LAUNCHCTL_TIMEOUT_MS,
  });
}

/**
 * The job in launchd's system domain, where it runs as root (engram#680).
 * `launchctl load` run as root loads a plist there, wherever the plist is:
 * `sudo engram install` did, and `sudo engram start` reloading a stale
 * plist, before engram#653.
 */
export const SYSTEM_JOB = `system/${PLIST_LABEL}`;

/** How to unload SYSTEM_JOB, which stops the daemon it runs. */
export const SYSTEM_JOB_UNLOAD = `sudo launchctl bootout ${SYSTEM_JOB}`;

/** Engram's job in launchd's system domain: `pid`, the daemon it runs, null when none runs. */
export interface SystemJob {
  pid: number | null;
}

/**
 * The system-domain job in `launchctl print` output, when it was loaded
 * from `plist`: this user's own plist, so its daemon runs in their
 * ~/.engram. A job loaded from anywhere else isn't this user's. The job's
 * own keys are indented by one tab; what is nested in them, by more.
 * Pure: the tests pass made-up output.
 */
export function parseSystemJob(output: string, plist: string): SystemJob | null {
  const path = /^\tpath = (.*)$/m.exec(output)?.[1];
  if (path !== plist) return null;
  const pid = /^\tpid = (\d+)$/m.exec(output)?.[1];
  return { pid: pid === undefined ? null : Number(pid) };
}

/**
 * Engram's job in launchd's system domain, loaded from this user's plist;
 * null when there is none, or it can't be told. `launchctl print` needs no
 * root to look. macOS only.
 */
export function systemJob(): SystemJob | null {
  if (process.platform !== "darwin") return null;
  try {
    return parseSystemJob(launchctl(["print", SYSTEM_JOB]), plistPath());
  } catch {
    return null; // none loaded (launchctl exits 113), or launchctl failed
  }
}

/** The user's login session, where agents run. */
function guiDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/** The PID of the daemon launchd runs for the agent; null when there is none. */
export function agentPid(): number | null {
  let output: string;
  try {
    output = launchctl(["list", PLIST_LABEL]);
  } catch {
    return null; // not loaded
  }
  const match = /"PID"\s*=\s*(\d+)/.exec(output);
  if (match) return parseInt(match[1], 10);
  // Also check the tabular format: PID\tStatus\tLabel
  for (const line of output.trim().split("\n")) {
    const pid = parseInt(line.split("\t")[0], 10);
    if (!isNaN(pid) && pid > 0) return pid;
  }
  return null;
}

/** launchd has the job loaded: it is in the user's session now. */
export function agentLoaded(): boolean {
  try {
    launchctl(["list", PLIST_LABEL]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `launchctl print-disabled` output has the job switched off: true
 * for `"<label>" => disabled` (`=> true` on older macOS), false for enabled,
 * or for a job it doesn't list, which launchd was never told to switch off.
 * null when it can't tell: no "disabled services" list, or a value it
 * doesn't know for the job. Only the label itself counts, never one that
 * starts with it.
 * Exported for tests.
 */
export function disabledIn(output: string, label = PLIST_LABEL): boolean | null {
  let listed = false;
  let inList = false;
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (text === "disabled services = {") {
      listed = inList = true;
      continue;
    }
    if (text === "}") {
      inList = false;
      continue;
    }
    if (!inList) continue;
    const entry = /^"(.*)"\s*=>\s*(.*)$/.exec(text);
    if (entry === null || entry[1] !== label) continue;
    if (entry[2] === "disabled" || entry[2] === "true") return true;
    if (entry[2] === "enabled" || entry[2] === "false") return false;
    return null;
  }
  return listed ? false : null;
}

/**
 * launchd has the job switched off: with `launchctl disable`, or `unload -w`.
 * It then loads it at no login, and won't bootstrap it, until it is switched
 * back on, and it remembers that after the plist is gone (engram#654). null
 * when launchctl couldn't say.
 */
export function agentDisabled(): boolean | null {
  try {
    return disabledIn(launchctl(["print-disabled", guiDomain()]));
  } catch {
    return null;
  }
}

/**
 * Switch the job back on in launchd, for `engram install` only: the user
 * asking for start at login (engram#654). Whether launchd took it.
 */
export function enableAgent(): boolean {
  try {
    launchctl(["enable", `${guiDomain()}/${PLIST_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Load the agent: launchd starts the daemon now and at every login. bootstrap
 * where macOS has it; `load` where that fails, as on older ones. Neither
 * loads a job the user switched off. `turnOn`: `load -w`, which switches it
 * back on too: for `engram install` only, never a repair or auto-capture
 * (engram#654). The error when it couldn't.
 */
export function loadAgent({ turnOn = false }: { turnOn?: boolean } = {}): string | null {
  try {
    launchctl(["bootstrap", guiDomain(), plistPath()]);
    return null;
  } catch {
    // older macOS, or switched off
  }
  try {
    launchctl(turnOn ? ["load", "-w", plistPath()] : ["load", plistPath()]);
    return null;
  } catch (err: unknown) {
    return commandFailure(err);
  }
}

/**
 * Have launchd start the daemon now: `launchctl kickstart`, which runs the
 * job whatever its launch conditions, as after `engram stop`, whose exit 0
 * KeepAlive doesn't restart (engram#641). launchd starts the daemon again
 * after a crash then, as it does the one it starts at login. A job that
 * runs already is left running: never `-k`, which would kill it first. The
 * error when launchd wouldn't.
 */
export function kickstartAgent(): string | null {
  try {
    launchctl(["kickstart", `${guiDomain()}/${PLIST_LABEL}`]);
    return null;
  } catch (err: unknown) {
    return commandFailure(err);
  }
}

/** Unload the agent, which stops a daemon launchd runs for it. Quiet when it isn't loaded. */
export function unloadAgent(): void {
  try {
    launchctl(["bootout", `${guiDomain()}/${PLIST_LABEL}`]);
    return;
  } catch {
    // not loaded, or older macOS
  }
  try {
    launchctl(["unload", plistPath()]);
  } catch {
    // not loaded
  }
}

/**
 * Load the plist as it is now. launchd keeps the job it loaded, whatever the
 * file says since, until the job is unloaded; and it can still be letting go
 * of one when bootout returns, when a bootstrap straight after fails.
 * `turnOn`: as for loadAgent. The error when it couldn't load it.
 */
export function reloadAgent({ turnOn = false }: { turnOn?: boolean } = {}): string | null {
  unloadAgent();
  const deadline = Date.now() + UNLOAD_WAIT_MS;
  while (agentLoaded() && Date.now() < deadline) sleepSync(100);
  return loadAgent({ turnOn });
}
