import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { commandFailure, commandPath } from "./command-path.js";
import { pinnedToKeg } from "./homebrew.js";

// Start at login on Linux (engram#615): a systemd user unit,
// ~/.config/systemd/user/engram.service. `systemctl --user enable` links it
// into default.target, so the user's service manager starts the daemon when
// they log in, and starts it again after a crash, as launchd does on macOS.
// Without a systemd user session (WSL without systemd, most containers)
// there is no start at login, and the CLI says so.

export const UNIT_NAME = "engram.service";

// Bump when generateUnit() changes in a way installed units must pick up:
// `engram start` rewrites an enabled unit older than this. A unit is written
// once, at install, and a CLI upgrade alone never touches it (engram#469).
export const UNIT_VERSION = 1;

/** What marks a unit as one Engram wrote, and which version of it. */
const VERSION_ENV = "ENGRAM_UNIT_VERSION";

/** Each systemctl call; one that hangs counts as one that failed. */
const SYSTEMCTL_TIMEOUT_MS = 15_000;

/** Where systemd reads a user's own units: $XDG_CONFIG_HOME/systemd/user. */
export function unitDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".config"), "systemd", "user");
}

export function unitPath(): string {
  return join(unitDir(), UNIT_NAME);
}

/** The link `systemctl --user enable` makes: while it is there, the unit starts at login. */
export function wantsPath(): string {
  return join(unitDir(), "default.target.wants", UNIT_NAME);
}

export interface UnitPaths {
  /** Node, through any links. */
  node: string;
  /** This build's dist/daemon/worker.js. */
  worker: string;
  /** ~/.engram/daemon.log */
  log: string;
  /** ~/.engram */
  engramDir: string;
  home: string;
  /** The PATH the daemon runs with. */
  path: string;
}

/** No unit setting can hold a control character, a newline least of all. */
function checkValue(s: string): string {
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error(`a path with a control character in it: ${JSON.stringify(s)}`);
  return s;
}

/**
 * One word of ExecStart=, as systemd reads it back: quoted, with `\` and `"`
 * escaped, `%` doubled (systemd's specifiers) and `$` doubled (its
 * environment variables). Exported for tests.
 */
export function execWord(s: string): string {
  return `"${checkValue(s).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;
}

/** One Environment= assignment: there `$` is plain, but `%` is a specifier. */
function envAssignment(name: string, value: string): string {
  return `"${name}=${checkValue(value).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
}

/**
 * The shell ExecStart runs the worker through, its paths as arguments, never
 * part of the script: $1 Node, $2 the worker, $3 the log, $4 ~/.engram.
 *
 * Through a shell so that the worker writes to daemon.log, as it does when
 * `engram start` starts it, and so that a log that isn't there yet is
 * created 0600 in a 0700 ~/.engram (engram#627): StandardOutput=append:
 * would create it with the service's umask, 0644 by default. The umask is set
 * in a subshell, not with UMask=, so that an `npm rebuild` by the worker's
 * preflight keeps the usual one (worker-main sets 0077 after it). `exec`
 * keeps the worker the service's main process, the one systemd watches.
 * `$$` is systemd's escape for `$`.
 */
const START_SCRIPT = `( umask 077; mkdir -p -- "$$4" && : >>"$$3" ) 2>/dev/null; exec "$$1" "$$2" >>"$$3" 2>&1`;

/**
 * The unit for the paths given. Pure: tests pass made-up paths.
 *
 * Restart=on-failure, as launchd's KeepAlive SuccessfulExit=false: a daemon
 * that crashes is started again, one that stops (`engram stop`, or another
 * daemon already running) is not. The start limit stops one that can't start
 * at all from being started forever. HOME is the CLI's own, which can differ
 * from the one the service manager has; PATH puts Node's directory first,
 * so the preflight's `npm rebuild` finds the npm beside it.
 */
export function generateUnit(p: UnitPaths): string {
  const exec = ["/bin/sh", "-c", `'${START_SCRIPT}'`, "engram", ...[p.node, p.worker, p.log, p.engramDir].map(execWord)];
  return `# Engram: starts the capture daemon when you log in.
# Written by 'engram install'; 'engram uninstall' removes it. The CLI may
# rewrite this file: for changes of your own, use 'systemctl --user edit engram'.
[Unit]
Description=Engram capture daemon
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${exec.join(" ")}
Restart=on-failure
RestartSec=10
Environment=${envAssignment("HOME", p.home)}
Environment=${envAssignment("PATH", p.path)}
Environment=${VERSION_ENV}=${UNIT_VERSION}

[Install]
WantedBy=default.target
`;
}

/**
 * The words of an ExecStart= value as systemd reads the ones generateUnit
 * writes: quoted or bare, `\` escapes, then `%%` and `$$`. Null for anything
 * else, which a unit of ours never has. Exported for tests.
 */
export function execWords(value: string): string[] | null {
  const words: string[] = [];
  let i = 0;
  while (i < value.length) {
    if (value[i] === " " || value[i] === "\t") {
      i++;
      continue;
    }
    const quote = value[i] === '"' || value[i] === "'" ? value[i] : null;
    if (quote) i++;
    let raw = "";
    for (;;) {
      if (i >= value.length) {
        if (quote) return null; // never closed
        break;
      }
      const c = value[i];
      if (quote ? c === quote : c === " " || c === "\t") break;
      if (c === "\\") {
        const next = value[i + 1];
        if (next !== "\\" && next !== '"' && next !== "'") return null;
        raw += next;
        i += 2;
        continue;
      }
      raw += c;
      i++;
    }
    if (quote) {
      i++; // the closing quote, which ends the word
      if (i < value.length && value[i] !== " " && value[i] !== "\t") return null;
    }
    const word = unescapeWord(raw);
    if (word === null) return null;
    words.push(word);
  }
  return words;
}

