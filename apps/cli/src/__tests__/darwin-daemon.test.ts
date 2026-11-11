import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi, type Mock } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import type { DaemonOutput, Probe } from "../daemon/instance.js";
import type { LaunchAgentsCheck, PlistPaths } from "../daemon/launchd.js";

/**
 * engram#616 — start at login on macOS: the launchd agent,
 * ~/Library/LaunchAgents/app.getengram.daemon.plist.
 *
 * These run the macOS code paths on any OS: process.platform is switched to
 * darwin, launchctl is a fake that loads and unloads the agent as launchd
 * does, the home directory is a temp dir, and nothing reaches the real
 * launchd, ~/Library/LaunchAgents or ~/.engram. On a Mac, plutil reads the
 * plists back too (read-only, temp files).
 */

const { home, cli, daemon, launchd, spawn, execSync, execFileSync } = vi.hoisted(() => ({
  home: { dir: "" },
  // This build's worker, when it isn't the one in the test's home: a CLI
  // installed with brew runs from a versioned keg (engram#652).
  cli: { worker: null as string | null },
  // What answers on the daemon's socket: a daemon, or nothing, and where it
  // says its output goes (engram#720). `silent`: something holds it and
  // doesn't answer, as a daemon busy starting does. `unavailable`: no
  // socket can be used, so the PID file is all there is.
  daemon: {
    answering: null as {
      pid: number;
      ready?: boolean;
      stopping?: boolean;
      version?: string;
      output?: DaemonOutput;
    } | null,
    silent: false,
    unavailable: false,
  },
  // The fake launchd: the job it has loaded, and what it refuses.
  launchd: {
    loaded: false,
    /** The daemon launchd runs for the job, when it runs one. */
    pid: null as number | null,
    /** The plist as it was when launchd loaded it: launchd keeps that one. */
    loadedText: null as string | null,
    /** What `list` prints instead, when set. */
    listOutput: null as string | null,
    /**
     * Whether ~/.engram/daemon.log was there when launchd last loaded the
     * job: launchd opens it for the job, and makes a missing one 0644
     * (engram#627).
     */
    logAtLoad: null as boolean | null,
    bootstrapFails: false,
    loadFails: false,
    bootoutFails: false,
    /** How many `list` calls after a bootout still find the job, while launchd lets go of it. */
    stillLoadedFor: 0,
    lingering: 0,
    /**
     * launchd's switch for the job, which it keeps with the plist gone
     * (engram#654): `launchctl disable` (or `unload -w`) switches it off,
     * `enable` (or `load -w`) on. null: neither ever, so print-disabled
     * doesn't list it. A job switched off stays loaded until it is unloaded,
     * but launchd loads it no more.
     */
    switchedOff: null as boolean | null,
    /** What `print-disabled` prints instead, when set. */
    disabledOutput: null as string | null,
    printDisabledFails: false,
    enableFails: false,
    /**
     * What the daemon launchd starts for `kickstart` does (engram#641): it
     * answers, ready; it exits as it starts, with launchd still naming its
     * PID; or launchd starts none.
     */
    kickstarts: "ready" as "ready" | "dies" | "never",
    kickstartFails: false,
    /**
     * The daemon launchd started has exited: launchd names its PID until a
     * moment later, here until the next look at the socket.
     */
    reaping: false,
    /**
     * Engram's job in launchd's system domain, where `sudo engram install`
     * loaded it before engram#653 (engram#680): the plist it was loaded
     * from, and the daemon it runs as root, if any. null: none there.
     */
    system: null as { plist: string; pid: number | null } | null,
    /** Daemons running as root, which ps lists and the user can't signal (engram#680). */
    rootWorkers: [] as number[],
    /**
     * Who owns ~/Library/LaunchAgents, as Engram sees it, when a test says
     * (engram#678): no test can give a folder to root. null: whoever does.
     */
    agentsOwner: null as number | null,
    /**
     * The error code writing the plist fails with, when a test says: EPERM,
     * as macOS gives for a folder made immutable, which no test can make
     * here. null: none.
     */
    writeFails: null as string | null,
    /** Calls the fake didn't expect; each fails the test. */
    unexpected: [] as string[],
  },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  execSync,
  execFileSync,
  execFile: vi.fn(),
}));
vi.mock("../config.js", () => {
  const loadConfigStrict = vi.fn(async () => ({}));
  return {
    loadConfigStrict,
    saveConfig: vi.fn(async () => {}),
    resolveBaseUrl: () => "https://engram.invalid",
  };
});
// An install has dist/daemon/worker.js beside launch.js; under vitest the
// module beside launch.ts is worker.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    workerPath: () => cli.worker ?? path.join(home.dir, "cli", "dist", "daemon", "worker.js"),
  };
});
// The probe answers from `daemon.answering`; the rest is the real module.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    if (launchd.reaping) {
      launchd.reaping = false;
      launchd.pid = null;
    }
    if (daemon.silent) return { state: "silent" };
    if (daemon.unavailable) return { state: "unavailable", reason: "no socket here" };
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});
// Who owns ~/Library/LaunchAgents is `launchd.agentsOwner`, and the
// plist's write fails with `launchd.writeFails`, when a test sets them; the
// rest is the real module (engram#678).
vi.mock("../daemon/launchd.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/launchd.js")>();
  const launchAgentsNotYours = (check: LaunchAgentsCheck = {}) =>
    real.launchAgentsNotYours({
      ...(launchd.agentsOwner === null ? {} : { ownerOf: () => launchd.agentsOwner }),
      ...check,
    });
  const writePlistFile = (text: string): void => {
    if (launchd.writeFails !== null) {
      throw Object.assign(new Error(`${launchd.writeFails}: operation not permitted`), { code: launchd.writeFails });
    }
    real.writePlistFile(text);
  };
  return { ...real, launchAgentsNotYours, writePlistFile };
});

/** The OS this runs on: the tests say darwin, whatever it is. */
const HOST = process.platform;
const posixIt = HOST === "win32" ? it.skip : it;
/** For a test of file permissions, which root and Windows don't keep to. */
const permissionsIt = HOST === "win32" || process.getuid?.() === 0 ? it.skip : it;
/** For a test that asks macOS itself. */
const macIt = HOST === "darwin" ? it : it.skip;

home.dir = mkdtempSync(join(tmpdir(), "engram-616-"));
const AGENTS = join(home.dir, "Library", "LaunchAgents");
const PLIST = join(AGENTS, "app.getengram.daemon.plist");
const BIN = join(home.dir, "bin");
const NO_BIN = join(home.dir, "no-bin");
const LAUNCHCTL = join(BIN, "launchctl");
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const LABEL = "app.getengram.daemon";
/** A PID fakeKill finds no process for. */
const DEAD_PID = 999_999;
/** The user's login session, as launchd.ts names it. */
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
mkdirSync(dirname(WORKER), { recursive: true });
mkdirSync(BIN);
mkdirSync(NO_BIN);
// Never run: execFileSync is the fake below. It is there to be found on PATH.
writeFileSync(LAUNCHCTL, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

const { LOG_FILE, logProblem } = await import("../daemon/launch.js");
const { loadConfigStrict, saveConfig } = await import("../config.js");
const {
  autoEnableCapture,
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  repairLaunchdIfStale,
  waitForAgent,
} = await import("../daemon/commands.js");
const {
  PLIST_VERSION,
  agentDisabled,
  agentPid,
  disabledIn,
  generatePlist,
  launchAgentsNotYours,
  launchctlPath,
  pathsIn,
  plistPath,
  readPlist,
  refusedByLaunchd,
  reloadAgent,
  writePlistFile,
  xmlText,
} = await import("../daemon/launchd.js");
const { commandFailure } = await import("../daemon/command-path.js");
const { throughOptLink } = await import("../daemon/homebrew.js");

/** Node as start at login names it: through Homebrew's opt link, when it runs from a keg (engram#652). */
const NODE = throughOptLink(realpathSync.native(process.execPath));
/** The plist's paths for this CLI, as `engram install` writes them. */
const THIS_CLI: PlistPaths = {
  node: NODE,
  worker: WORKER,
  log: LOG_FILE,
  home: home.dir,
  path: `${dirname(NODE)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
};

/** The stamp a plist says its version with. */
function stamp(version: number): string {
  return `<key>ENGRAM_PLIST_VERSION</key>\n    <string>${version}</string>`;
}

/** A plist of ours, for these paths and this version. */
function plistWith(paths: Partial<PlistPaths> = {}, version = PLIST_VERSION): string {
  // A function, so that a `$` in a path is put back as it is.
  return generatePlist({ ...THIS_CLI, ...paths }).replace(stamp(PLIST_VERSION), () => stamp(version));
}

/** A plist as CLIs before v2 wrote one: no PATH, no stamp. */
function asV1(text: string): string {
  const v1 = text.replace(
    /\n    <key>PATH<\/key>\n    <string>[^<]*<\/string>\n    <key>ENGRAM_PLIST_VERSION<\/key>\n    <string>\d+<\/string>/,
    () => "",
  );
  if (v1 === text) throw new Error("not a plist of ours");
  return v1;
}

/** The plist CLIs before v2 wrote for this one: the worker-main.js entry point (engram#469). */
function v1Plist(): string {
  return asV1(plistWith({ worker: join(dirname(WORKER), "worker-main.js") }));
}

/** Put `text` where the plist goes, as a file with this mode. */
function writePlist(text: string | Uint8Array, mode = 0o644): void {
  mkdirSync(dirname(plistPath()), { recursive: true });
  rmSync(plistPath(), { recursive: true, force: true });
  writeFileSync(plistPath(), text);
  chmodSync(plistPath(), mode);
}

/** The daemon's log, the user's own, made read-only: it can't be written (engram#679). */
function unwritableLog(): void {
  mkdirSync(ENGRAM_DIR, { recursive: true });
  rmSync(LOG_FILE, { force: true });
  writeFileSync(LOG_FILE, "");
  chmodSync(LOG_FILE, 0o400);
}

/** What `engram start` and `engram status` say puts the log back, while a daemon runs without it (engram#679). */
const RESTART = "  Once it can be written, 'engram stop' and then 'engram start' have the daemon write to it again.";

/**
 * A home named `name`, inside the test's own, with this build's worker in it.
 * Gives back what puts the home back.
 */
function homeNamed(name: string): () => void {
  const dir = home.dir;
  home.dir = join(dir, name);
  rmSync(home.dir, { recursive: true, force: true });
  const worker = join(home.dir, "cli", "dist", "daemon", "worker.js");
  mkdirSync(dirname(worker), { recursive: true });
  writeFileSync(worker, "");
  return () => {
    home.dir = dir;
  };
}

function failed(command: string, stderr: string): Error {
  return Object.assign(new Error(`Command failed: ${command}`), { status: 1, stderr });
}

/** What `launchctl list <label>` prints for a job launchd has. */
function listing(): string {
  return (
    "{\n" +
    '\t"LimitLoadToSessionType" = "Aqua";\n' +
    `\t"Label" = "${LABEL}";\n` +
    '\t"OnDemand" = false;\n' +
    '\t"LastExitStatus" = 0;\n' +
    (launchd.pid === null ? "" : `\t"PID" = ${launchd.pid};\n`) +
    "};\n"
  );
}

/**
 * What `launchctl print-disabled gui/<uid>` prints: each job launchd has a
 * switch for. Another job's, and one whose label starts with ours, which
 * isn't ours.
 */
function disabledListing(): string {
  const ours =
    launchd.switchedOff === null ? "" : `\t\t"${LABEL}" => ${launchd.switchedOff ? "disabled" : "enabled"}\n`;
  return `\n\tdisabled services = {\n\t\t"com.example.agent" => disabled\n${ours}\t\t"${LABEL}.helper" => disabled\n\t}\n`;
}

function load(plist: string): void {
  launchd.loaded = true;
  launchd.loadedText = readFileSync(plist, "utf-8");
  launchd.logAtLoad = existsSync(LOG_FILE);
}

function unload(): void {
  launchd.loaded = false;
  launchd.pid = null;
  launchd.lingering = launchd.stillLoadedFor;
}

const UNESCAPED: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

/** launchd starts the job's daemon, which then does what `launchd.kickstarts` says. */
function startJob(): void {
  if (launchd.kickstarts === "never") return;
  // launchd opens the job's log for it as it starts the daemon. One it
  // can't open, it never starts the daemon at all: xpcproxy exits 78
  // (EX_CONFIG), launchd tries again every 10 s, and kickstart still exits
  // 0 (engram#679).
  const log = /<key>StandardOutPath<\/key>\s*<string>([^<]*)<\/string>/.exec(launchd.loadedText ?? "");
  if (log !== null && logProblem(log[1].replace(/&(amp|lt|gt);/g, (_, e: string) => UNESCAPED[e])) !== null) return;
  if (launchd.kickstarts === "dies") {
    // No process has this PID: it has exited, and launchd names it for a moment yet.
    launchd.pid = DEAD_PID;
    launchd.reaping = true;
    return;
  }
  launchd.pid = process.pid;
  daemonRunning();
}

/** What ps says a daemon running as root runs (engram#680). */
const ROOT_WORKER_ARGS = `/usr/local/bin/node ${WORKER}`;

/** ps, as the CLI asks it: the daemons running as root, and what one process runs (engram#680). */
function fakePs(args: string[]): string {
  const command = args.join(" ");
  if (command === "-A -ww -o pid=,uid=,args=") {
    const lines = [
      "    1     0 /sbin/launchd",
      `${process.pid} ${process.getuid?.() ?? 501} node vitest`,
      ...launchd.rootWorkers.map((pid) => `${pid}     0 ${ROOT_WORKER_ARGS}`),
    ];
    return `${lines.join("\n")}\n`;
  }
  const one = /^-ww -o uid=,args= -p (\d+)$/.exec(command);
  if (one !== null) {
    if (launchd.rootWorkers.includes(Number(one[1]))) return `    0 ${ROOT_WORKER_ARGS}\n`;
    // ps exits 1 when there is no such process.
    throw failed(`ps ${command}`, "");
  }
  launchd.unexpected.push(`/bin/ps ${command}`);
  throw new Error(`unexpected ps ${command}`);
}

/** What `launchctl print system/<label>` prints for the job a sudo install loaded (engram#680). */
function systemPrint(job: { plist: string; pid: number | null }): string {
  const lines = [
    `system/${LABEL} = {`,
    `\tactive count = ${job.pid === null ? 0 : 1}`,
    `\tpath = ${job.plist}`,
    "\ttype = LaunchDaemon",
    `\tstate = ${job.pid === null ? "not running" : "running"}`,
    "",
    `\tprogram = ${NODE}`,
    "\targuments = {",
    `\t\t${NODE}`,
    `\t\t${WORKER}`,
    "\t}",
    "",
    "\tenvironment = {",
    `\t\tHOME => ${home.dir}`,
    "\t}",
    "",
    "\tdomain = system",
    "\truns = 1",
    ...(job.pid === null ? [] : [`\tpid = ${job.pid}`]),
    "\tlast exit code = (never exited)",
    "\tproperties = keepalive | runatload | inferred program",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/** Whether these are launchctl's arguments for a look at Engram's job in launchd's system domain (engram#680). */
function isSystemLook(args: readonly string[]): boolean {
  return args.length === 2 && args[0] === "print" && args[1] === `system/${LABEL}`;
}

/** launchctl, against the fake launchd above: what the real one does with it. */
function fakeLaunchctl(file: string, args: string[]): string {
  const command = args.join(" ");
  if (file === "/bin/ps") return fakePs(args);
  if (file !== LAUNCHCTL) {
    launchd.unexpected.push(`${file} ${command}`);
    throw new Error(`unexpected program ${file}`);
  }
  // Where the plist is for the home of the moment: a test can change it.
  const plist = join(home.dir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const is = (...expected: string[]) =>
    args.length === expected.length && args.every((arg, i) => arg === expected[i]);
  if (is("list", LABEL)) {
    if (launchd.loaded) return launchd.listOutput ?? listing();
    if (launchd.lingering > 0) {
      launchd.lingering--;
      return listing();
    }
    throw failed(command, `Could not find service "${LABEL}" in domain for port\n`);
  }
  if (is("bootstrap", DOMAIN, plist)) {
    if (launchd.switchedOff) throw failed(command, "Bootstrap failed: 119: Service is disabled\n");
    if (launchd.bootstrapFails || launchd.loaded || launchd.lingering > 0 || !existsSync(plist)) {
      throw failed(command, "Bootstrap failed: 5: Input/output error\n");
    }
    load(plist);
    return "";
  }
  if (is("load", "-w", plist) || is("load", plist)) {
    // -w switches the job on first, whether or not it then loads.
    if (args[1] === "-w") launchd.switchedOff = false;
    if (launchd.switchedOff) throw failed(command, "Load failed: 119: Service is disabled\n");
    if (launchd.loadFails || launchd.loaded || launchd.lingering > 0 || !existsSync(plist)) {
      throw failed(command, "Load failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.\n");
    }
    load(plist);
    return "";
  }
  if (isSystemLook(args)) {
    if (launchd.system === null) {
      throw Object.assign(failed(command, `Could not find service "${LABEL}" in domain for system\n`), { status: 113 });
    }
    return systemPrint(launchd.system);
  }
  if (is("print-disabled", DOMAIN)) {
    if (launchd.printDisabledFails) throw failed(command, "Could not find domain for port\n");
    return launchd.disabledOutput ?? disabledListing();
  }
  if (is("enable", `${DOMAIN}/${LABEL}`)) {
    if (launchd.enableFails) throw failed(command, "Could not enable service: 1: Operation not permitted\n");
    launchd.switchedOff = false;
    return "";
  }
  if (is("bootout", `${DOMAIN}/${LABEL}`)) {
    if (launchd.bootoutFails || !launchd.loaded) throw failed(command, "Boot-out failed: 3: No such process\n");
    unload();
    return "";
  }
  if (is("unload", plist)) {
    if (!launchd.loaded) throw failed(command, "Unload failed: 113: Could not find specified service\n");
    unload();
    return "";
  }
  // Only ever without -k, which would stop the daemon launchd runs first, and
  // without -p (engram#641).
  if (is("kickstart", `${DOMAIN}/${LABEL}`)) {
    const refused = `Could not kickstart service "${DOMAIN}/${LABEL}"`;
    if (launchd.switchedOff) throw failed(command, `${refused}: 119: Service is disabled\n`);
    if (launchd.kickstartFails || !launchd.loaded) {
      throw failed(command, `${refused}: 113: Could not find specified service\n`);
    }
    // A job that runs its daemon already is left as it is.
    if (launchd.pid === null) startJob();
    return "";
  }
  launchd.unexpected.push(command);
  throw new Error(`unexpected launchctl ${command}`);
}

/**
 * The fake launchctl's calls, as their arguments: launchctl's only, and
 * not the looks into launchd's system domain (engram#680), which
 * systemLooks() counts.
 */
function launchctlArgs(): string[][] {
  return execFileSync.mock.calls
    .filter(([file, args]) => file === LAUNCHCTL && !isSystemLook(args as string[]))
    .map(([, args]) => args as string[]);
}

/** The fake launchctl's calls, by their first word (see launchctlArgs). */
function launchctlCalls(): string[] {
  return launchctlArgs().map((args) => args[0]);
}

/** When launchctl was first called, but for the looks launchctlArgs leaves out. */
function firstLaunchctlOrder(): number {
  const first = execFileSync.mock.calls.findIndex(([file, args]) => file === LAUNCHCTL && !isSystemLook(args as string[]));
  if (first === -1) throw new Error("launchctl wasn't called");
  return execFileSync.mock.invocationCallOrder[first];
}

/** How many times the CLI looked into launchd's system domain (engram#680). */
function systemLooks(): number {
  return execFileSync.mock.calls.filter(([file, args]) => file === LAUNCHCTL && isSystemLook(args as string[])).length;
}

/** The fake launchctl's loads, as their arguments: never -w but for `engram install` (engram#654). */
function loads(): string[] {
  return execFileSync.mock.calls
    .map(([, args]) => (args as string[]).join(" "))
    .filter((command) => command.startsWith("load "));
}

/** A spawned worker, as far as the CLI looks at one. */
function fakeChild() {
  return Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
}

/** A worker that exits with an error as it starts, as Node does without its script. */
function failingSpawn() {
  const child = fakeChild();
  setImmediate(() => child.emit("exit", 1));
  return child;
}

/** A worker that starts and answers on the socket, ready. */
function fakeSpawn() {
  daemonRunning();
  return fakeChild();
}

/** A daemon: it answers on the socket and wrote its PID file. This process stands in for it. */
function daemonRunning(): void {
  mkdirSync(ENGRAM_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(process.pid));
  daemon.answering = { pid: process.pid };
}

/** The daemon is gone, as after a restart: nothing answers, and launchd runs none. */
function daemonGone(): void {
  daemon.answering = null;
  launchd.pid = null;
  rmSync(PID_FILE, { force: true });
}

/** Made-up processes, beside this one, that signal 0 finds alive: a daemon that is stopping. */
const madeUp = new Set<number>();
/** Timers a test set; cleared after it. */
const timers: NodeJS.Timeout[] = [];

/**
 * Signal 0 finds this process, and those made up, alive; any other signal
 * fails the test before it reaches a process.
 */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  // One running as root: alive, and the user can't signal it (engram#680).
  if (signal === 0 && launchd.rootWorkers.includes(pid)) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  if (signal === 0 && (pid === process.pid || madeUp.has(pid))) return true;
  if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
}

function output(): string {
  return [console.log as Mock, console.error as Mock]
    .flatMap((m) => m.mock.calls.map((c) => c.join(" ")))
    .join("\n");
}

/** What was said since the last call. */
function said(): string {
  const text = output();
  vi.mocked(console.log).mockClear();
  vi.mocked(console.error).mockClear();
  return text;
}

/** What `text` says of the log: its "Log:" line and the lines under it, or none (engram#720). */
function logLines(text: string): string[] {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("Log:"));
  if (at < 0) return [];
  const end = lines.findIndex((line, i) => i > at && !line.startsWith("  "));
  return lines.slice(at, end < 0 ? undefined : end);
}

/**
 * Auto-capture runs, in the describe this is called in: signed in, at a
 * terminal, without what the test run itself sets to keep auto-capture out
 * of other tests.
 */
function signedInAtATerminal(): void {
  const realIsTTY = process.stdin.isTTY;
  const config = vi.mocked(loadConfigStrict);

  beforeEach(() => {
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    config.mockResolvedValue({ apiKey: "eng_test_616" } as never);
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    config.mockReset().mockImplementation(async () => ({}) as never);
  });
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  Object.assign(launchd, {
    loaded: false,
    pid: null,
    loadedText: null,
    listOutput: null,
    logAtLoad: null,
    bootstrapFails: false,
    loadFails: false,
    bootoutFails: false,
    stillLoadedFor: 0,
    lingering: 0,
    switchedOff: null,
    disabledOutput: null,
    printDisabledFails: false,
    enableFails: false,
    kickstarts: "ready",
    kickstartFails: false,
    reaping: false,
    system: null,
    rootWorkers: [],
    agentsOwner: null,
    writeFails: null,
    unexpected: [],
  });
  daemon.answering = null;
  daemon.silent = false;
  daemon.unavailable = false;
  madeUp.clear();
  cli.worker = null;
  rmSync(join(home.dir, "Library"), { recursive: true, force: true });
  rmSync(PID_FILE, { force: true });
  rmSync(LOG_FILE, { force: true });
  writeFileSync(WORKER, "");
  vi.stubEnv("PATH", BIN);
  // What a daemon spawned from here would have and launchd's wouldn't (engram#641).
  vi.stubEnv("ENGRAM_API_KEY", undefined);
  vi.stubEnv("ENGRAM_BASE_URL", undefined);
  vi.stubEnv("ENGRAM_VAULT_KEY", undefined);
  spawn.mockReset().mockImplementation(fakeSpawn);
  execSync.mockReset();
  execFileSync.mockReset().mockImplementation(fakeLaunchctl);
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  Object.defineProperty(process, "platform", { value: HOST, configurable: true });
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  // launchctl only ever through execFileSync, never a shell command line,
  // and only the calls the fake knows.
  expect(execSync).not.toHaveBeenCalled();
  expect(launchd.unexpected).toEqual([]);
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("the tests' own home (engram#616)", () => {
  it("is a temporary one: nothing here reaches the real ~/Library/LaunchAgents, ~/.engram or launchctl", () => {
    expect(realpathSync(dirname(home.dir))).toBe(realpathSync(tmpdir()));
    expect(plistPath()).toBe(PLIST);
    expect(LOG_FILE).toBe(join(ENGRAM_DIR, "daemon.log"));
    expect(launchctlPath()).toBe(LAUNCHCTL);
  });
});

describe("the plist (engram#616)", () => {
  const paths: PlistPaths = {
    node: "/opt/homebrew/Cellar/node/24.1.0/bin/node",
    worker: "/opt/homebrew/lib/node_modules/@getengram/cli/dist/daemon/worker.js",
    log: "/Users/op/.engram/daemon.log",
    home: "/Users/op",
    path: "/opt/homebrew/Cellar/node/24.1.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  };

  it("is what launchd is given", () => {
    expect(generatePlist(paths)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.getengram.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/Cellar/node/24.1.0/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/@getengram/cli/dist/daemon/worker.js</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/op/.engram/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/op/.engram/daemon.log</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/op</string>
    <key>PATH</key>
    <string>/opt/homebrew/Cellar/node/24.1.0/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ENGRAM_PLIST_VERSION</key>
    <string>2</string>
  </dict>
</dict>
</plist>`);
  });

  it("leaves the log out of one without a log, so launchd gives the daemon no output file (engram#679)", () => {
    const withLog = generatePlist(paths);
    const logLines = [
      "  <key>StandardOutPath</key>",
      "  <string>/Users/op/.engram/daemon.log</string>",
      "  <key>StandardErrorPath</key>",
      "  <string>/Users/op/.engram/daemon.log</string>",
      "",
    ].join("\n");
    expect(withLog).toContain(logLines);
    expect(generatePlist({ ...paths, log: null })).toBe(withLog.replace(logLines, () => ""));
  });

  it("gives every path back as it is, whatever is in it", () => {
    for (const odd of [
      "/Users/A&B",
      "/Users/a<b>c",
      `/Users/"double" 'single'`,
      "/Users/&amp;", // already looks escaped
      "/Users/&lt;x&gt;",
      "/Users/&#38;",
      "/Users/x]]>y",
      "/Users/$HOME %h",
      "/Users/Jürgen 😀",
      `/Users/${"x".repeat(1000)}`,
    ]) {
      for (const key of ["node", "worker", "log", "home", "path"] as const) {
        expect(pathsIn(generatePlist({ ...paths, [key]: odd }))).toEqual({ ...paths, [key]: odd });
      }
      // And from one without a log (engram#679).
      for (const key of ["node", "worker", "home", "path"] as const) {
        const none = { ...paths, log: null, [key]: odd };
        expect(pathsIn(generatePlist(none))).toEqual(none);
      }
    }
  });

  it("escapes &, < and >, as macOS's own plist writer does, and nothing else", () => {
    expect(xmlText(`a&b<c>d"e'f]]>`)).toBe(`a&amp;b&lt;c&gt;d"e'f]]&gt;`);
    expect(xmlText("&amp;")).toBe("&amp;amp;");
    expect(xmlText("Jürgen 😀")).toBe("Jürgen 😀");
  });

  it("refuses a path with a control character in it, or one that isn't Unicode", () => {
    for (const c of ["\x00", "\t", "\n", "\r", "\x1b", "\x7f"]) {
      const bad = `/Users/a${c}b`;
      // As JSON: never a raw control character in what is said.
      expect(() => xmlText(bad)).toThrow(`a path with a control character in it: ${JSON.stringify(bad)}`);
      for (const key of ["node", "worker", "log", "home", "path"] as const) {
        expect(() => generatePlist({ ...paths, [key]: bad })).toThrow("a path with a control character in it");
      }
    }
    for (const half of ["\ud800", "\udc00x", "\udc00\ud800"]) {
      const bad = `/Users/${half}`;
      expect(() => xmlText(bad)).toThrow(`a path that isn't valid Unicode: ${JSON.stringify(bad)}`);
    }
    expect(xmlText("/Users/😀")).toBe("/Users/😀");
  });

  it("reads back nothing it wouldn't write", () => {
    const text = generatePlist(paths);
    expect(pathsIn(text)).toEqual(paths);
    // One without a log: neither of its two keys (engram#679).
    const none = generatePlist({ ...paths, log: null });
    expect(pathsIn(none)).toEqual({ ...paths, log: null });
    const amp = generatePlist({ ...paths, home: "/Users/A&B" });
    for (const other of [
      amp.replace("&amp;", () => "&"), // raw, as CLIs before engram#616 wrote it
      amp.replace("&amp;", () => "&#38;"),
      generatePlist({ ...paths, home: `/Users/A"B` }).replace(`A"B`, () => "A&quot;B"),
      text.replace(`<string>${LABEL}</string>`, () => "<string>app.getengram.other</string>"),
      text.replace("<string>/Users/op</string>", () => "<string>/Users/o\tp</string>"), // xmlText refuses a tab
      `${text}\n`,
      text.replace(/\n/g, () => "\r\n"),
      `﻿${text}`,
      text.replace(/(<key>StandardErrorPath<\/key>\n {2}<string>)[^<]*/, (_, key: string) => `${key}/tmp/other.log`),
      asV1(text),
      text.replace(stamp(PLIST_VERSION), () => stamp(PLIST_VERSION + 1)),
      // Only one of the log's two keys (engram#679).
      text.replace(/\n {2}<key>StandardErrorPath<\/key>\n {2}<string>[^<]*<\/string>/, () => ""),
      text.replace(/\n {2}<key>StandardOutPath<\/key>\n {2}<string>[^<]*<\/string>/, () => ""),
      none.replace(stamp(PLIST_VERSION), () => stamp(PLIST_VERSION + 1)),
      text.replace("  <key>ThrottleInterval</key>", () => "  <key>Nice</key>\n  <integer>1</integer>\n  <key>ThrottleInterval</key>"),
    ]) {
      expect(other).not.toBe(text);
      expect(pathsIn(other)).toBeNull();
    }
  });

  it("is put in place whole or not at all, and a write that fails leaves nothing behind", () => {
    // A directory in its place, which a file can't be renamed over.
    mkdirSync(join(PLIST, "x"), { recursive: true });
    expect(() => writePlistFile(plistWith())).toThrow();
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    expect(statSync(PLIST).isDirectory()).toBe(true);
  });
});

describe("reading the plist (engram#616)", () => {
  it("finds none where there is none", () => {
    expect(readPlist()).toEqual({ kind: "none" });
    // ~/Library/LaunchAgents a file, not a directory.
    mkdirSync(join(home.dir, "Library"), { recursive: true });
    writeFileSync(AGENTS, "");
    expect(readPlist()).toEqual({ kind: "none" });
  });

  it("finds a current one", () => {
    writePlist(plistWith());
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  it("finds one whose Node or worker is gone broken", () => {
    for (const gone of [{ node: join(home.dir, "gone", "node") }, { worker: join(home.dir, "gone", "worker.js") }]) {
      writePlist(plistWith(gone));
      expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    }
  });

  it("finds one with a raw < in it broken, as CLIs before engram#616 wrote one: launchd can't load it", () => {
    writePlist(plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
  });

  it("finds one that isn't UTF-8, or isn't a file, broken", () => {
    writePlist(Buffer.concat([Buffer.from(plistWith()), Buffer.from([0xff])]));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
    rmSync(PLIST);
    mkdirSync(PLIST);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  permissionsIt("finds one others can write broken: launchd won't load it", () => {
    for (const mode of [0o664, 0o646]) {
      writePlist(plistWith(), mode);
      expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    }
    writePlist(v1Plist(), 0o664);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  permissionsIt("finds one it can't read broken", () => {
    writePlist(plistWith(), 0o000);
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: 1, outdated: true });
  });

  it("reads past a byte order mark, as launchd does", () => {
    writePlist(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plistWith())]));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  posixIt("knows which launchd won't load: one others can write, or one someone else owns, unless root", () => {
    vi.spyOn(process, "getuid").mockReturnValue(501);
    const file = (uid: number, mode: number) => ({ uid, mode: 0o100000 | mode });
    expect(refusedByLaunchd(file(501, 0o644))).toBe(false);
    expect(refusedByLaunchd(file(501, 0o600))).toBe(false);
    expect(refusedByLaunchd(file(0, 0o644))).toBe(false);
    expect(refusedByLaunchd(file(502, 0o644))).toBe(true);
    expect(refusedByLaunchd(file(501, 0o664))).toBe(true);
    expect(refusedByLaunchd(file(501, 0o646))).toBe(true);
    expect(refusedByLaunchd(file(0, 0o664))).toBe(true);
  });

  it("finds an older one outdated, not broken: start rewrites it all the same", () => {
    writePlist(v1Plist());
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: 1, outdated: true });
  });

  it("leaves a newer one to the CLI that wrote it", () => {
    writePlist(plistWith({ node: join(home.dir, "gone", "node") }, PLIST_VERSION + 1));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION + 1, outdated: false });
  });

  permissionsIt("finds one naming a log that can't be written broken: launchd never starts the daemon from it (engram#679)", () => {
    unwritableLog();
    writePlist(plistWith());
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    // The one this CLI writes then, without a log, is current.
    writePlist(plistWith({ log: null }));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    // As is one naming the log, once it can be written.
    chmodSync(LOG_FILE, 0o600);
    writePlist(plistWith());
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  it("finds one without a log outdated while the log can be written (engram#679)", () => {
    writePlist(plistWith({ log: null }));
    // Not there, in a folder that lets it be made.
    expect(existsSync(LOG_FILE)).toBe(false);
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: true });
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(LOG_FILE, "");
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: true });
  });
});