function unescapeWord(raw: string): string | null {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "%" || c === "$") {
      if (raw[i + 1] !== c) return null; // a specifier or a variable: not ours
      i++;
    }
    out += c;
  }
  return out;
}

export type UnitState =
  | { kind: "none" }
  /** A file or link Engram didn't write, or one it can't read: never touched. */
  | { kind: "foreign" }
  | {
      kind: "ours";
      /** Linked into default.target: it starts at login. */
      enabled: boolean;
      /** The Node or the worker it starts is gone, or it can't be read. */
      broken: boolean;
      version: number;
      /**
       * An older CLI wrote it: an older version, or one that starts Node or
       * the worker in a Homebrew version, which the next `brew upgrade`
       * removes (engram#652). `engram start` and auto-capture rewrite it.
       */
      outdated: boolean;
    };

/** The unit at unitPath(), as far as the CLI is concerned. */
export function readUnit(): UnitState {
  let text: string;
  try {
    if (!lstatSync(unitPath()).isFile()) return { kind: "foreign" };
    text = readFileSync(unitPath(), "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "none" } : { kind: "foreign" };
  }
  const stamp = new RegExp(`^Environment=${VERSION_ENV}=(\\d+)[ \\t]*$`, "m").exec(text);
  if (!stamp) return { kind: "foreign" };
  const version = Number(stamp[1]);
  const programs = programsIn(text);
  return {
    kind: "ours",
    enabled: linkThere(wantsPath()),
    // Either program is gone (Node moved, the CLI uninstalled).
    broken: programs === null || !existsSync(programs.node) || !existsSync(programs.worker),
    version,
    // A newer version's is a later CLI's to judge, as with the plist.
    outdated:
      version < UNIT_VERSION ||
      (version === UNIT_VERSION &&
        programs !== null &&
        (pinnedToKeg(programs.node) || pinnedToKeg(programs.worker))),
  };
}

function linkThere(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The Node and the worker ExecStart starts; null when it isn't as generateUnit writes it. */
function programsIn(text: string): { node: string; worker: string } | null {
  const line = /^ExecStart=(.*)$/m.exec(text);
  const words = line ? execWords(line[1]) : null;
  if (!words || words.length < 6 || words[0] !== "/bin/sh" || words[1] !== "-c") return null;
  return { node: words[4], worker: words[5] };
}

/**
 * Write the unit in one step: a temporary file beside it, renamed over it,
 * so systemd never reads half of one. 0644, as systemd expects of a unit (it
 * warns about one that others can't read). The rename replaces a link
 * rather than writing through it, though callers never let it get that far.
 */
function writeUnitFile(text: string): void {
  mkdirSync(unitDir(), { recursive: true });
  const temp = join(unitDir(), `.${UNIT_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, unitPath());
  } catch (err: unknown) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/**
 * systemctl, from an absolute directory on PATH: never one that PATH's
 * relative entries would find in the working directory. Null when there is
 * none.
 */
export function systemctlPath(): string | null {
  return commandPath("systemctl");
}

function systemctl(file: string, args: string[]): string {
  return execFileSync(file, ["--user", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SYSTEMCTL_TIMEOUT_MS,
  });
}

/** A user service manager answers: there is a systemd user session to start the daemon in. */
export function systemdReachable(file: string): boolean {
  try {
    systemctl(file, ["show", "--property=Version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write the unit and enable it: the service manager starts the daemon from
 * the next login on. Null when it worked; else what went wrong, and a unit
 * this wrote fresh is gone again, so a failed install leaves nothing behind.
 * Callers have checked that any unit there is ours.
 */
export function installUnit(file: string, text: string): string | null {
  const fresh = readUnit().kind === "none";
  try {
    writeUnitFile(text);
    systemctl(file, ["daemon-reload"]);
    systemctl(file, ["enable", UNIT_NAME]);
    return null;
  } catch (err: unknown) {
    if (fresh) {
      rmSync(unitPath(), { force: true });
      reload(file);
    }
    return commandFailure(err);
  }
}

/** Rewrite a unit of ours in place, leaving it enabled or not, as it was. False when it couldn't. */
export function rewriteUnit(text: string): boolean {
  try {
    writeUnitFile(text);
  } catch {
    return false;
  }
  const file = systemctlPath();
  if (file) reload(file); // otherwise the manager reads it when it next starts
  return true;
}

/**
 * Disable the unit and remove it. A daemon it started keeps running. The
 * link and the file go even when no service manager answers. Throws when
 * they can't be removed.
 */
export function removeUnit(): void {
  const file = systemctlPath();
  if (file) {
    try {
      systemctl(file, ["disable", UNIT_NAME]);
    } catch {
      // removed below
    }
  }
  rmSync(wantsPath(), { force: true });
  rmSync(unitPath(), { force: true });
  if (file) reload(file);
}

function reload(file: string): void {
  try {
    systemctl(file, ["daemon-reload"]);
  } catch {
    // the manager reads the change when it next starts
  }
}