describe("launchctl (engram#616)", () => {
  it("is found on PATH", () => {
    vi.stubEnv("PATH", [NO_BIN, BIN].join(delimiter));
    expect(launchctlPath()).toBe(LAUNCHCTL);
    vi.stubEnv("PATH", NO_BIN);
    expect(launchctlPath()).toBeNull();
    vi.stubEnv("PATH", undefined);
    expect(launchctlPath()).toBeNull();
  });

  it("is never found through a relative directory on PATH", () => {
    // Relative to the working directory, this one is BIN.
    const rel = relative(process.cwd(), BIN);
    vi.stubEnv("PATH", rel);
    // Where the temp dir is on another drive, there is no relative path to it.
    expect(launchctlPath()).toBe(isAbsolute(rel) ? LAUNCHCTL : null);
  });

  posixIt("is a file that can be run", () => {
    const dir = join(home.dir, "other-bin");
    mkdirSync(join(dir, "launchctl"), { recursive: true }); // a directory
    const notRunnable = join(home.dir, "plain-bin");
    mkdirSync(notRunnable, { recursive: true });
    writeFileSync(join(notRunnable, "launchctl"), "", { mode: 0o644 });
    vi.stubEnv("PATH", [dir, notRunnable, BIN].join(delimiter));
    expect(launchctlPath()).toBe(LAUNCHCTL);
  });

  it("is given arguments, never a command line, and given up on when it hangs", async () => {
    await daemonInstall();
    expect(execFileSync).toHaveBeenCalled();
    for (const [file, args, options] of execFileSync.mock.calls) {
      expect(file).toBe(LAUNCHCTL);
      expect(Array.isArray(args)).toBe(true);
      expect(options).toMatchObject({ encoding: "utf-8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      expect(options).not.toHaveProperty("shell");
    }
  });

  it("says what went wrong in a line: the first it said, or else the first of the error", () => {
    const stderr = "\n  \nLoad failed: 5: Input/output error\nTry running `launchctl bootstrap` as root for richer errors.\n";
    expect(commandFailure(failed("launchctl load -w x.plist", stderr))).toBe("Load failed: 5: Input/output error");
    expect(commandFailure(failed("launchctl list", ""))).toBe("Command failed: launchctl list");
    expect(commandFailure(failed("launchctl list", "\n \n"))).toBe("Command failed: launchctl list");
    expect(commandFailure(new Error("spawnSync launchctl ETIMEDOUT\n    at x"))).toBe("spawnSync launchctl ETIMEDOUT");
    expect(commandFailure(failed("launchctl list", `${"x".repeat(200)}\n`))).toBe("x".repeat(200));
    expect(commandFailure(failed("launchctl list", `${"x".repeat(201)}\n`))).toBe(`${"x".repeat(199)}…`);
  });

  it("names the daemon launchd runs, either way it prints it", () => {
    launchd.loaded = true;
    launchd.pid = 4242;
    expect(agentPid()).toBe(4242);
    launchd.listOutput = `4243\t0\t${LABEL}\n`;
    expect(agentPid()).toBe(4243);
    launchd.listOutput = `-\t0\t${LABEL}\n`;
    expect(agentPid()).toBeNull();
    launchd.listOutput = null;
    launchd.pid = null;
    expect(agentPid()).toBeNull();
    launchd.loaded = false;
    expect(agentPid()).toBeNull();
    expect(launchctlCalls()).toEqual(["list", "list", "list", "list", "list"]);
  });
});

describe("engram install on macOS (engram#616)", () => {
  it("writes the plist and loads it, and launchd starts the daemon", async () => {
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    // Any job of ours unloaded first, and gone, then the new one loaded.
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
    // launchd starts it (RunAtLoad), not the CLI.
    expect(spawn).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain(`Plist: ${PLIST}`);
    expect(process.exitCode).toBeUndefined();
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  permissionsIt("writes one without a log while the log can't be written: launchd would never start the daemon (engram#679)", async () => {
    unwritableLog();
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith({ log: null }));
    expect(launchd.loadedText).toBe(plistWith({ log: null }));
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("writes it 0644 whatever the umask: launchd won't load one others can write", async () => {
    for (const mask of [0o077, 0o002]) {
      rmSync(join(home.dir, "Library"), { recursive: true, force: true });
      launchd.loaded = false;
      const umask = process.umask(mask);
      try {
        await daemonInstall();
      } finally {
        process.umask(umask);
      }
      expect(statSync(PLIST).mode & 0o777).toBe(0o644);
    }
  });

  posixIt("escapes a home with &, < and > in it, which then reads back as it is", async () => {
    const restore = homeNamed("A&B <C>");
    try {
      await daemonInstall();
      const text = readFileSync(plistPath(), "utf-8");
      expect(text).toContain("A&amp;B &lt;C&gt;");
      expect(pathsIn(text)).toMatchObject({ home: home.dir, worker: join(home.dir, "cli", "dist", "daemon", "worker.js") });
      expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
      expect(launchd.loadedText).toBe(text);
    } finally {
      restore();
    }
  });

  it("leaves a plist launchd has loaded as it is, and the daemon it runs", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = process.pid;
    daemonRunning();
    await daemonInstall();
    // Not unloaded: that would stop the daemon. Then whether launchd runs
    // the daemon that runs: it does, so nothing more is said (engram#692).
    expect(launchctlCalls()).toEqual(["print-disabled", "list", "list"]);
    const text = output();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).not.toContain("wasn't started by launchd");
  });

  it("loads one that is there but not loaded", async () => {
    writePlist(plistWith());
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "list", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled");
  });

  it("loads one that changed again, so that launchd runs the new one", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.loadedText = v1Plist();
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("loads it with load -w where bootstrap fails: older macOS, or a job switched off", async () => {
    launchd.bootstrapFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load -w ${PLIST}`]);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
  });

  it("says what launchctl said, and how to load it by hand, when it can't load it", async () => {
    launchd.bootstrapFails = true;
    launchd.loadFails = true;
    const restore = homeNamed("O'Brien Q");
    let plist = "";
    try {
      plist = plistPath();
      await daemonInstall();
      expect(pathsIn(readFileSync(plist, "utf-8"))?.home).toBe(home.dir);
    } finally {
      restore();
    }
    const text = output();
    expect(text).toContain(`Plist written to ${plist}`);
    expect(text).toContain("  launchctl: Load failed: 5: Input/output error");
    // One word for the shell, whatever is in the path.
    expect(text).toContain(`Run manually: launchctl load -w '${plist.replace(/'/g, "'\\''")}'`);
    expect(text).not.toContain("Auto-start enabled");
    expect(process.exitCode).toBeUndefined();
  });

  it("says so when launchctl isn't on PATH", async () => {
    vi.stubEnv("PATH", NO_BIN);
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(output()).toContain("  launchctl: launchctl isn't on PATH");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  posixIt("replaces a link in the plist's place, and never writes through it", async () => {
    const target = join(home.dir, "elsewhere.plist");
    writeFileSync(target, v1Plist());
    mkdirSync(AGENTS, { recursive: true });
    symlinkSync(target, PLIST);
    try {
      await daemonInstall();
      expect(lstatSync(PLIST).isFile()).toBe(true);
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(readFileSync(target, "utf-8")).toBe(v1Plist());
      expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "unload", "list", "bootstrap"]);
    } finally {
      rmSync(target, { force: true });
    }
  });

  it("fails when this build has no worker to start", async () => {
    rmSync(WORKER);
    await daemonInstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(output()).toContain(`Can't turn on start at login: ${WORKER} is missing.`);
    expect(launchctlCalls()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  posixIt("refuses a home a plist can't hold, says why, and writes nothing", async () => {
    const restore = homeNamed("new\nline");
    try {
      await daemonInstall();
    } finally {
      restore();
    }
    expect(existsSync(join(home.dir, "new\nline", "Library"))).toBe(false);
    const text = output();
    expect(text).toContain("Can't turn on start at login: a launchd job can't hold one of the paths it needs.");
    // The worker's path as JSON: never a raw control character on the terminal.
    expect(text).toContain(JSON.stringify(join(home.dir, "new\nline", "cli", "dist", "daemon", "worker.js")));
    expect(text).not.toContain("new\nline");
    expect(launchctlCalls()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  permissionsIt("says why when it can't write the plist, and leaves nothing behind", async () => {
    mkdirSync(AGENTS, { recursive: true });
    chmodSync(AGENTS, 0o555);
    try {
      await daemonInstall();
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(readdirSync(AGENTS)).toEqual([]);
    const text = output();
    expect(text).toContain("Couldn't turn on start at login.");
    expect(text).toContain("EACCES");
    expect(launchctlCalls()).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("turns start at login on with start --install while the daemon runs, and starts no other", async () => {
    daemonRunning();
    await daemonStart([], { install: "" });
    expect(spawn).not.toHaveBeenCalled();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    // Then whether launchd runs it (engram#641).
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap", "list", "list", "print-disabled"]);
    const text = output();
    expect(text).toContain("Daemon already running");
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    // The daemon launchd starts finds this one and leaves the capture to it
    // (engram#612): launchd doesn't start this one again after a crash.
    expect(text).toContain(`The running daemon (pid ${process.pid}) wasn't started by launchd, so launchd won't restart it after a crash: run 'engram stop' and then 'engram start' to fix that.`);
  });
});

describe("engram start on macOS (engram#616)", () => {
  it("updates an older plist, and has launchd load the new one in its place (engram#469)", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.loadedText = v1Plist();
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    // Then launchd starts the daemon (engram#641).
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(output()).toContain(`Updated auto-start configuration (plist v${PLIST_VERSION})`);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    expect(process.exitCode).toBeUndefined();
  });

  it("rewrites a plist launchd can't start the daemon from", async () => {
    for (const text of [
      plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"), // launchd can't load it
      plistWith({ path: "/opt/A&B/bin:/usr/bin" }).replace("&amp;", () => "&"), // nothing else can read it
      plistWith({ node: join(home.dir, "gone", "node") }),
      plistWith({ worker: join(home.dir, "gone", "worker.js") }),
      Buffer.concat([Buffer.from(plistWith()), Buffer.from([0xff])]),
      "<plist/>",
    ]) {
      writePlist(text);
      daemonGone();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchd.loadedText).toBe(plistWith());
      expect(said()).toContain("Updated auto-start configuration");
      expect(launchd.pid).toBe(process.pid);
    }
    // launchd starts each (engram#641).
    expect(spawn).not.toHaveBeenCalled();
  });

  permissionsIt("rewrites one others can write 0644, which launchd then loads", async () => {
    writePlist(plistWith(), 0o664);
    await daemonStart([], {});
    expect(statSync(PLIST).mode & 0o777).toBe(0o644);
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    expect(launchd.loaded).toBe(true);
  });

  permissionsIt("has launchd start the daemon without a log while that can't be written, and puts the log back once it can (engram#679)", async () => {
    // A plist naming the log, as every CLI before engram#679 wrote one:
    // launchd never started the daemon from it while the log couldn't be
    // opened.
    jobLoaded();
    unwritableLog();
    await daemonStart([], {});
    const none = plistWith({ log: null });
    expect(readFileSync(PLIST, "utf-8")).toBe(none);
    expect(launchd.loadedText).toBe(none);
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    expect(said()).toBe(
      [
        `Updated auto-start configuration (plist v${PLIST_VERSION})`,
        `Engram daemon started (pid ${process.pid})`,
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
        RESTART,
        `DB:  ${DB_FILE}`,
      ].join("\n"),
    );
    // The user's to change.
    expect(statSync(LOG_FILE).mode & 0o777).toBe(0o400);
    expect(process.exitCode).toBeUndefined();

    // Fixed, then 'engram stop', which leaves the job loaded and stops its
    // daemon, and 'engram start' again.
    chmodSync(LOG_FILE, 0o600);
    daemonGone();
    execFileSync.mockClear();
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    expect(said()).toBe(
      [
        `Updated auto-start configuration (plist v${PLIST_VERSION})`,
        `Engram daemon started (pid ${process.pid})`,
        `Log: ${LOG_FILE}`,
        `DB:  ${DB_FILE}`,
      ].join("\n"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves a current plist, and a newer CLI's, as they are", async () => {
    for (const [text, calls] of [
      // The look for a daemon launchd runs, and whether launchd has the job,
      // to start the daemon (engram#641). It hasn't: the daemon is spawned.
      [plistWith(), ["list", "list"]],
      // Only the look: launchd's job runs another CLI.
      [plistWith({ node: join(home.dir, "gone", "node") }, PLIST_VERSION + 1), ["list"]],
    ] as const) {
      writePlist(text);
      daemonGone();
      execFileSync.mockClear();
      spawn.mockClear();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(launchctlCalls()).toEqual(calls);
      expect(spawn).toHaveBeenCalledTimes(1);
      const text_ = said();
      expect(text_).not.toContain("Updated auto-start configuration");
      expect(text_).not.toContain("launchd");
    }
  });

  it("leaves the plist alone off macOS, as in a home shared with Linux", () => {
    writePlist(v1Plist());
    for (const platform of ["linux", "win32"]) {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
      expect(repairLaunchdIfStale()).toBe("unchanged");
    }
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(execFileSync).not.toHaveBeenCalled();
  });

  permissionsIt("says nothing of an update it couldn't write, and starts the daemon all the same", async () => {
    writePlist(v1Plist());
    chmodSync(AGENTS, 0o555);
    try {
      await daemonStart([], {});
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(readdirSync(AGENTS)).toEqual(["app.getengram.daemon.plist"]);
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  posixIt("starts the daemon all the same when a plist can't hold this home, and leaves the plist as it is", async () => {
    const restore = homeNamed("new\nline");
    let plist = "";
    try {
      plist = plistPath();
      writePlist(v1Plist());
      await daemonStart([], {});
    } finally {
      restore();
    }
    expect(readFileSync(plist, "utf-8")).toBe(v1Plist());
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves the plist as it is when this build has no worker", async () => {
    writePlist(v1Plist());
    rmSync(WORKER);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    spawn.mockImplementation(failingSpawn);
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(output()).not.toContain("Updated auto-start configuration");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("waits for launchd to let go of the old job before it loads the new one", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.stillLoadedFor = 3;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "list",
      "list",
      "list",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("unloads and loads with unload and load on older macOS", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    launchd.bootoutFails = true;
    launchd.bootstrapFails = true;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "unload",
      "list",
      "bootstrap",
      "load",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    // Not -w: that would switch back on a job the user switched off (engram#654).
    expect(loads()).toEqual([`load ${PLIST}`]);
    expect(launchd.loadedText).toBe(plistWith());
  });

  it("waits five seconds at most for launchd, and says why it couldn't load the job", () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.stillLoadedFor = Infinity;
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      expect(reloadAgent()).toBe("Load failed: 5: Input/output error");
    } finally {
      clock.mockRestore();
    }
    expect(launchctlCalls()).toEqual(["bootout", "list", "list", "list", "list", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load ${PLIST}`]);
  });
});

/** This CLI's job, loaded, with no daemon running. */
function jobLoaded(): void {
  writePlist(plistWith());
  load(PLIST);
}

/**
 * What start, install and status say of the daemon that runs, when launchd
 * could run it and doesn't: launchd won't restart it (engram#641, engram#692).
 */
const OUTSIDE_LAUNCHD = `The running daemon (pid ${process.pid}) wasn't started by launchd, so launchd won't restart it after a crash: run 'engram stop' and then 'engram start' to fix that.`;

/** launchctl's arguments for having launchd start the daemon (engram#641). */
const KICKSTART = ["kickstart", `${DOMAIN}/${LABEL}`];

/** What a start says when launchctl refused the kickstart with `refusal`. */
const startedDirectly = (refusal: string) =>
  `launchd couldn't start the daemon (launchctl: Could not kickstart service "${DOMAIN}/${LABEL}": ${refusal}), so it is started directly, and won't be restarted after a crash.`;

describe("engram start through launchd (engram#641)", () => {
  it("has launchd start the daemon when its job is loaded: launchd starts it again after a crash", async () => {
    jobLoaded();
    await daemonStart([], {});
    // The look for a daemon launchd runs; whether it has the job, switched
    // on; the kickstart; and the PID launchd gives the daemon.
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
    // Never -k, which would stop the daemon launchd runs, and never -p.
    expect(launchctlArgs()[3]).toEqual(KICKSTART);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    const text = output();
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(text).toContain(`Log: ${LOG_FILE}`);
    expect(text).not.toContain("launchd");
    expect(process.exitCode).toBeUndefined();
  });

  it("with --install, turns start at login on first, and then launchd starts the daemon", async () => {
    await daemonStart([], { install: "" });
    expect(launchctlCalls()).toEqual([
      "print-disabled",
      "bootout",
      "unload",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    const text = output();
    expect(text.indexOf("Auto-start enabled")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Auto-start enabled")).toBeLessThan(text.indexOf("Engram daemon started"));
    expect(text).not.toContain("wasn't started by launchd");
    expect(process.exitCode).toBeUndefined();
  });

  it("with --install and a key set here, starts the daemon itself first, as before", async () => {
    vi.stubEnv("ENGRAM_API_KEY", "eng_test_641");
    await daemonStart([], { install: "" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(firstLaunchctlOrder());
    const text = output();
    expect(text.indexOf("Engram daemon started")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Engram daemon started")).toBeLessThan(text.indexOf("Auto-start enabled"));
    expect(process.exitCode).toBeUndefined();
  });

  it("starts the daemon itself, and says launchd won't restart it, when launchctl won't start it", async () => {
    jobLoaded();
    launchd.kickstartFails = true;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    expect(text).toContain(startedDirectly("113: Could not find specified service"));
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("starts the daemon itself with a key, a server or the vault key set here: launchd's wouldn't have them", async () => {
    jobLoaded();
    for (const [name, value] of [
      ["ENGRAM_API_KEY", "eng_test_641"],
      ["ENGRAM_BASE_URL", "http://127.0.0.1:9"],
      ["ENGRAM_VAULT_KEY", "test-vault-key-641"],
    ]) {
      daemonGone();
      execFileSync.mockClear();
      spawn.mockClear();
      vi.stubEnv(name, value);
      await daemonStart([], {});
      // Only the look for a daemon launchd runs.
      expect(launchctlCalls()).toEqual(["list"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(said()).not.toContain("launchd");
      vi.stubEnv(name, undefined);
    }

    // A server that is only spaces is none, as the daemon reads it.
    daemonGone();
    execFileSync.mockClear();
    spawn.mockClear();
    vi.stubEnv("ENGRAM_BASE_URL", "  ");
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("starts the daemon itself, saying nothing of launchd, when the job isn't loaded, or is switched off", async () => {
    writePlist(plistWith());
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "list"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("launchd");

    jobLoaded();
    launchd.switchedOff = true;
    daemonGone();
    execFileSync.mockClear();
    spawn.mockClear();
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("launchd");
    expect(launchd.switchedOff).toBe(true);
  });

  it("tries launchd when launchctl can't say whether the job is switched off, and says so when it refuses", async () => {
    jobLoaded();
    launchd.switchedOff = true;
    launchd.printDisabledFails = true;
    await daemonStart([], {});
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output()).toContain(startedDirectly("119: Service is disabled"));
    expect(launchd.switchedOff).toBe(true);
  });

  it("fails when the daemon launchd starts exits as it starts, and starts no other", async () => {
    jobLoaded();
    launchd.kickstarts = "dies";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await daemonStart([], {});
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
    // Its PID, asked for as launchd started it: launchd has dropped it since.
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
    expect(launchd.pid).toBeNull();
    const text = output();
    expect(text).toContain("Daemon failed to start. Check the log:");
    expect(text).not.toContain("started directly");
  });

  permissionsIt("says how to see why the daemon launchd starts exits as it starts, while its log can't be written (engram#679)", async () => {
    writePlist(plistWith({ log: null }));
    load(PLIST);
    unwritableLog();
    launchd.kickstarts = "dies";
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await daemonStart([], {});
    expect(exit).toHaveBeenCalledWith(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
    const text = output();
    // What it said went nowhere.
    expect(text).toContain(
      "Daemon failed to start, and its log can't be written (EACCES). To see why, run it here:\n  engram start --foreground",
    );
    expect(text).not.toContain("Check the log");
  });

  it("starts the daemon itself, and says so, when launchd hasn't started one in time", async () => {
    jobLoaded();
    launchd.kickstarts = "never";
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1_000));
    try {
      await daemonStart([], {});
    } finally {
      clock.mockRestore();
    }
    const calls = launchctlCalls();
    expect(calls.slice(0, 4)).toEqual(["list", "list", "print-disabled", "kickstart"]);
    // Then the PID launchd gives the daemon, asked for until it gives up.
    expect(calls.slice(4).length).toBeGreaterThan(0);
    expect(new Set(calls.slice(4))).toEqual(new Set(["list"]));
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    expect(text).toContain(
      "launchd didn't start the daemon in time, so it is started directly, and won't be restarted after a crash.",
    );
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  describe("waiting for launchd's daemon", () => {
    beforeEach(() => {
      launchd.loaded = true;
    });

    it("is done when a daemon answers, ready: launchd's, or one started beside it", async () => {
      launchd.pid = process.pid;
      daemonRunning();
      expect(await waitForAgent()).toEqual({ state: "running", pid: process.pid });

      daemon.answering = { pid: 4242 };
      expect(await waitForAgent()).toEqual({ state: "running", pid: 4242 });
    });

    it("is still starting while the daemon loads, or holds the socket and doesn't answer", async () => {
      launchd.pid = process.pid;
      daemon.answering = { pid: process.pid, ready: false };
      expect(await waitForAgent(300, 100)).toEqual({ state: "starting", pid: process.pid });

      daemon.answering = null;
      daemon.silent = true;
      expect(await waitForAgent(300, 100)).toEqual({ state: "starting", pid: process.pid });
      // Not launchd's, as far as it says: still not one to spawn beside.
      launchd.pid = null;
      expect(await waitForAgent(300, 100)).toEqual({ state: "starting", pid: null });
    });

    it("fails as soon as launchd's daemon has exited with nothing on the socket", async () => {
      launchd.pid = DEAD_PID;
      expect(await waitForAgent()).toEqual({ state: "failed" });
    });

    it("gives up, for a spawn, when launchd hasn't started a process for the job", async () => {
      const started = Date.now();
      expect(await waitForAgent(5_000, 200)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it("takes the PID file for it where there is no socket to ask", async () => {
      launchd.pid = process.pid;
      daemon.unavailable = true;
      expect(await waitForAgent(300, 100)).toEqual({ state: "starting", pid: process.pid });
      mkdirSync(ENGRAM_DIR, { recursive: true });
      writeFileSync(PID_FILE, String(process.pid));
      expect(await waitForAgent()).toEqual({ state: "running", pid: process.pid });
    });
  });

  describe("a daemon launchd doesn't run", () => {
    it("is said when launchd could run it: a stop and a start hand it to launchd", async () => {
      jobLoaded();
      daemonRunning();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual(["list", "list", "print-disabled"]);
      expect(spawn).not.toHaveBeenCalled();
      const text = output();
      expect(text).toContain(`Daemon already running (pid ${process.pid})`);
      expect(text).toContain(OUTSIDE_LAUNCHD);
    });

    it("isn't said for launchd's own daemon, or where launchd couldn't run it", async () => {
      // launchd's own.
      jobLoaded();
      launchd.pid = process.pid;
      daemonRunning();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual(["list"]);
      expect(said()).not.toContain("wasn't started by launchd");

      // The job isn't loaded.
      unload();
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual(["list", "list"]);
      expect(said()).not.toContain("wasn't started by launchd");

      // It is switched off.
      load(PLIST);
      launchd.switchedOff = true;
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual(["list", "list", "print-disabled"]);
      expect(said()).not.toContain("wasn't started by launchd");
      launchd.switchedOff = null;

      // A key set here, which launchd's wouldn't have.
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_641");
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual([]);
      expect(said()).not.toContain("wasn't started by launchd");
      vi.stubEnv("ENGRAM_API_KEY", undefined);

      // A newer CLI's plist, and none.
      writePlist(plistWith({ node: join(home.dir, "gone", "node") }, PLIST_VERSION + 1));
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual([]);
      expect(said()).not.toContain("wasn't started by launchd");
      rmSync(PLIST);
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual([]);
      expect(said()).not.toContain("wasn't started by launchd");
      expect(spawn).not.toHaveBeenCalled();
    });

    it("isn't said when the daemon is another version's: the version hint says to stop and start it", async () => {
      jobLoaded();
      daemonRunning();
      daemon.answering = { pid: process.pid, version: "0.0.1" };
      await daemonStart([], {});
      const text = output();
      expect(text).toContain("It runs version 0.0.1");
      expect(text).not.toContain("wasn't started by launchd");
      expect(launchctlCalls()).toEqual([]);

      // Nor for one from before engram#612, which launchd may well run.
      daemonGone();
      launchd.pid = 4242;
      execFileSync.mockClear();
      vi.mocked(console.log).mockClear();
      await daemonStart([], {});
      const older = output();
      expect(older).toContain("It's from an older version of Engram");
      expect(older).not.toContain("wasn't started by launchd");
      expect(launchctlCalls()).toEqual(["list"]);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("is said by engram status, under its Auto-start line (engram#692)", async () => {
      jobLoaded();
      daemonRunning();
      await daemonStatus();
      // print-disabled for the Auto-start line, which says start at login is
      // on: not asked again. Then whether launchd runs the daemon.
      expect(launchctlCalls()).toEqual(["print-disabled", "list", "list"]);
      const text = said();
      expect(text).toContain(`Status: running (pid ${process.pid})`);
      expect(text).toContain(`Auto-start: enabled (launchd)\n  ${OUTSIDE_LAUNCHD}`);

      // As well when launchctl can't say whether the job is switched off:
      // start at login is on, as far as status can tell.
      launchd.printDisabledFails = true;
      await daemonStatus();
      expect(said()).toContain(`Auto-start: enabled (launchd)\n  ${OUTSIDE_LAUNCHD}`);
    });

    it("isn't said by engram status for launchd's own daemon, or where launchd couldn't run it (engram#692)", async () => {
      /** What status said, and the launchctl calls it made. */
      const status = async () => {
        execFileSync.mockClear();
        await daemonStatus();
        const text = said();
        expect(text).not.toContain("wasn't started by launchd");
        return { text, calls: launchctlCalls() };
      };

      // launchd's own.
      jobLoaded();
      launchd.pid = process.pid;
      daemonRunning();
      let found = await status();
      expect(found.text).toContain("Auto-start: enabled (launchd)");
      expect(found.calls).toEqual(["print-disabled", "list"]);

      // The job isn't loaded.
      unload();
      found = await status();
      expect(found.text).toContain("Auto-start: enabled (launchd)");
      expect(found.calls).toEqual(["print-disabled", "list", "list"]);

      // It is switched off: the Auto-start line says so.
      load(PLIST);
      launchd.switchedOff = true;
      found = await status();
      expect(found.text).toContain("Auto-start: off — disabled in launchd");
      expect(found.calls).toEqual(["print-disabled"]);
      launchd.switchedOff = null;

      // A key set here, which launchd's daemon wouldn't have.
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_692");
      found = await status();
      expect(found.text).toContain("Auto-start: enabled (launchd)");
      expect(found.calls).toEqual(["print-disabled"]);
      vi.stubEnv("ENGRAM_API_KEY", undefined);

      // A plist that is outdated, or broken: the Auto-start line says to
      // run 'engram install'.
      writePlist(v1Plist());
      found = await status();
      expect(found.text).toContain("Auto-start: enabled (launchd)  — outdated config");
      expect(found.calls).toEqual(["print-disabled"]);
      writePlist(plistWith({ node: join(home.dir, "gone", "node") }));
      found = await status();
      expect(found.text).toContain("Auto-start: enabled (launchd)  — broken");
      expect(found.calls).toEqual(["print-disabled"]);

      // None.
      rmSync(PLIST);
      found = await status();
      expect(found.text).not.toContain("Auto-start");
      expect(found.calls).toEqual([]);

      // No daemon runs, or one doesn't answer, or is stopping.
      jobLoaded();
      daemonGone();
      expect((await status()).text).toContain("Status: stopped");
      daemon.silent = true;
      expect((await status()).text).toContain("Status: not answering");
      daemon.silent = false;
      daemon.answering = { pid: process.pid, stopping: true };
      expect((await status()).text).toContain(`Status: stopping (pid ${process.pid})`);
    });

    it("isn't said by engram status when the version hint says to stop and start it (engram#692)", async () => {
      jobLoaded();
      daemonRunning();
      daemon.answering = { pid: process.pid, version: "0.0.1" };
      await daemonStatus();
      const text = said();
      expect(text).toContain("It runs version 0.0.1");
      expect(text).toContain("Auto-start: enabled (launchd)");
      expect(text).not.toContain("wasn't started by launchd");
      expect(launchctlCalls()).toEqual(["print-disabled"]);

      // Nor for one from before engram#612.
      daemonGone();
      launchd.pid = 4242;
      execFileSync.mockClear();
      await daemonStatus();
      const older = said();
      expect(older).toContain("It's from an older version of Engram");
      expect(older).not.toContain("wasn't started by launchd");
      expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
    });

    it("is said by engram install, which leaves the daemon that runs as it is (engram#692)", async () => {
      daemonRunning();
      await daemonInstall();
      expect(launchd.loaded).toBe(true);
      expect(spawn).not.toHaveBeenCalled();
      const text = said();
      expect(text).toContain("Auto-start enabled — daemon will start on login");
      expect(text.indexOf(OUTSIDE_LAUNCHD)).toBeGreaterThan(text.indexOf("Auto-start enabled"));

      // A key set here, which launchd's daemon wouldn't have.
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_692");
      await daemonInstall();
      expect(said()).not.toContain("wasn't started by launchd");
      vi.stubEnv("ENGRAM_API_KEY", undefined);

      // launchd's own, as after a stop and a start.
      launchd.pid = process.pid;
      execFileSync.mockClear();
      await daemonInstall();
      const again = said();
      expect(again).toContain("Auto-start enabled — daemon will start on login");
      expect(again).not.toContain("wasn't started by launchd");
      expect(launchctlCalls()).toEqual(["print-disabled", "list", "list"]);
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("has launchd start the daemon when its job is loaded", async () => {
      jobLoaded();
      await autoEnableCapture({ after: "command" });
      expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart"]);
      expect(launchctlArgs()[3]).toEqual(KICKSTART);
      expect(spawn).not.toHaveBeenCalled();
      expect(launchd.pid).toBe(process.pid);
      expect(said()).toContain("Auto-capture is on");
    });

    it("starts the daemon itself when launchctl won't, saying nothing more of it", async () => {
      jobLoaded();
      launchd.kickstartFails = true;
      await autoEnableCapture({ after: "command" });
      expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = said();
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("launchd");
    });

    it("starts the daemon itself first with a key set here, then turns on start at login", async () => {
      vi.stubEnv("ENGRAM_API_KEY", "eng_test_641");
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap"]);
      expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(firstLaunchctlOrder());
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(said()).toContain("Auto-start enabled — daemon will start on login");
    });
  });
});

describe("engram install after engram stop on macOS (engram#691)", () => {
  // After `engram stop`, launchd has the job loaded and runs no daemon: the
  // daemon exited 0, which KeepAlive doesn't start again, and a job loaded
  // already isn't loaded again. Install used to leave capture off then.

  /**
   * The look for a daemon; start at login, with the job loaded already; and
   * the start through launchd, as `engram start` has it: whether the job is
   * loaded and switched on, the kickstart, and the PID launchd gives the
   * daemon.
   */
  const THROUGH_LAUNCHD = ["list", "print-disabled", "list", "list", "print-disabled", "kickstart", "list"];
  /** A made-up PID: the daemon launchd runs, stopping. */
  const STOPPING = 4_243;

  /**
   * launchd's daemon is stopping, as `engram stop` leaves it while a send
   * finishes: it answers that it is stopping, and exits `exitsIn` ms from
   * now, or never. Then nothing answers, and launchd runs none.
   */
  function daemonStopping(exitsIn?: number): void {
    launchd.pid = STOPPING;
    madeUp.add(STOPPING);
    daemon.answering = { pid: STOPPING, stopping: true };
    if (exitsIn === undefined) return;
    timers.push(
      setTimeout(() => {
        madeUp.delete(STOPPING);
        daemonGone();
      }, exitsIn),
    );
  }

  it("has launchd start the daemon when its job is loaded already: launchd starts it again after a crash", async () => {
    jobLoaded();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(THROUGH_LAUNCHD);
    // Never -k, which would stop the daemon launchd runs, and never -p.
    expect(launchctlArgs()[5]).toEqual(KICKSTART);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    const text = output();
    const enabled = text.indexOf("Auto-start enabled — daemon will start on login");
    expect(enabled).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(`Engram daemon started (pid ${process.pid})`)).toBeGreaterThan(enabled);
    expect(text).not.toContain("started directly");
    expect(process.exitCode).toBeUndefined();
  });

  it("starts no daemon beside one that runs, or holds the socket and doesn't answer", async () => {
    for (const daemonThere of [
      () => {
        launchd.pid = process.pid;
        daemonRunning();
      },
      () => daemonRunning(),
      () => {
        launchd.pid = process.pid;
        daemon.silent = true;
      },
    ]) {
      jobLoaded();
      daemonGone();
      daemon.silent = false;
      daemonThere();
      execFileSync.mockClear();
      await daemonInstall();
      expect(launchctlCalls()).not.toContain("kickstart");
      const text = said();
      expect(text).toContain("Auto-start enabled — daemon will start on login");
      expect(text).not.toContain("Engram daemon started");
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves the start to launchd when it loads the job: launchd starts the daemon as it loads it", async () => {
    // There, and not loaded.
    writePlist(plistWith());
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "list", "bootout", "unload", "list", "bootstrap"]);
    // Loaded, from a plist that changed since: loaded again.
    writePlist(v1Plist());
    launchd.loadedText = v1Plist();
    execFileSync.mockClear();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "bootout", "list", "bootstrap"]);
    expect(launchd.loadedText).toBe(plistWith());
    expect(spawn).not.toHaveBeenCalled();
    expect(output()).not.toContain("Engram daemon started");
    expect(process.exitCode).toBeUndefined();
  });

  it("switches a job launchd has loaded back on, and then has launchd start the daemon", async () => {
    jobLoaded();
    launchd.switchedOff = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "enable",
      "list",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.pid).toBe(process.pid);
    expect(spawn).not.toHaveBeenCalled();
    expect(output()).toContain(`Engram daemon started (pid ${process.pid})`);
  });

  it("starts the daemon itself with a key set here, as engram start does: launchd's wouldn't have it", async () => {
    vi.stubEnv("ENGRAM_API_KEY", "eng_test_691");
    jobLoaded();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["list", "print-disabled", "list"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(launchd.pid).toBeNull();
    const text = output();
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(text).not.toContain("started directly");
    expect(process.exitCode).toBeUndefined();
  });

  it("starts the daemon itself, and says launchd won't restart it, when launchctl won't start it", async () => {
    jobLoaded();
    launchd.kickstartFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(THROUGH_LAUNCHD.slice(0, 6));
    expect(spawn).toHaveBeenCalledTimes(1);
    const text = output();
    expect(text).toContain(startedDirectly("113: Could not find specified service"));
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("fails when the daemon launchd starts exits as it starts, and starts no other", async () => {
    jobLoaded();
    launchd.kickstarts = "dies";
    await daemonInstall();
    expect(launchctlCalls()).toEqual(THROUGH_LAUNCHD);
    expect(spawn).not.toHaveBeenCalled();
    const text = output();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain("Daemon failed to start. Check the log:");
    expect(text).not.toContain("started directly");
    expect(process.exitCode).toBe(1);
  });

  it("has launchd start it once with engram start --install", async () => {
    jobLoaded();
    await daemonStart([], { install: "" });
    expect(launchctlCalls()).toEqual(THROUGH_LAUNCHD);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    expect(output()).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("waits for a daemon that is stopping, as engram start does, then has launchd start one", async () => {
    jobLoaded();
    daemonStopping(300);
    await daemonInstall();
    const text = output();
    expect(text).toContain(`Waiting for the daemon that is stopping (pid ${STOPPING}) to finish...`);
    // Nothing asked of launchd while it waits: a kickstart would find the job
    // running, and start nothing.
    expect(launchctlCalls()).toEqual(THROUGH_LAUNCHD);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(process.pid);
    expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
    expect(process.exitCode).toBeUndefined();
  });

  it("turns start at login on, starts nothing and fails when the daemon stopping hasn't gone in time", async () => {
    jobLoaded();
    daemonStopping();
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 5_000));
    try {
      await daemonInstall();
    } finally {
      clock.mockRestore();
    }
    // Start at login, the job loaded already; no kickstart.
    expect(launchctlCalls()).toEqual(["print-disabled", "list"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(launchd.pid).toBe(STOPPING);
    const text = output();
    expect(text).toContain(`Waiting for the daemon that is stopping (pid ${STOPPING}) to finish...`);
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain(`The daemon is still stopping (pid ${STOPPING}). Run 'engram start' in a moment.`);
    expect(text).not.toContain("Engram daemon started");
    expect(process.exitCode).toBe(1);
  });
});

describe("engram status on macOS (engram#616)", () => {
  it("says start at login is on", async () => {
    writePlist(plistWith());
    daemonRunning();
    await daemonStatus();
    const text = output();
    expect(text).toContain("Auto-start: enabled (launchd)");
    expect(text).not.toContain("outdated");
    expect(text).not.toContain("broken");
    // Then whether launchd runs the daemon (engram#692): it hasn't the job
    // loaded, so it couldn't.
    expect(launchctlCalls()).toEqual(["print-disabled", "list", "list"]);
    expect(text).not.toContain("wasn't started by launchd");
  });

  it("says a plist launchd can't start the daemon from is broken", async () => {
    for (const text of [
      plistWith({ worker: join(home.dir, "gone", "worker.js") }),
      plistWith({ node: join(home.dir, "gone", "node") }),
      plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"),
    ]) {
      writePlist(text);
      daemonRunning();
      await daemonStatus();
      expect(said()).toContain("Auto-start: enabled (launchd)  — broken, run 'engram install' to repair");
    }
  });

  it("says an older plist is outdated", async () => {
    writePlist(v1Plist());
    daemonRunning();
    await daemonStatus();
    expect(output()).toContain("Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update");
  });

  it("points at what repairs or updates it while the daemon runs: engram install (engram#651)", async () => {
    for (const text of [v1Plist(), plistWith({ node: join(home.dir, "gone", "node") })]) {
      writePlist(text);
      launchd.loaded = true;
      launchd.loadedText = text;
      daemonRunning();
      await daemonStatus();
      expect(said()).toMatch(/^Auto-start: enabled \(launchd\) {2}— (broken|outdated config), run 'engram install' to (repair|update)$/m);
      // engram start finds the daemon running, and repairs nothing.
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(said()).toContain("Daemon already running");
      await daemonInstall();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchd.loadedText).toBe(plistWith());
      const installed = said();
      expect(installed).toContain("Auto-start enabled — daemon will start on login");
      // The daemon that ran before still runs, and launchd doesn't run it:
      // that is said now, by install and by status (engram#692).
      expect(installed).toContain(OUTSIDE_LAUNCHD);
      await daemonStatus();
      const after = said();
      expect(after).toContain(`Auto-start: enabled (launchd)\n  ${OUTSIDE_LAUNCHD}`);
      expect(after).not.toMatch(/broken|outdated|to (repair|update)/);
    }
  });

  permissionsIt("says the daemon runs without its log while that can't be written, and what fixes it (engram#679)", async () => {
    unwritableLog();
    writePlist(plistWith({ log: null }));
    await daemonStatus();
    // Stopped by itself: why can't be read anywhere.
    expect(said()).toContain(
      [
        "Auto-start: enabled (launchd)",
        "  It should be running: start at login is on. It may have stopped after an error.",
        "  Its log can't be written: 'engram start --foreground' shows why it stops.",
        "  Run 'engram start' to start it again.",
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon will run without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
      ].join("\n"),
    );

    load(PLIST);
    launchd.pid = process.pid;
    daemonRunning();
    await daemonStatus();
    const running = said();
    expect(running).toContain(
      [
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
        RESTART,
      ].join("\n"),
    );
    expect(running).not.toMatch(/broken|outdated|journal/);
  });

  permissionsIt("says the daemon launchd started without its log doesn't write to it once it can be written (engram#720)", async () => {
    unwritableLog();
    writePlist(plistWith({ log: null }));
    load(PLIST);
    launchd.pid = process.pid;
    daemonRunning();
    // launchd gave it no output file: its output goes nowhere.
    daemon.answering = { pid: process.pid, output: "none" };
    chmodSync(LOG_FILE, 0o600);
    await daemonStatus();
    const text = said();
    // The plist without a log is outdated now, and what has the daemon write
    // to the log is said with the log.
    expect(text).toContain("outdated");
    expect(logLines(text)).toEqual([
      `Log: ${LOG_FILE}, but the daemon doesn't write to it: it started without it.`,
      "  'engram stop' and then 'engram start' have the daemon write to it.",
    ]);
    expect(text).not.toMatch(/journal|can't be written/);
  });

  it("says nothing of start at login without a plist", async () => {
    daemonRunning();
    await daemonStatus();
    expect(output()).not.toContain("Auto-start");
    expect(launchctlCalls()).toEqual([]);
  });

  it("says the daemon should be running when start at login is on and it isn't", async () => {
    writePlist(plistWith());
    await daemonStatus();
    expect(said()).toContain("It should be running: start at login is on.");

    // Not when start at login is broken: that is why, and status says so.
    writePlist(plistWith({ node: join(home.dir, "gone", "node") }));
    await daemonStatus();
    const text = said();
    expect(text).toContain("broken");
    expect(text).not.toContain("It should be running");
  });

  it("finds a daemon from before engram#612, which has no socket, through launchd", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    await daemonStatus();
    const text = output();
    expect(text).toContain("Status: running (pid 4242)");
    expect(text).toContain("It's from an older version of Engram");
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
  });

  it("names the daemon launchd runs when something holds the socket and doesn't answer", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    daemon.silent = true;
    await daemonStatus();
    expect(output()).toContain("Status: running (pid 4242) — not answering right now");
    expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
  });

  it("off macOS, never takes a plist older CLIs wrote for launchd's, or asks launchctl about it", async () => {
    // CLIs before engram#602 wrote one on every OS. A launchctl on PATH all the same.
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.pid = 4242;
    vi.stubEnv("XDG_CONFIG_HOME", undefined);
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    await daemonStatus();
    const text = output();
    expect(text).toContain("Status: stopped");
    expect(text).not.toContain("launchd");
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

describe("engram uninstall on macOS (engram#616)", () => {
  it("unloads the agent and removes the plist", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(launchd.loaded).toBe(false);
    expect(launchctlCalls()).toEqual(["bootout"]);
    expect(output()).toContain("Auto-start disabled — launchd agent removed");
    expect(process.exitCode).toBeUndefined();
  });

  it("removes one launchd hasn't loaded, and an older or broken one, just the same", async () => {
    for (const text of [plistWith(), v1Plist(), "<plist/>"]) {
      writePlist(text);
      execFileSync.mockClear();
      await daemonUninstall();
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual(["bootout", "unload"]);
      expect(said()).toContain("Auto-start disabled");
    }
  });

  it("removes the plist with no launchctl to ask", async () => {
    writePlist(plistWith());
    vi.stubEnv("PATH", NO_BIN);
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(output()).toContain("Auto-start disabled");
  });

  it("says so when there is no plist", async () => {
    await daemonUninstall();
    expect(output()).toContain("Launchd agent not installed.");
    expect(execFileSync).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("fails, and says what to remove, when it can't remove the plist", async () => {
    // A directory in its place, which removing a file won't remove.
    mkdirSync(join(PLIST, "x"), { recursive: true });
    await daemonUninstall();
    expect(existsSync(PLIST)).toBe(true);
    const text = output();
    expect(text).toContain("Couldn't remove the launchd agent.");
    expect(text).toContain(`Remove ${PLIST} to turn start at login off.`);
    expect(text).not.toContain("Auto-start disabled");
    expect(process.exitCode).toBe(1);
  });
});

describe("auto-capture on macOS (engram#616)", () => {
  signedInAtATerminal();

  it("starts the daemon and turns on start at login after sign-in, then says nothing more", async () => {
    await autoEnableCapture({ after: "login" });
    const text = said();
    expect(text).toContain("Auto-start enabled — daemon will start on login");
    expect(text).toContain("Auto-capture is on");
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    // Start at login first, and then launchd starts the daemon, which it
    // starts again after a crash (engram#641).
    expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "list", "print-disabled", "kickstart"]);
    expect(launchd.loadedText).toBe(plistWith());
    expect(launchd.pid).toBe(process.pid);
    expect(spawn).not.toHaveBeenCalled();

    execFileSync.mockClear();
    for (let command = 0; command < 3; command++) {
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    }
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("turns on start at login after any other command, and says so", async () => {
    rmSync(LOG_FILE, { force: true });
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(spawn).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-start enabled");
    expect(text).toContain("Auto-capture is on");
    expect(launchd.loaded).toBe(true);
    expect(launchd.logAtLoad).toBe(true);
  });

  it("updates an older plist of its own, says so once, then nothing", async () => {
    writePlist(v1Plist());
    launchd.loaded = true;
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    const text = said();
    expect(text).toContain("Updated auto-start configuration");
    expect(text).toContain("Auto-capture is on");

    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");
  });

  posixIt("says nothing after a command when a plist can't hold this home, and leaves the older one", async () => {
    const restore = homeNamed("new\nline");
    try {
      writePlist(v1Plist());
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(readFileSync(plistPath(), "utf-8")).toBe(v1Plist());
    } finally {
      restore();
    }
    expect(said()).toBe("");
    expect(execFileSync).not.toHaveBeenCalled();
  });

  permissionsIt("says nothing after a command when it can't write the update, and leaves the older one", async () => {
    writePlist(v1Plist());
    chmodSync(AGENTS, 0o555);
    try {
      daemonRunning();
      await autoEnableCapture({ after: "command" });
    } finally {
      chmodSync(AGENTS, 0o755);
    }
    expect(said()).toBe("");
    expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
    expect(readdirSync(AGENTS)).toEqual([`${LABEL}.plist`]);
    expect(launchctlCalls()).toEqual(["print-disabled"]);
  });

  it("repairs a broken plist of its own", async () => {
    writePlist(plistWith({ home: "/Users/a<b" }).replace("&lt;", () => "<"));
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(said()).toContain("Updated auto-start configuration");
  });

  it("says it can't turn on start at login when it had to start the daemon, not after every command", async () => {
    // ~/Library/LaunchAgents a file: no plist can go there.
    mkdirSync(join(home.dir, "Library"), { recursive: true });
    writeFileSync(AGENTS, "");
    daemonRunning();
    await autoEnableCapture({ after: "command" });
    expect(said()).toBe("");

    daemonGone();
    await autoEnableCapture({ after: "command" });
    expect(spawn).toHaveBeenCalledTimes(1);
    // The worker itself: launchd is the one that starts it again.
    expect(spawn.mock.calls[0][1]).toEqual([expect.stringMatching(/[\\/]worker\.js$/)]);
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(launchctlCalls()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("says it couldn't turn on start at login when a plist can't hold this home", async () => {
    const restore = homeNamed("new\nline");
    try {
      await autoEnableCapture({ after: "login" });
    } finally {
      restore();
    }
    const text = said();
    expect(text).toContain("Couldn't turn on start at login. Run 'engram install' to try again.");
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("new\nline");
    expect(existsSync(join(home.dir, "new\nline", "Library"))).toBe(false);
    expect(launchctlCalls()).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("leaves start at login alone in a source checkout, which has no worker.js", async () => {
    rmSync(WORKER);
    daemonRunning();
    await autoEnableCapture({ after: "login" });
    expect(existsSync(join(home.dir, "Library"))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    const text = said();
    expect(text).toContain("Auto-capture is on");
    expect(text).not.toContain("Auto-start");
    expect(text).not.toContain("start at login");
  });

  it("writes the plist when launchd won't load it now: launchd loads it at the next login", async () => {
    launchd.bootstrapFails = true;
    launchd.loadFails = true;
    daemonRunning();
    await autoEnableCapture({ after: "login" });
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "load"]);
    expect(loads()).toEqual([`load ${PLIST}`]);
    const text = said();
    expect(text).toContain("Auto-start enabled");
    expect(text).toContain("Auto-capture is on");
  });
});

describe("a ~/Library/LaunchAgents that isn't the user's (engram#678, engram#715)", () => {
  const ROOTS = "~/Library/LaunchAgents belongs to root, not to you";
  /** What makes it the user's again: the folder only. */
  const FIX = `  Make it yours with: sudo chown "$(id -un)" ~/Library/LaunchAgents`;

  /**
   * ~/Library/LaunchAgents, as `sudo engram install` could leave it before
   * engram#653: root's, as Engram sees it, and not to be written in.
   * `owner`: another user's.
   */
  function agentsOwnedBy(owner = 0): void {
    mkdirSync(AGENTS, { recursive: true });
    chmodSync(AGENTS, 0o555);
    launchd.agentsOwner = owner;
  }

  /** This plist there, in a folder root owns. */
  function inRootsFolder(text: string): void {
    if (existsSync(AGENTS)) chmodSync(AGENTS, 0o755);
    writePlist(text);
    agentsOwnedBy();
  }

  /** `sudo chown "$(id -un)" ~/Library/LaunchAgents` */
  function madeTheUsers(): void {
    launchd.agentsOwner = null;
    chmodSync(AGENTS, 0o755);
  }

  /** What went to stderr. */
  function errors(): string {
    return vi
      .mocked(console.error)
      .mock.calls.map((c) => c.join(" "))
      .join("\n");
  }

  afterEach(() => {
    if (existsSync(AGENTS)) chmodSync(AGENTS, 0o755);
  });

  describe("engram install", () => {
    permissionsIt("says whose it is and what makes it the user's, not a temporary file's EACCES", async () => {
      agentsOwnedBy();
      await daemonInstall();
      const text = errors();
      expect(text).toBe(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram install' again.`);
      expect(output()).not.toContain("Auto-start enabled");
      expect(readdirSync(AGENTS)).toEqual([]);
      expect(launchctlCalls()).toEqual([]);
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("leaves an older plist as it is, and the job launchd loaded from it", async () => {
      inRootsFolder(v1Plist());
      launchd.loaded = true;
      launchd.loadedText = v1Plist();
      await daemonInstall();
      expect(errors()).toContain(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}`);
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(readdirSync(AGENTS)).toEqual([`${LABEL}.plist`]);
      expect(launchd.loaded).toBe(true);
      expect(launchd.loadedText).toBe(v1Plist());
      // Only whether launchd runs a daemon for it.
      expect(launchctlCalls()).toEqual(["list"]);
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("turns start at login on all the same when the plist there is current: nothing is written", async () => {
      inRootsFolder(plistWith());
      await daemonInstall();
      const text = output();
      expect(text).toContain("Auto-start enabled — daemon will start on login");
      expect(text).not.toContain("Couldn't");
      expect(launchd.loadedText).toBe(plistWith());
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("says another user's, when it is", async () => {
      agentsOwnedBy(4242);
      await daemonInstall();
      expect(errors()).toContain(
        "Couldn't turn on start at login: ~/Library/LaunchAgents belongs to another user, not to you.",
      );
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("works once it is the user's", async () => {
      agentsOwnedBy();
      await daemonInstall();
      said();
      madeTheUsers();
      process.exitCode = undefined;
      await daemonInstall();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(said()).toContain("Auto-start enabled — daemon will start on login");
      expect(process.exitCode).toBeUndefined();
    });

    it("says nothing of a folder another user owns that can be written in all the same", async () => {
      mkdirSync(AGENTS, { recursive: true });
      launchd.agentsOwner = 4242;
      await daemonInstall();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(said()).toContain("Auto-start enabled — daemon will start on login");
      await daemonStatus();
      expect(said()).not.toContain("LaunchAgents belongs");
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("puts down only a refused write to whose the folder is", async () => {
      // ~/Library/LaunchAgents a file, which no plist can go in.
      mkdirSync(join(home.dir, "Library"), { recursive: true });
      writeFileSync(AGENTS, "");
      launchd.agentsOwner = 0;
      await daemonInstall();
      const text = errors();
      expect(text).toContain("Couldn't turn on start at login.");
      expect(text).not.toContain("belongs to");
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("puts down EPERM to it as well as EACCES", async () => {
      agentsOwnedBy();
      launchd.writeFails = "EPERM";
      await daemonInstall();
      expect(errors()).toContain(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}`);
      expect(errors()).not.toContain("operation not permitted");
      launchd.writeFails = "EIO";
      process.exitCode = undefined;
      said();
      await daemonInstall();
      expect(errors()).toBe("Couldn't turn on start at login.\n  EIO: operation not permitted");
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("says it, and to run engram install again, when the daemon is still stopping", async () => {
      agentsOwnedBy();
      // A daemon stopping, still there when install has waited for it.
      const stopping = 4_243;
      madeUp.add(stopping);
      daemon.answering = { pid: stopping, stopping: true };
      let now = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 5_000));
      try {
        await daemonInstall();
      } finally {
        clock.mockRestore();
      }
      expect(errors()).toBe(
        `Couldn't turn on start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram install' again.\n` +
          `The daemon is still stopping (pid ${stopping}). Run 'engram start' in a moment.`,
      );
      expect(readdirSync(AGENTS)).toEqual([]);
      expect(launchctlCalls()).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("engram start", () => {
    permissionsIt("says it couldn't update start at login, and why, and starts the daemon all the same", async () => {
      inRootsFolder(v1Plist());
      await daemonStart([], {});
      expect(errors()).toBe(`Couldn't update start at login: ${ROOTS}.\n${FIX}\n  Then run: engram install`);
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(readdirSync(AGENTS)).toEqual([`${LABEL}.plist`]);
      expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
      expect(output()).not.toContain("Updated auto-start configuration");
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("says nothing of a plist it can't write for another reason, and starts the daemon all the same", async () => {
      // The user's own folder, that they can't write in; and a write that
      // fails on its own, in root's.
      const others: (() => void)[] = [
        () => {
          launchd.agentsOwner = null;
        },
        () => {
          launchd.writeFails = "EIO";
        },
      ];
      for (const other of others) {
        inRootsFolder(v1Plist());
        other();
        daemonGone();
        spawn.mockClear();
        said();
        await daemonStart([], {});
        expect(errors()).toBe("");
        expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(process.exitCode).toBeUndefined();
      }
    });

    permissionsIt("says nothing of it while the plist needs no update", async () => {
      inRootsFolder(plistWith());
      await daemonStart([], {});
      expect(output()).not.toContain("LaunchAgents");
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("with --install, says it once, as it turns start at login on, and starts the daemon", async () => {
      inRootsFolder(v1Plist());
      await daemonStart([], { install: "" });
      const text = errors();
      expect(text).toBe(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram start --install' again.`);
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("with --install and a server set here, starts the daemon itself, then says it as it turns start at login on", async () => {
      // launchd's daemon wouldn't have the server (engram#641).
      vi.stubEnv("ENGRAM_BASE_URL", "http://127.0.0.1:9");
      inRootsFolder(v1Plist());
      await daemonStart([], { install: "" });
      expect(errors()).toBe(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram start --install' again.`);
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    });

    permissionsIt("with --install while the daemon runs, says it as it turns start at login on", async () => {
      agentsOwnedBy();
      daemonRunning();
      await daemonStart([], { install: "" });
      expect(output()).toContain("Daemon already running");
      expect(errors()).toBe(`Couldn't turn on start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram start --install' again.`);
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  describe("engram uninstall", () => {
    permissionsIt("says why it can't turn start at login off, and leaves launchd and the plist as they are", async () => {
      inRootsFolder(plistWith());
      launchd.loaded = true;
      launchd.loadedText = plistWith();
      await daemonUninstall();
      expect(errors()).toBe(`Couldn't turn off start at login: ${ROOTS}.\n${FIX}\n  Then run 'engram uninstall' again.`);
      expect(output()).not.toContain("Auto-start disabled");
      expect(existsSync(PLIST)).toBe(true);
      expect(launchd.loaded).toBe(true);
      expect(launchctlCalls()).toEqual([]);
      expect(process.exitCode).toBe(1);

      madeTheUsers();
      process.exitCode = undefined;
      await daemonUninstall();
      expect(existsSync(PLIST)).toBe(false);
      expect(launchd.loaded).toBe(false);
      expect(output()).toContain("Auto-start disabled — launchd agent removed");
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("says nothing of it with no plist there", async () => {
      agentsOwnedBy();
      await daemonUninstall();
      expect(output()).toBe("Launchd agent not installed.");
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("engram status", () => {
    const UNDER = `  ${ROOTS}, so Engram can't update or remove its launchd agent.\n${FIX}`;

    permissionsIt("says it under start at login, whatever the plist's state", async () => {
      const states: [string, string][] = [
        [plistWith(), "Auto-start: enabled (launchd)"],
        [v1Plist(), "Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update"],
        [
          plistWith({ node: join(home.dir, "gone", "node") }),
          "Auto-start: enabled (launchd)  — broken, run 'engram install' to repair",
        ],
      ];
      for (const [text, line] of states) {
        inRootsFolder(text);
        await daemonStatus();
        expect(said()).toContain(`${line}\n${UNDER}`);
      }
      launchd.switchedOff = true;
      await daemonStatus();
      expect(said()).toContain(`Auto-start: off — disabled in launchd  ('engram install' turns it back on)\n${UNDER}`);
      expect(readFileSync(PLIST, "utf-8")).toBe(states[2][0]);
    });

    permissionsIt("says nothing of it with no plist there, or once it is the user's", async () => {
      agentsOwnedBy();
      await daemonStatus();
      expect(said()).not.toContain("LaunchAgents");
      inRootsFolder(plistWith());
      madeTheUsers();
      await daemonStatus();
      const text = said();
      expect(text).toContain("Auto-start: enabled (launchd)");
      expect(text).not.toContain("LaunchAgents");
    });

    permissionsIt("says another user's, when it is", async () => {
      inRootsFolder(plistWith());
      launchd.agentsOwner = 4242;
      await daemonStatus();
      expect(output()).toContain(
        "  ~/Library/LaunchAgents belongs to another user, not to you, so Engram can't update or remove its launchd agent.",
      );
    });
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    permissionsIt("says what stops start at login after sign-in, and turns capture on all the same", async () => {
      agentsOwnedBy();
      await autoEnableCapture({ after: "login" });
      const text = said();
      expect(text).toContain(
        `  Couldn't set up start at login: ${ROOTS}. Make it yours with: sudo chown "$(id -un)" ~/Library/LaunchAgents`,
      );
      expect(text).not.toContain("Run 'engram install' to try again.");
      expect(text).toContain("Auto-capture is on");
      expect(readdirSync(AGENTS)).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("says nothing after a command while the daemon runs; says it with the rest when it starts one", async () => {
      inRootsFolder(v1Plist());
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");

      daemonGone();
      await autoEnableCapture({ after: "command" });
      const text = said();
      expect(text).toContain(`  Couldn't set up start at login: ${ROOTS}. Make it yours with:`);
      // Not the repair's own warning as well.
      expect(text).not.toContain("Couldn't update start at login");
      expect(text).toContain("Auto-capture is on");
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(process.exitCode).toBeUndefined();
    });

    permissionsIt("sets start at login up after the next command once the folder is the user's", async () => {
      agentsOwnedBy();
      await autoEnableCapture({ after: "login" });
      said();
      madeTheUsers();
      await autoEnableCapture({ after: "command" });
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(said()).toContain("Auto-start enabled — daemon will start on login");
    });
  });

  describe("launchAgentsNotYours", () => {
    const me = 501;
    const looked: string[] = [];
    const owner = (uid: number | null) => (path: string) => {
      looked.push(path);
      return uid;
    };
    const writable = (can: boolean) => (path: string) => {
      looked.push(path);
      return can;
    };

    beforeEach(() => {
      looked.length = 0;
    });

    it("is root's, or another user's, when they own it and it can't be written in", () => {
      expect(launchAgentsNotYours({ euid: me, ownerOf: owner(0), canWriteIn: writable(false) })).toEqual({ root: true });
      expect(looked).toEqual([AGENTS, AGENTS]);
      expect(launchAgentsNotYours({ euid: me, ownerOf: owner(502), canWriteIn: writable(false) })).toEqual({
        root: false,
      });
    });

    it("is null when it can be written in all the same, as on a network home that maps owners wrongly", () => {
      expect(launchAgentsNotYours({ euid: me, ownerOf: owner(0), canWriteIn: writable(true) })).toBeNull();
    });

    it("is null when it is the user's, even one they can't write in", () => {
      expect(launchAgentsNotYours({ euid: me, ownerOf: owner(me), canWriteIn: writable(false) })).toBeNull();
    });

    it("is null when it isn't there", () => {
      expect(launchAgentsNotYours({ euid: me, ownerOf: owner(null), canWriteIn: writable(false) })).toBeNull();
    });

    it("is null as root, which can write in it, and looks at nothing", () => {
      expect(launchAgentsNotYours({ euid: 0, ownerOf: owner(502), canWriteIn: writable(false) })).toBeNull();
      expect(looked).toEqual([]);
    });

    posixIt("is null with no uid to go by, as on Windows", () => {
      vi.spyOn(process, "geteuid").mockReturnValue(undefined as unknown as number);
      expect(launchAgentsNotYours({ ownerOf: owner(0), canWriteIn: writable(false) })).toBeNull();
      expect(looked).toEqual([]);
    });

    permissionsIt("goes by this process's uid, and the folder's own owner", () => {
      const uid = process.geteuid?.() ?? -1;
      // Not there yet: nobody's.
      expect(launchAgentsNotYours({ euid: uid + 1, canWriteIn: writable(false) })).toBeNull();
      mkdirSync(AGENTS, { recursive: true });
      expect(launchAgentsNotYours({ ownerOf: owner(uid), canWriteIn: writable(false) })).toBeNull();
      expect(launchAgentsNotYours({ canWriteIn: writable(false) })).toBeNull();
      expect(launchAgentsNotYours({ ownerOf: owner(uid + 1), canWriteIn: writable(false) })).toEqual({ root: false });
      // Its owner, as another user would see it.
      expect(launchAgentsNotYours({ euid: uid + 1, canWriteIn: writable(false) })).toEqual({ root: false });
    });
  });
});

describe("launchd's switch for the job (engram#654)", () => {
  /** What print-disabled prints with these entries in its list. */
  const listed = (...entries: string[]) =>
    `\n\tdisabled services = {\n${entries.map((entry) => `\t\t${entry}\n`).join("")}\t}\n`;

  it("is read from launchctl print-disabled: switched off, switched on, or never switched", () => {
    expect(disabledIn(listed(`"${LABEL}" => disabled`))).toBe(true);
    expect(disabledIn(listed(`"${LABEL}" => enabled`))).toBe(false);
    // Older macOS: true for switched off, false for on.
    expect(disabledIn(listed(`"${LABEL}" => true`))).toBe(true);
    expect(disabledIn(listed(`"${LABEL}" => false`))).toBe(false);
    // Never switched: launchd loads it.
    expect(disabledIn(listed(`"com.example.agent" => disabled`))).toBe(false);
    expect(disabledIn(listed())).toBe(false);
    expect(disabledIn(listed(`"com.example.agent" => disabled`, `"${LABEL}" => disabled`))).toBe(true);
  });

  it("is the job's own, never another's whose label starts or ends with it", () => {
    for (const other of [`${LABEL}.helper`, `x.${LABEL}`, LABEL.toUpperCase(), ` ${LABEL}`, `${LABEL} `]) {
      expect(disabledIn(listed(`"${other}" => disabled`))).toBe(false);
    }
    // Nor in another list, or after the list.
    const elsewhere = `\tother services = {\n\t\t"${LABEL}" => disabled\n\t}\n`;
    expect(disabledIn(elsewhere)).toBeNull();
    expect(disabledIn(elsewhere + listed())).toBe(false);
    expect(disabledIn(listed() + elsewhere)).toBe(false);
    expect(disabledIn(`${listed()}"${LABEL}" => disabled\n`)).toBe(false);
  });

  it("is unknown from output it doesn't know", () => {
    for (const output of ["", "\n", `"${LABEL}" => disabled\n`, "disabled services = {\n"]) {
      // The last: a list it never saw the end of, which doesn't name the job.
      expect(disabledIn(output)).toBe(output.startsWith("disabled") ? false : null);
    }
    for (const value of ["off", "", "disabled!", "Disabled"]) {
      expect(disabledIn(listed(`"${LABEL}" => ${value}`))).toBeNull();
    }
  });

  it("is asked of the user's own launchd session, and is unknown when launchctl can't say", () => {
    expect(agentDisabled()).toBe(false);
    launchd.switchedOff = true;
    expect(agentDisabled()).toBe(true);
    launchd.switchedOff = false;
    expect(agentDisabled()).toBe(false);
    launchd.printDisabledFails = true;
    expect(agentDisabled()).toBeNull();
    launchd.printDisabledFails = false;
    launchd.disabledOutput = "something a later macOS prints\n";
    expect(agentDisabled()).toBeNull();
    vi.stubEnv("PATH", NO_BIN);
    expect(agentDisabled()).toBeNull();
    const asked = execFileSync.mock.calls.map(([, args]) => (args as string[]).join(" "));
    expect(asked).toEqual(Array(5).fill(`print-disabled ${DOMAIN}`));
  });
});

describe("a job switched off in launchd (engram#654)", () => {
  beforeEach(() => {
    // As `launchctl disable`, or System Settings' Login Items, would leave it.
    launchd.switchedOff = true;
  });

  it("engram start leaves its older or broken plist as it is, and the job launchd has", async () => {
    for (const text of [v1Plist(), plistWith({ node: join(home.dir, "gone", "node") }), "<plist/>"]) {
      writePlist(text);
      // Loaded before it was switched off: launchd keeps it until it is unloaded.
      launchd.loaded = true;
      launchd.loadedText = text;
      daemonGone();
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(launchctlCalls()).toEqual(["list", "print-disabled"]);
      expect(launchd.loadedText).toBe(text);
      expect(said()).not.toContain("Updated auto-start configuration");
    }
    expect(launchd.switchedOff).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(process.exitCode).toBeUndefined();
  });

  it("engram status says start at login is off, before whether the plist is broken or outdated", async () => {
    for (const text of [plistWith(), v1Plist(), plistWith({ node: join(home.dir, "gone", "node") })]) {
      writePlist(text);
      daemonRunning();
      execFileSync.mockClear();
      await daemonStatus();
      const status = said();
      expect(status).toContain("Auto-start: off — disabled in launchd  ('engram install' turns it back on)");
      expect(status).not.toContain("enabled (launchd)");
      expect(launchctlCalls()).toEqual(["print-disabled"]);
    }
    // Stopped, it isn't something that should be running.
    daemonGone();
    writePlist(plistWith());
    await daemonStatus();
    const text = said();
    expect(text).toContain("Status: stopped");
    expect(text).toContain("Auto-start: off — disabled in launchd");
    expect(text).not.toContain("It should be running");
  });

  it("engram status says start at login is on when launchctl can't say it's off", async () => {
    writePlist(plistWith());
    daemonRunning();
    for (const fails of [{ printDisabledFails: true }, { disabledOutput: "something a later macOS prints\n" }]) {
      Object.assign(launchd, fails);
      await daemonStatus();
      expect(said()).toContain("Auto-start: enabled (launchd)");
    }
  });

  it("engram install switches it back on, then loads it", async () => {
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap"]);
    expect(launchctlArgs()[1]).toEqual(["enable", `${DOMAIN}/${LABEL}`]);
    expect(loads()).toEqual([]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loadedText).toBe(plistWith());
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
    expect(process.exitCode).toBeUndefined();
  });

  it("engram install switches one launchd has loaded back on, and leaves the daemon it runs", async () => {
    writePlist(plistWith());
    launchd.loaded = true;
    launchd.loadedText = plistWith();
    launchd.pid = process.pid;
    daemonRunning();
    await daemonInstall();
    // Then whether launchd runs the daemon that runs: it does (engram#692).
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "list", "list"]);
    expect(output()).not.toContain("wasn't started by launchd");
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");
  });

  it("engram install switches it on with load -w where launchctl enable fails", async () => {
    launchd.enableFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap", "load"]);
    expect(loads()).toEqual([`load -w ${PLIST}`]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
    expect(output()).toContain("Auto-start enabled — daemon will start on login");

    // One launchd has loaded is loaded again, to switch it on. Then whether
    // launchd runs the daemon that runs (engram#692).
    launchd.switchedOff = true;
    daemonRunning();
    execFileSync.mockClear();
    await daemonInstall();
    expect(launchctlCalls()).toEqual([
      "print-disabled",
      "enable",
      "bootout",
      "list",
      "bootstrap",
      "load",
      "list",
      "list",
      "print-disabled",
    ]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("engram install switches it on when launchctl can't say whether it's off", async () => {
    launchd.printDisabledFails = true;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "enable", "bootout", "unload", "list", "bootstrap"]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("engram install doesn't switch on one that is on", async () => {
    launchd.switchedOff = false;
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    launchd.switchedOff = null;
    rmSync(join(home.dir, "Library"), { recursive: true, force: true });
    launchd.loaded = false;
    execFileSync.mockClear();
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
  });

  it("engram start --install switches it back on too", async () => {
    daemonRunning();
    await daemonStart([], { install: "" });
    expect(spawn).not.toHaveBeenCalled();
    // Then whether launchd runs it (engram#641).
    expect(launchctlCalls()).toEqual([
      "print-disabled",
      "enable",
      "bootout",
      "unload",
      "list",
      "bootstrap",
      "list",
      "list",
      "print-disabled",
    ]);
    expect(launchd.switchedOff).toBe(false);
    expect(launchd.loaded).toBe(true);
  });

  it("a repair when launchctl can't say leaves it off all the same: it loads without -w", async () => {
    launchd.printDisabledFails = true;
    writePlist(v1Plist());
    await daemonStart([], {});
    // Written, as for any older plist, and loaded at no login while it is off.
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(loads()).toEqual([`load ${PLIST}`]);
    expect(launchd.switchedOff).toBe(true);
    expect(launchd.loaded).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("engram uninstall leaves the switch as it is", async () => {
    for (const switchedOff of [true, false]) {
      launchd.switchedOff = switchedOff;
      writePlist(plistWith());
      execFileSync.mockClear();
      await daemonUninstall();
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual(["bootout", "unload"]);
      expect(launchd.switchedOff).toBe(switchedOff);
      expect(said()).toContain("Auto-start disabled");
    }
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("leaves its older plist as it is after a command, and says nothing", async () => {
      writePlist(v1Plist());
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
      expect(readFileSync(PLIST, "utf-8")).toBe(v1Plist());
      expect(launchctlCalls()).toEqual(["print-disabled"]);
      expect(launchd.switchedOff).toBe(true);
    });

    it("writes a plist where there is none, leaves it off, and says so once", async () => {
      // launchd keeps the switch after the plist is gone, as after `engram uninstall`.
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      // And whether launchd has the job, to start the daemon (engram#641): it hasn't.
      expect(launchctlCalls()).toEqual(["print-disabled", "list"]);
      expect(launchd.loaded).toBe(false);
      expect(launchd.switchedOff).toBe(true);
      const text = said();
      expect(text).toContain("Start at login is switched off in launchd");
      expect(text).toContain("Run 'engram install' to start the daemon when you log in.");
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("Auto-start enabled");

      // Then nothing more: the plist is current, and launchctl isn't asked.
      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await autoEnableCapture({ after: "command" });
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("says so after any other command too, then nothing more", async () => {
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(spawn).not.toHaveBeenCalled();
      const text = said();
      expect(text).toContain("Start at login is switched off in launchd");
      expect(text).toContain("Auto-capture is on");
      expect(launchd.loaded).toBe(false);
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
    });

    it("loads it without -w when launchctl can't say whether it's off: one that is on loads, one that is off stays off", async () => {
      launchd.printDisabledFails = true;
      for (const switchedOff of [null, true]) {
        Object.assign(launchd, { switchedOff, loaded: false, loadedText: null });
        rmSync(join(home.dir, "Library"), { recursive: true, force: true });
        daemonRunning();
        execFileSync.mockClear();
        await autoEnableCapture({ after: "command" });
        expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
        expect(said()).toContain("Auto-start enabled");
        if (switchedOff === null) {
          expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap"]);
          expect(launchd.loaded).toBe(true);
        } else {
          expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "load"]);
          expect(loads()).toEqual([`load ${PLIST}`]);
          expect(launchd.switchedOff).toBe(true);
          expect(launchd.loaded).toBe(false);
        }
      }
    });
  });
});

describe("the vault key a daemon started at login reads, on macOS (engram#690)", () => {
  const VAULT_KEY = join(ENGRAM_DIR, "vault-key");
  /** The key in ENGRAM_VAULT_KEY here, and another. */
  const KEY = Buffer.alloc(32, 7).toString("base64");
  const OTHER = Buffer.alloc(32, 9).toString("base64");
  /** The first line of what is said when the file isn't there, and when it holds another key. */
  const NONE = "  WARNING: ENGRAM_VAULT_KEY is set here, but ~/.engram/vault-key isn't there.";
  const DIFFERENT = "  WARNING: ~/.engram/vault-key holds a different vault key from ENGRAM_VAULT_KEY.";

  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "1");
    vi.stubEnv("ENGRAM_VAULT_KEY", KEY);
    rmSync(VAULT_KEY, { recursive: true, force: true });
  });

  afterEach(() => rmSync(VAULT_KEY, { recursive: true, force: true }));

  function saveKey(text: string): void {
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(VAULT_KEY, text, { mode: 0o600 });
  }

  /** The lines said. */
  function lines(): string[] {
    return output().split("\n");
  }

  it("engram start has launchd start the daemon when ~/.engram/vault-key holds the key set here, as it is written here", async () => {
    jobLoaded();
    for (const saved of [`${KEY}\n`, `  ${KEY}\n\n`, KEY]) {
      saveKey(saved);
      daemonGone();
      execFileSync.mockClear();
      await daemonStart([], {});
      expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
      expect(spawn).not.toHaveBeenCalled();
      const text = said();
      expect(text).toContain(`Engram daemon started (pid ${process.pid})`);
      expect(text).not.toContain("ENGRAM_VAULT_KEY");
    }
  });

  it("engram start starts the daemon itself otherwise: launchd's would have no key, another, or this one written another way", async () => {
    jobLoaded();
    for (const saved of [null, `${OTHER}\n`, `${KEY.replace(/=+$/, "")}\n`, "", "folder"]) {
      rmSync(VAULT_KEY, { recursive: true, force: true });
      if (saved === "folder") mkdirSync(VAULT_KEY, { recursive: true });
      else if (saved !== null) saveKey(saved);
      daemonGone();
      execFileSync.mockClear();
      spawn.mockClear();
      await daemonStart([], {});
      // Only the look for a daemon launchd runs.
      expect(launchctlCalls()).toEqual(["list"]);
      expect(spawn).toHaveBeenCalledTimes(1);
      said();
    }
  });

  it("engram install warns, after the plist, when the file isn't there or holds another key", async () => {
    for (const saved of [null, `${OTHER}\n`]) {
      rmSync(join(home.dir, "Library"), { recursive: true, force: true });
      Object.assign(launchd, { loaded: false, loadedText: null });
      rmSync(VAULT_KEY, { force: true });
      if (saved !== null) saveKey(saved);
      await daemonInstall();
      const shown = lines();
      const at = shown.indexOf(saved === null ? NONE : DIFFERENT);
      expect(at).toBeGreaterThan(shown.indexOf(`Plist: ${PLIST}`));
      expect(shown[at - 1]).toBe("");
      expect(shown.indexOf(saved === null ? DIFFERENT : NONE)).toBe(-1);
      expect(said()).not.toContain(OTHER.slice(0, 12));
    }
    expect(spawn).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("engram install says nothing of the key when the file holds it", async () => {
    saveKey(`${KEY}\n`);
    await daemonInstall();
    expect(launchctlCalls()).toEqual(["print-disabled", "bootout", "unload", "list", "bootstrap"]);
    expect(output()).toContain(`Plist: ${PLIST}`);
    expect(output()).not.toContain("ENGRAM_VAULT_KEY");
  });

  it("engram status warns when start at login is on, and not when it is switched off in launchd", async () => {
    writePlist(plistWith());
    daemonRunning();
    await daemonStatus();
    expect(lines()).toContain(NONE);
    // Whether it is on is asked of launchd once, as before.
    expect(launchctlCalls()).toEqual(["print-disabled"]);

    said();
    launchd.switchedOff = true;
    await daemonStatus();
    const text = said();
    expect(text).toContain("Auto-start: off — disabled in launchd");
    expect(text).not.toContain("ENGRAM_VAULT_KEY");
  });

  it("engram status says nothing of the key without a plist, or with a broken one, running or stopped", async () => {
    for (const plist of [null, plistWith({ node: join(home.dir, "gone", "node") })]) {
      for (const running of [true, false]) {
        rmSync(PLIST, { force: true });
        if (plist !== null) writePlist(plist);
        if (running) daemonRunning();
        else daemonGone();
        await daemonStatus();
        const text = said();
        expect(text).toContain(running ? "Status: running" : "Status: stopped");
        expect(text).not.toContain("It should be running");
        expect(text).not.toContain("ENGRAM_VAULT_KEY");
      }
    }
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("has launchd start the daemon when the file holds the key set here", async () => {
      saveKey(`${KEY}\n`);
      await autoEnableCapture({ after: "login" });
      expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "list", "print-disabled", "kickstart"]);
      expect(spawn).not.toHaveBeenCalled();
      expect(launchd.pid).toBe(process.pid);
      const text = said();
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("ENGRAM_VAULT_KEY");
    });

    it("else starts it itself, turns on start at login, and warns", async () => {
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      // And whether start at login is on, asked once there is something to say.
      expect(launchctlCalls()).toEqual(["print-disabled", "bootstrap", "print-disabled"]);
      const shown = lines();
      expect(shown.indexOf(NONE)).toBeGreaterThan(shown.indexOf("  Turn off anytime: engram stop && engram uninstall"));
    });

    it("says nothing of the key when start at login is switched off in launchd", async () => {
      launchd.switchedOff = true;
      daemonRunning();
      await autoEnableCapture({ after: "login" });
      const text = said();
      expect(text).toContain("Start at login is switched off in launchd");
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("ENGRAM_VAULT_KEY");
    });
  });
});

describe("a CLI and a Node installed with brew (engram#652)", () => {
  // A Homebrew prefix as `brew install node engram` leaves one: each version
  // in its keg under Cellar/, and opt/<formula> a link to the current one.
  // Homebrew's Node gives its keg as process.execPath, and a CLI installed
  // with brew runs from its own: the next `brew upgrade` removes both.
  // Links: Windows makes them only with a privilege.
  const BREW = join(realpathSync.native(home.dir), "brew");
  const IN_KEG = ["libexec", "lib", "node_modules", "@getengram", "cli", "dist", "daemon", "worker.js"];
  const KEG = {
    node: join(BREW, "Cellar", "node", "25.1.0", "bin", "node"),
    worker: join(BREW, "Cellar", "engram", "0.7.0", ...IN_KEG),
  };
  /** A version brew keeps until its cleanup, which opt/node no longer leads to. */
  const OLDER_NODE = join(BREW, "Cellar", "node", "25.0.0", "bin", "node");
  const OPT = {
    node: join(BREW, "opt", "node", "bin", "node"),
    worker: join(BREW, "opt", "engram", ...IN_KEG),
  };
  /** The plist the CLI brew installed writes: Node and the worker through the opt links. */
  const THROUGH_OPT: Partial<PlistPaths> = {
    ...OPT,
    path: `${dirname(OPT.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  /** The one the same CLI wrote before engram#652: the kegs themselves. */
  const IN_KEGS: Partial<PlistPaths> = {
    ...KEG,
    path: `${dirname(KEG.node)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  };

  beforeAll(() => {
    if (HOST === "win32") return;
    for (const file of [KEG.node, KEG.worker, OLDER_NODE]) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, "");
    }
    mkdirSync(join(BREW, "opt"));
    symlinkSync("../Cellar/node/25.1.0", join(BREW, "opt", "node"));
    symlinkSync("../Cellar/engram/0.7.0", join(BREW, "opt", "engram"));
  });

  /** Run as the CLI brew installed does: on Homebrew's Node, with this build in its keg. */
  async function asBrewCli(run: () => unknown, node = KEG.node): Promise<void> {
    const execPath = process.execPath;
    process.execPath = node;
    cli.worker = KEG.worker;
    try {
      await run();
    } finally {
      process.execPath = execPath;
      cli.worker = null;
    }
  }

  posixIt("engram install names Node and the worker through the opt links, which outlast the next upgrade", async () => {
    await asBrewCli(() => daemonInstall());
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    expect(said()).toContain("Auto-start enabled — daemon will start on login");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("finds a plist naming either keg outdated, not broken: it works only until the next upgrade", () => {
    for (const pinned of [IN_KEGS, { node: KEG.node }, { worker: KEG.worker }]) {
      writePlist(plistWith(pinned));
      expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: true });
    }
    writePlist(plistWith(THROUGH_OPT));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
  });

  posixIt("finds one naming a version the upgrade removed broken, as before; leaves a newer CLI's to it", () => {
    writePlist(plistWith({ node: join(BREW, "Cellar", "node", "24.0.0", "bin", "node") }));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: false });
    writePlist(plistWith(IN_KEGS, PLIST_VERSION + 1));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION + 1, outdated: false });
  });

  posixIt("engram status says one naming the kegs is outdated, until engram install rewrites it", async () => {
    writePlist(plistWith(IN_KEGS));
    daemonRunning();
    await daemonStatus();
    expect(said()).toContain("Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update");
    await asBrewCli(() => daemonInstall());
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    said();
    await daemonStatus();
    const after = said();
    expect(after).toContain("Auto-start: enabled (launchd)");
    expect(after).not.toMatch(/broken|outdated/);
  });

  posixIt("engram start rewrites one naming the kegs, once, and launchd loads it in its place", async () => {
    writePlist(plistWith(IN_KEGS));
    launchd.loaded = true;
    launchd.loadedText = plistWith(IN_KEGS);
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
    // Then launchd starts the daemon (engram#641).
    expect(launchctlCalls()).toEqual([
      "list",
      "print-disabled",
      "bootout",
      "list",
      "bootstrap",
      "list",
      "print-disabled",
      "kickstart",
      "list",
    ]);
    expect(said()).toContain(`Updated auto-start configuration (plist v${PLIST_VERSION})`);

    // Current from then on, and launchd's to start.
    daemonGone();
    execFileSync.mockClear();
    await asBrewCli(() => daemonStart([], {}));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    expect(launchctlCalls()).toEqual(["list", "list", "print-disabled", "kickstart", "list"]);
    expect(spawn).not.toHaveBeenCalled();
    expect(said()).not.toContain("Updated auto-start configuration");
    expect(process.exitCode).toBeUndefined();
  });

  posixIt("engram start from a CLI brew didn't install points the plist at that CLI, as with an older plist", async () => {
    writePlist(plistWith(IN_KEGS));
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(said()).toContain("Updated auto-start configuration");
  });

  posixIt("names a Node version opt/node no longer leads to as it is, and leaves that plist be", async () => {
    const ownPath: Partial<PlistPaths> = {
      node: OLDER_NODE,
      worker: OPT.worker,
      path: `${dirname(OLDER_NODE)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    };
    await asBrewCli(() => daemonInstall(), OLDER_NODE);
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(ownPath));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: false });
    // Never rewritten again and again: what it writes reads as current.
    daemonGone();
    said();
    await asBrewCli(() => daemonStart([], {}), OLDER_NODE);
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(ownPath));
    expect(said()).not.toContain("Updated auto-start configuration");
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    posixIt("rewrites one naming the kegs after a command, says so once, then nothing", async () => {
      writePlist(plistWith(IN_KEGS));
      launchd.loaded = true;
      launchd.loadedText = plistWith(IN_KEGS);
      daemonRunning();
      await asBrewCli(() => autoEnableCapture({ after: "command" }));
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
      expect(launchd.loadedText).toBe(plistWith(THROUGH_OPT));
      const text = said();
      expect(text).toContain("Updated auto-start configuration");
      expect(text).toContain("Auto-capture is on");

      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await asBrewCli(() => autoEnableCapture({ after: "command" }));
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(THROUGH_OPT));
    });
  });
});

describe("a CLI run from npx's cache (engram#665)", () => {
  // `npx @getengram/cli …` runs the CLI from npx's cache, which npm clears
  // as it likes: a newer version of the package, or `npm cache clean`. A
  // plist naming the worker there would then stop starting the daemon at
  // login, without a word. So would one pnpm dlx, bunx or yarn dlx left.
  const NPX_WORKER = join(
    home.dir,
    ".npm",
    "_npx",
    "f3920abdac2db749",
    "node_modules",
    "@getengram",
    "cli",
    "dist",
    "daemon",
    "worker.js",
  );
  /** The plist an npx run wrote before engram#665: it works until npm clears its cache. */
  const FROM_NPX: Partial<PlistPaths> = { worker: NPX_WORKER };
  /** One npm cleared since: the worker it names is gone. */
  const CLEARED: Partial<PlistPaths> = {
    worker: join(home.dir, ".npm", "_npx", "0123456789abcdef", "node_modules", "@getengram", "cli", "dist", "daemon", "worker.js"),
  };
  /** One that can't start the daemon: the CLI it names has moved. */
  const BROKEN: Partial<PlistPaths> = { worker: join(home.dir, "moved", "cli", "dist", "daemon", "worker.js") };
  const CANT_TURN_ON = [
    "Can't turn on start at login: this Engram runs from npx's cache, which can be cleared at any time.",
    "  Install the CLI with: npm install -g @getengram/cli",
  ];
  const CANT_REPAIR = [
    "Can't repair start at login: this Engram runs from npx's cache, which can be cleared at any time.",
    "  Install the CLI with: npm install -g @getengram/cli",
    "  Then run: engram install",
  ].join("\n");
  const WONT_START_AT_LOGIN = [
    "  The daemon won't start at login: this Engram runs from npx's cache, which can be cleared at any time.",
    "  To start it at login, install the CLI: npm install -g @getengram/cli && engram install",
  ].join("\n");

  beforeAll(() => {
    mkdirSync(dirname(NPX_WORKER), { recursive: true });
    writeFileSync(NPX_WORKER, "");
  });

  beforeEach(() => {
    vi.mocked(saveConfig).mockClear();
  });

  /** Run as `npx @getengram/cli` does: this build, in npx's cache. */
  async function fromNpx(run: () => unknown, worker = NPX_WORKER): Promise<void> {
    cli.worker = worker;
    try {
      await run();
    } finally {
      cli.worker = null;
    }
  }

  /** launchctl only looked: it loaded, unloaded, started and switched nothing. */
  function launchdLeftAlone(): void {
    expect(launchctlCalls().filter((call) => call !== "list" && call !== "print-disabled")).toEqual([]);
  }

  it("engram install turns nothing on, records nothing, and says how to install the CLI", async () => {
    await fromNpx(() => daemonInstall());
    expect(existsSync(PLIST)).toBe(false);
    expect(launchctlCalls()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(said()).toBe([...CANT_TURN_ON, "  Then run: engram install"].join("\n"));
    expect(process.exitCode).toBe(1);
  });

  it("names the cache of the runner it runs from: pnpm dlx's", async () => {
    const pnpm = join(home.dir, "Library", "Caches", "pnpm", "dlx", "t2vhrsiwfyb5ug4cvmxu7uvwla", "19a6c1f5e2b-1c4d");
    const inStore = ["node_modules", ".pnpm", "@getengram+cli@0.7.0", "node_modules", "@getengram", "cli"];
    await fromNpx(() => daemonInstall(), join(pnpm, ...inStore, "dist", "daemon", "worker.js"));
    expect(existsSync(PLIST)).toBe(false);
    expect(said()).toContain(
      "Can't turn on start at login: this Engram runs from pnpm's dlx cache, which can be cleared at any time.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("engram start --install starts nothing and changes nothing, a broken plist included", async () => {
    writePlist(plistWith(BROKEN));
    await fromNpx(() => daemonStart([], { install: "" }));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(BROKEN));
    expect(launchctlCalls()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(said()).toBe([...CANT_TURN_ON, "  Then run: engram start --install"].join("\n"));
    expect(process.exitCode).toBe(1);
  });

  it("engram start starts the daemon, and says nothing of start at login when there is none", async () => {
    await fromNpx(() => daemonStart([], {}));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(existsSync(PLIST)).toBe(false);
    launchdLeftAlone();
    const text = said();
    expect(text).toContain("Engram daemon started");
    expect(text).not.toContain("start at login");
    expect(process.exitCode).toBeUndefined();
  });

  it("engram start leaves a broken plist as it is, and says why it can't repair it", async () => {
    for (const broken of [BROKEN, CLEARED]) {
      writePlist(plistWith(broken));
      daemonGone();
      spawn.mockClear();
      execFileSync.mockClear();
      await fromNpx(() => daemonStart([], {}));
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(broken));
      launchdLeftAlone();
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = said();
      expect(text).toContain(CANT_REPAIR);
      expect(text).toContain("Engram daemon started");
      expect(text).not.toContain("Updated auto-start configuration");
      expect(process.exitCode).toBeUndefined();
    }
  });

  it("engram start says nothing of a broken one switched off in launchd: only engram install turns it on", async () => {
    writePlist(plistWith(BROKEN));
    launchd.switchedOff = true;
    await fromNpx(() => daemonStart([], {}));
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(BROKEN));
    launchdLeftAlone();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("Can't repair start at login");
  });

  it("engram start leaves a plist that works as it is, without a word: an older CLI's, or an npx run's", async () => {
    for (const text of [v1Plist(), plistWith(FROM_NPX)]) {
      writePlist(text);
      daemonGone();
      execFileSync.mockClear();
      await fromNpx(() => daemonStart([], {}));
      expect(readFileSync(PLIST, "utf-8")).toBe(text);
      expect(launchctlCalls()).not.toContain("bootout");
      expect(launchctlCalls()).not.toContain("bootstrap");
      const out = said();
      expect(out).toContain("Engram daemon started");
      expect(out).not.toContain("Can't repair start at login");
      expect(out).not.toContain("Updated auto-start configuration");
    }
  });

  it("finds a plist naming the worker in npx's cache outdated, not broken, until npm clears it", () => {
    writePlist(plistWith(FROM_NPX));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION, outdated: true });
    writePlist(plistWith(CLEARED));
    expect(readPlist()).toEqual({ kind: "ours", broken: true, version: PLIST_VERSION, outdated: true });
    // A newer CLI's is its own to judge.
    writePlist(plistWith(FROM_NPX, PLIST_VERSION + 1));
    expect(readPlist()).toEqual({ kind: "ours", broken: false, version: PLIST_VERSION + 1, outdated: false });
  });

  it("engram status says such a plist is outdated, until the installed CLI's engram install rewrites it", async () => {
    writePlist(plistWith(FROM_NPX));
    daemonRunning();
    await daemonStatus();
    expect(said()).toContain("Auto-start: enabled (launchd)  — outdated config, run 'engram install' to update");
    await daemonInstall();
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    said();
    await daemonStatus();
    const after = said();
    expect(after).toContain("Auto-start: enabled (launchd)");
    expect(after).not.toMatch(/broken|outdated/);
  });

  it("the installed CLI's engram start points it at that CLI, once, and launchd loads it in its place", async () => {
    writePlist(plistWith(FROM_NPX));
    launchd.loaded = true;
    launchd.loadedText = plistWith(FROM_NPX);
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(launchd.loadedText).toBe(plistWith());
    expect(said()).toContain(`Updated auto-start configuration (plist v${PLIST_VERSION})`);

    daemonGone();
    await daemonStart([], {});
    expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
    expect(said()).not.toContain("Updated auto-start configuration");
    expect(process.exitCode).toBeUndefined();
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    it("after sign-in starts the daemon, sets up no start at login, and says why, then nothing more", async () => {
      await fromNpx(() => autoEnableCapture({ after: "login" }));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual([]);
      expect(said()).toBe(
        [
          "Auto-capture is on — conversations from supported agents on this machine save to your Engram.",
          WONT_START_AT_LOGIN,
          "  Turn off anytime: engram stop && engram uninstall",
        ].join("\n"),
      );

      for (let command = 0; command < 3; command++) {
        await fromNpx(() => autoEnableCapture({ after: "command" }));
        expect(said()).toBe("");
      }
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(PLIST)).toBe(false);
      expect(launchctlCalls()).toEqual([]);
    });

    it("says it after a command that had to start the daemon: what start at login would have done", async () => {
      await fromNpx(() => autoEnableCapture({ after: "command" }));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(existsSync(PLIST)).toBe(false);
      const text = said();
      expect(text).toContain("Auto-capture is on");
      expect(text).toContain(WONT_START_AT_LOGIN);
    });

    it("leaves a broken plist as it is, and says why", async () => {
      writePlist(plistWith(BROKEN));
      await fromNpx(() => autoEnableCapture({ after: "login" }));
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(BROKEN));
      launchdLeftAlone();
      expect(spawn).toHaveBeenCalledTimes(1);
      const text = said();
      expect(text).toContain(WONT_START_AT_LOGIN);
      expect(text).not.toContain("Updated auto-start configuration");
    });

    it("leaves a plist that works as it is, and says nothing of start at login", async () => {
      writePlist(plistWith(FROM_NPX));
      daemonRunning();
      await fromNpx(() => autoEnableCapture({ after: "login" }));
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith(FROM_NPX));
      const text = said();
      expect(text).toContain("Auto-capture is on");
      expect(text).not.toContain("start at login");
      expect(text).not.toContain("Updated auto-start configuration");
    });

    it("from the installed CLI, points an npx run's plist at that CLI after a command, says so once, then nothing", async () => {
      writePlist(plistWith(FROM_NPX));
      launchd.loaded = true;
      launchd.loadedText = plistWith(FROM_NPX);
      daemonRunning();
      await autoEnableCapture({ after: "command" });
      expect(readFileSync(PLIST, "utf-8")).toBe(plistWith());
      expect(launchd.loadedText).toBe(plistWith());
      const text = said();
      expect(text).toContain("Updated auto-start configuration");
      expect(text).toContain("Auto-capture is on");

      execFileSync.mockClear();
      for (let command = 0; command < 3; command++) {
        await autoEnableCapture({ after: "command" });
        expect(said()).toBe("");
      }
      expect(execFileSync).not.toHaveBeenCalled();
    });
  });
});

describe("a daemon left running as root (engram#680)", () => {
  // Root's is another user's only for a user who isn't root, and Windows
  // has no uid to tell them apart by.
  const me = process.geteuid?.();
  const rootIt = me === undefined || me === 0 ? it.skip : it;
  /** The daemon `sudo engram start` or `sudo engram install` left running as root. */
  const ROOT = 40_301;
  /** The user's own daemon. */
  const OWN = 40_302;
  /** Another daemon running as root. */
  const OTHER_ROOT = 40_303;
  const PROBLEM = `A daemon started with sudo is still running as root (pid ${ROOT}).`;
  const UNLOAD = "sudo launchctl bootout system/app.getengram.daemon";
  const KILL = `Stop it with: sudo kill ${ROOT}`;
  const BOOTOUT = `Stop it with: ${UNLOAD}`;
  const ALSO_UNLOAD = `Also unload the job 'sudo engram install' loaded into launchd's system domain: ${UNLOAD}`;
  const JOB_LEFT = `The job 'sudo engram install' loaded into launchd's system domain is still there, and would run the daemon as root. Unload it with: ${UNLOAD}`;

  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "1");
  });

  /** `sudo engram install` before engram#653: its job in launchd's system domain, and the daemon it runs as root. */
  function inSystemDomain(pid: number | null = ROOT): void {
    launchd.system = { plist: PLIST, pid };
    if (pid !== null) launchd.rootWorkers.push(pid);
  }

  /** `sudo engram start` before engram#653: the daemon running as root, and its PID file. */
  function startedWithSudo(): void {
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(ROOT));
    launchd.rootWorkers.push(ROOT);
  }

  /** The user's own daemon, running beside it. */
  function ownRunning(): void {
    madeUp.add(OWN);
    mkdirSync(ENGRAM_DIR, { recursive: true });
    writeFileSync(PID_FILE, String(OWN));
    daemon.answering = { pid: OWN };
  }

  /** Signals sent, but signal 0, which only looks. */
  function signalsSent(): unknown[][] {
    return vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0);
  }

  /** No daemon was started, and start at login wasn't turned on. */
  function nothingStarted(): void {
    expect(spawn).not.toHaveBeenCalled();
    expect(launchctlCalls()).toEqual([]);
    expect(existsSync(PLIST)).toBe(false);
  }

  rootIt("status says it runs as root, and to stop it through launchd, which runs it", async () => {
    inSystemDomain();
    await daemonStatus();
    const text = said();
    expect(text).toContain(`Status: running as root (pid ${ROOT}), started with sudo`);
    expect(text).toContain(
      `\n\n  ${PROBLEM} 'engram stop' can't stop it, and no daemon of yours starts while it runs.\n  ${BOOTOUT}\n  Then run: engram start\n\n`,
    );
    expect(text).not.toMatch(/sudo kill|Also unload|most likely/);
    expect(signalsSent()).toEqual([]);
    expect(launchctlCalls()).toEqual([]);
  });

  rootIt("start, start --install, install and stop leave it, change nothing, and say what to run", async () => {
    inSystemDomain();
    await daemonStart([], {});
    expect(said()).toBe(
      [`${PROBLEM} No daemon of yours starts while it runs.`, `  ${BOOTOUT}`, "  Then run 'engram start' again."].join("\n"),
    );
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await daemonStart([], { install: "" });
    expect(said()).toBe(
      [
        `${PROBLEM} No daemon of yours starts while it runs.`,
        `  ${BOOTOUT}`,
        "  Then run 'engram start --install' again.",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await daemonInstall();
    expect(said()).toBe(
      [
        `${PROBLEM} Start at login wasn't turned on: no daemon of yours starts while it runs.`,
        `  ${BOOTOUT}`,
        "  Then run 'engram install' again.",
      ].join("\n"),
    );
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    await daemonStop();
    expect(said()).toBe([`${PROBLEM} 'engram stop' can't stop it.`, `  ${BOOTOUT}`].join("\n"));
    expect(process.exitCode).toBe(1);

    nothingStarted();
    expect(signalsSent()).toEqual([]);
    expect(launchd.system).toEqual({ plist: PLIST, pid: ROOT });
  });

  rootIt("keeps the PID file of one started with sudo, and says to kill it", async () => {
    startedWithSudo();
    await daemonStatus();
    const text = said();
    expect(text).toContain(`Status: running as root (pid ${ROOT}), started with sudo`);
    expect(text).toContain(`\n  ${PROBLEM} 'engram stop' can't stop it, and no daemon of yours starts while it runs.\n  ${KILL}\n  Then run: engram start\n`);

    await daemonStart([], {});
    expect(said()).toBe(
      [`${PROBLEM} No daemon of yours starts while it runs.`, `  ${KILL}`, "  Then run 'engram start' again."].join("\n"),
    );
    process.exitCode = undefined;
    await daemonStop();
    expect(said()).toBe([`${PROBLEM} 'engram stop' can't stop it.`, `  ${KILL}`].join("\n"));
    expect(process.exitCode).toBe(1);

    expect(readFileSync(PID_FILE, "utf-8")).toBe(String(ROOT));
    nothingStarted();
    expect(signalsSent()).toEqual([]);
  });

  rootIt("says to unload a job left in launchd's system domain too, when it doesn't run that one", async () => {
    startedWithSudo();
    for (const job of [null, OTHER_ROOT]) {
      launchd.rootWorkers = [ROOT];
      inSystemDomain(job);
      await daemonStatus();
      const text = said();
      expect(text).toContain(`\n  ${KILL}\n  ${ALSO_UNLOAD}\n  Then run: engram start\n`);
      // The job's daemon is said with the job.
      expect(text).not.toContain("most likely");
      process.exitCode = undefined;
      await daemonStop();
      expect(said()).toBe([`${PROBLEM} 'engram stop' can't stop it.`, `  ${KILL}`, `  ${ALSO_UNLOAD}`].join("\n"));
    }
    expect(signalsSent()).toEqual([]);
  });

  rootIt("status says a job left in launchd's system domain would run one; start goes ahead", async () => {
    inSystemDomain(null);
    await daemonStatus();
    const text = said();
    expect(text).toBe(`Status: stopped\n\n  ${JOB_LEFT}\n`);
    expect(text).not.toContain(PROBLEM);

    await daemonStart([], {});
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).not.toContain("root");
    expect(process.exitCode).toBeUndefined();
  });

  rootIt("status and stop say one running as root beside the user's; stop stops theirs and exits 1", async () => {
    inSystemDomain();
    ownRunning();
    await daemonStatus();
    const text = said();
    expect(text).toContain(`Status: running (pid ${OWN})`);
    expect(text).toContain(`\n\n  ${PROBLEM} It runs beside yours, and only one should.\n  ${BOOTOUT}\n\n`);
    expect(text).not.toMatch(/Then run|most likely/);

    // Theirs stops as a daemon does.
    vi.mocked(process.kill).mockImplementation((pid: number, signal?: string | number) => {
      if (pid === OWN && signal === "SIGTERM") {
        madeUp.delete(OWN);
        daemon.answering = null;
        return true;
      }
      return fakeKill(pid, signal);
    });
    await daemonStop();
    expect(said()).toBe([`Daemon stopped (pid ${OWN})`, `${PROBLEM} 'engram stop' can't stop it.`, `  ${BOOTOUT}`].join("\n"));
    expect(process.exitCode).toBe(1);
    expect(signalsSent()).toEqual([[OWN, "SIGTERM"]]);
    expect(existsSync(PID_FILE)).toBe(false);
  });

  rootIt("stop stops theirs, then says the one the PID file names and the job's, each once", async () => {
    // The PID file names one started with sudo, the job in launchd's system
    // domain runs another, and the user's own answers on the socket.
    inSystemDomain(OTHER_ROOT);
    ownRunning();
    startedWithSudo();
    vi.mocked(process.kill).mockImplementation((pid: number, signal?: string | number) => {
      if (pid === OWN && signal === "SIGTERM") {
        madeUp.delete(OWN);
        daemon.answering = null;
        return true;
      }
      return fakeKill(pid, signal);
    });
    await daemonStop();
    // Neither is said again as one that nothing ties to the user.
    expect(said()).toBe(
      [`Daemon stopped (pid ${OWN})`, `${PROBLEM} 'engram stop' can't stop it.`, `  ${KILL}`, `  ${ALSO_UNLOAD}`].join("\n"),
    );
    expect(process.exitCode).toBe(1);
    expect(signalsSent()).toEqual([[OWN, "SIGTERM"]]);
    expect(readFileSync(PID_FILE, "utf-8")).toBe(String(ROOT));
  });

  rootIt("says one running as root that nothing ties to the user, and starts theirs all the same", async () => {
    launchd.rootWorkers = [ROOT];
    const untied = `A daemon is running as root (pid ${ROOT}), most likely started with sudo. Stop it with: sudo kill ${ROOT}`;
    await daemonStatus();
    const text = said();
    expect(text).toBe(`Status: stopped\n\n  ${untied}\n`);
    expect(text).not.toContain(PROBLEM);

    await daemonStop();
    expect(said()).toBe(["Daemon is not running.", untied].join("\n"));
    expect(process.exitCode).toBeUndefined();

    await daemonStart([], {});
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(said()).toContain(untied);
    expect(process.exitCode).toBeUndefined();
    expect(signalsSent()).toEqual([]);
  });

  describe("auto-capture", () => {
    signedInAtATerminal();

    rootIt("isn't turned on while one runs: after sign-in it says why, after a command nothing", async () => {
      inSystemDomain();
      await autoEnableCapture({ after: "login" });
      expect(said()).toBe(
        [`  Auto-capture wasn't turned on. ${PROBLEM}`, `  ${BOOTOUT}`, "  Then run: engram start"].join("\n"),
      );
      await autoEnableCapture({ after: "command" });
      expect(said()).toBe("");
      nothingStarted();
      expect(signalsSent()).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });
  });
});

describe("the plist, as macOS reads it (engram#616)", () => {
  // Read-only: plutil on files in the test's own temp home. launchd itself
  // reads plists through libxpc, which reads what generatePlist() writes
  // back the same (checked by hand: see the PR for engram#616).
  macIt("is one plutil reads, with every path in it as it is", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const dir = join(home.dir, "plutil");
    mkdirSync(dir, { recursive: true });
    for (const [i, odd] of [
      "/Users/A&B",
      "/Users/a<b>c",
      `/Users/"double" 'single'`,
      "/Users/&amp;",
      "/Users/x]]>y",
      "/Users/Jürgen 😀",
    ].entries()) {
      const paths: PlistPaths = { ...THIS_CLI, home: odd, path: `${odd}/bin:/usr/bin:/bin` };
      const file = join(dir, `${i}.plist`);
      writeFileSync(file, generatePlist(paths));
      real.execFileSync("/usr/bin/plutil", ["-lint", "-s", file], { stdio: "pipe" });
      const read = JSON.parse(
        real.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf-8", stdio: "pipe" }),
      );
      expect(read).toEqual({
        Label: LABEL,
        ProgramArguments: [paths.node, paths.worker],
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        StandardOutPath: paths.log,
        StandardErrorPath: paths.log,
        ThrottleInterval: 10,
        EnvironmentVariables: { HOME: odd, PATH: paths.path, ENGRAM_PLIST_VERSION: String(PLIST_VERSION) },
      });
    }
  });

  macIt("is one plutil reads without a log too, with no output file in it (engram#679)", async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const dir = join(home.dir, "plutil");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "no-log.plist");
    writeFileSync(file, generatePlist({ ...THIS_CLI, log: null }));
    real.execFileSync("/usr/bin/plutil", ["-lint", "-s", file], { stdio: "pipe" });
    const read = JSON.parse(
      real.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf-8", stdio: "pipe" }),
    );
    expect(read).toEqual({
      Label: LABEL,
      ProgramArguments: [THIS_CLI.node, THIS_CLI.worker],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 10,
      EnvironmentVariables: { HOME: home.dir, PATH: THIS_CLI.path, ENGRAM_PLIST_VERSION: String(PLIST_VERSION) },
    });
  });
});
