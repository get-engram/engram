import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForeignFiles } from "../daemon/ownership.js";

/**
 * engram#680 — a daemon left running as root in the user's ~/.engram, which
 * `sudo engram start` or `sudo engram install` started before engram#653:
 * how one is told from the user's own daemon and from other programs, where
 * it is found (the PID file, launchd's system domain, ps, /proc), and what
 * the CLI says of it.
 *
 * Every process here is made up: ps, launchctl, /proc and signal 0 are
 * fakes, and the home is a temp dir. No process is signalled, and nothing
 * reaches the real ~/.engram, launchd or /proc. The macOS and Linux paths
 * run on any OS: each test sets process.platform, and the user it runs as.
 */

const { home, fake } = vi.hoisted(() => ({
  home: { dir: "" },
  fake: {
    /** The processes ps, /proc and signal 0 know of, by PID: who runs them, and their command line. */
    processes: new Map<number, { uid: number; args: string }>(),
    /** Listed in /proc, and gone by the time they are looked at. */
    vanished: new Set<number>(),
    /** Their files in /proc can't be read. */
    unreadable: new Set<number>(),
    /** /proc can't be listed. */
    procUnlisted: false,
    /** How ps fails, when it does: as for no such process (exit 1), or as one timed out does. */
    psFails: null as "exit" | "timeout" | null,
    /** What `launchctl print system/app.getengram.daemon` prints; null: launchd has no such job (exit 113). */
    systemPrint: null as string | null,
    /** What was read of /proc, in order. */
    reads: [] as string[],
    /** Calls the fakes didn't expect; each fails the test (the code under test catches what they throw). */
    unexpected: [] as string[],
  },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const failed = (status: number | null, stderr = ""): Error =>
    Object.assign(new Error("Command failed"), { status, stderr });
  const execFileSync = vi.fn((file: string, args: readonly string[] = []): string => {
    const command = args.join(" ");
    if (file === "/bin/ps") {
      if (fake.psFails === "timeout") throw Object.assign(failed(null), { code: "ETIMEDOUT", signal: "SIGTERM" });
      if (fake.psFails === "exit") throw failed(1);
      const padded = (n: number): string => String(n).padStart(5);
      if (command === "-A -ww -o pid=,uid=,args=") {
        const lines = [...fake.processes].map(([pid, p]) => `${padded(pid)} ${padded(p.uid)} ${p.args}`);
        return `${lines.join("\n")}\n`;
      }
      const one = /^-ww -o uid=,args= -p (\d+)$/.exec(command);
      if (one !== null) {
        const p = fake.processes.get(Number(one[1]));
        // ps exits 1 when there is no such process.
        if (p === undefined) throw failed(1);
        return `${padded(p.uid)} ${p.args}\n`;
      }
    }
    if (/[\\/]launchctl$/.test(file) && command === "print system/app.getengram.daemon") {
      if (fake.systemPrint === null) {
        throw failed(113, 'Could not find service "app.getengram.daemon" in domain for system\n');
      }
      return fake.systemPrint;
    }
    fake.unexpected.push(`${file} ${command}`);
    throw new Error(`unexpected: ${file} ${command}`);
  });
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFileSync };
});

// /proc, as Linux has it, for the made-up processes; every other path is the real one.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const fail = (code: string, path: string): Error => Object.assign(new Error(`${code}: ${path}`), { code });
  const isProc = (path: unknown): path is string => typeof path === "string" && /^\/proc(?:\/|$)/.test(path);
  const processAt = (path: string, pattern: RegExp): { uid: number; args: string } => {
    const pid = Number(pattern.exec(path)?.[1]);
    const p = fake.processes.get(pid);
    if (p === undefined || fake.vanished.has(pid)) throw fail("ENOENT", path);
    if (fake.unreadable.has(pid)) throw fail("EACCES", path);
    return p;
  };
  const stat = (path: string): { uid: number } => {
    fake.reads.push(`stat ${path}`);
    return { uid: processAt(path, /^\/proc\/(\d+)$/).uid };
  };
  const read = (path: string): string => {
    fake.reads.push(`read ${path}`);
    // Its arguments, each ended by a NUL.
    return `${processAt(path, /^\/proc\/(\d+)\/cmdline$/).args.split(" ").join("\0")}\0`;
  };
  const list = (path: string): string[] => {
    fake.reads.push(`list ${path}`);
    if (path !== "/proc" || fake.procUnlisted) throw fail("EACCES", path);
    return ["self", "cpuinfo", ...[...fake.processes.keys()].map(String), "sys"];
  };
  type Fn = (...args: unknown[]) => unknown;
  return {
    ...real,
    statSync: ((path: unknown, ...rest: unknown[]) =>
      isProc(path) ? stat(path) : (real.statSync as Fn)(path, ...rest)) as typeof real.statSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      isProc(path) ? read(path) : (real.readFileSync as Fn)(path, ...rest)) as typeof real.readFileSync,
    readdirSync: ((path: unknown, ...rest: unknown[]) =>
      isProc(path) ? list(path) : (real.readdirSync as Fn)(path, ...rest)) as typeof real.readdirSync,
  };
});

// The real module, with what root-daemon.ts calls made into spies, so a
// test can make one throw.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  return { ...real, rootDaemonPid: vi.fn(real.rootDaemonPid), rootWorkerPids: vi.fn(real.rootWorkerPids) };
});

const HOST = process.platform;
const GETEUID = Object.getOwnPropertyDescriptor(process, "geteuid");

home.dir = mkdtempSync(join(tmpdir(), "engram-680-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const BIN = join(home.dir, "bin");
const LAUNCHCTL = join(BIN, "launchctl");
mkdirSync(ENGRAM_DIR, { recursive: true });
mkdirSync(BIN);
// Never run: execFileSync is the fake above. It is there to be found on PATH.
writeFileSync(LAUNCHCTL, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

const { execFileSync } = await import("node:child_process");
const {
  confirmedDaemonInPidFile,
  daemonInPidFile,
  identifyProcess,
  processKind,
  rootDaemonPid,
  rootWorkerPids,
} = await import("../daemon/instance.js");
const { SYSTEM_JOB, SYSTEM_JOB_UNLOAD, parseSystemJob, plistPath, systemJob } = await import("../daemon/launchd.js");
const { findRootDaemon, rootDaemonLines, rootStopCommand, systemJobLeft, untiedRootLine, untiedRootWorkers } =
  await import("../daemon/root-daemon.js");

/** The user the tests run as. */
const ME = 501;
const WORKER = "/usr/local/lib/node_modules/@getengram/cli/dist/daemon/worker.js";
/** What ps says a daemon runs. */
const RUNS_WORKER = `/usr/local/bin/node ${WORKER}`;
/** What a plist from before 0.4.2 runs (engram#469). */
const RUNS_OLD_WORKER = "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/dist/daemon/worker-main.js";

// Made-up processes: only the fakes know them.
const ROOT_DAEMON = 40_101;
const OLD_ROOT_DAEMON = 40_102;
const OWN_DAEMON = 40_103;
const OTHER_USERS_DAEMON = 40_104;
const ROOT_PROGRAM = 40_105;
/** No process has it. */
const GONE = 40_199;

function running(...list: Array<[pid: number, uid: number, args: string]>): void {
  for (const [pid, uid, args] of list) fake.processes.set(pid, { uid, args });
}

/** A daemon of the user's, one root runs for them, and a program of root's own. */
function theUsual(): void {
  running([ROOT_DAEMON, 0, RUNS_WORKER], [OWN_DAEMON, ME, RUNS_WORKER], [ROOT_PROGRAM, 0, "/usr/sbin/cron -s"]);
}

function on(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** The user the CLI runs as: undefined where there are no users, as on Windows. */
function asUser(uid: number | undefined): void {
  Object.defineProperty(process, "geteuid", {
    value: uid === undefined ? undefined : () => uid,
    configurable: true,
    writable: true,
  });
}

function pidFile(pid: number): void {
  writeFileSync(PID_FILE, String(pid));
}

/**
 * What `launchctl print system/app.getengram.daemon` prints, as macOS 15
 * does: the job's keys by one tab, what is nested in them by more.
 */
function systemPrint({
  plist = plistPath(),
  pid = null as number | null,
  nested = [] as string[],
} = {}): string {
  const lines = [
    "system/app.getengram.daemon = {",
    `\tactive count = ${pid === null ? 0 : 1}`,
    `\tpath = ${plist}`,
    "\ttype = LaunchDaemon",
    `\tstate = ${pid === null ? "not running" : "running"}`,
    "",
    "\tprogram = /usr/local/bin/node",
    "\targuments = {",
    "\t\t/usr/local/bin/node",
    `\t\t${WORKER}`,
    "\t}",
    "",
    `\tstdout path = ${join(ENGRAM_DIR, "daemon.log")}`,
    `\tstderr path = ${join(ENGRAM_DIR, "daemon.log")}`,
    "\tenvironment = {",
    `\t\tHOME => ${home.dir}`,
    ...nested.map((line) => `\t\t${line}`),
    "\t}",
    "",
    "\tdomain = system",
    "\tminimum runtime = 10",
    "\truns = 2",
    ...(pid === null ? [] : [`\tpid = ${pid}`]),
    "\tlast exit code = 1",
    "",
    "\tspawn type = daemon (3)",
    "\tproperties = keepalive | runatload | inferred program",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}

/** The programs the code under test ran, as command lines. */
function ran(): string[] {
  return vi.mocked(execFileSync).mock.calls.map(([file, args]) => [file, ...((args as string[] | undefined) ?? [])].join(" "));
}

const LOOK = `${LAUNCHCTL} print ${SYSTEM_JOB}`;
const PS_ALL = "/bin/ps -A -ww -o pid=,uid=,args=";
const psOne = (pid: number): string => `/bin/ps -ww -o uid=,args= -p ${pid}`;

/**
 * Signal 0, as the kernel answers it: alive for this process and the made-up
 * ones, and EPERM for one of another user's, as root's is, when the CLI
 * isn't root. Any other signal fails the test before it reaches a process.
 */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal !== 0) throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
  if (pid === process.pid) return true;
  const p = fake.processes.get(pid);
  if (p === undefined) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  const me = process.geteuid?.();
  if (me !== 0 && p.uid !== me) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  return true;
}

function foreign(root: boolean): ForeignFiles {
  return { dir: false, files: ["daemon.db"], root, stopsDaemon: true, stopsStart: false, holdsSends: false };
}

beforeEach(() => {
  on("darwin");
  asUser(ME);
  fake.processes.clear();
  fake.vanished.clear();
  fake.unreadable.clear();
  fake.procUnlisted = false;
  fake.psFails = null;
  fake.systemPrint = null;
  fake.reads = [];
  fake.unexpected = [];
  rmSync(PID_FILE, { force: true });
  vi.stubEnv("PATH", BIN);
  vi.mocked(execFileSync).mockClear();
  vi.mocked(rootDaemonPid).mockClear();
  vi.mocked(rootWorkerPids).mockClear();
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
});

afterEach(() => {
  on(HOST);
  if (GETEUID) Object.defineProperty(process, "geteuid", GETEUID);
  else delete (process as { geteuid?: unknown }).geteuid;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(fake.unexpected).toEqual([]);
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("what a process is to the user (engram#680)", () => {
  it("is their daemon when it runs the worker's script as them", () => {
    expect(processKind(ME, RUNS_WORKER, ME)).toBe("daemon");
    expect(processKind(ME, RUNS_OLD_WORKER, ME)).toBe("daemon");
  });

  it("is a daemon running as root when root runs it for a user who isn't root", () => {
    expect(processKind(0, RUNS_WORKER, ME)).toBe("root");
    expect(processKind(0, RUNS_OLD_WORKER, ME)).toBe("root");
    // As /proc gives it: each argument ended by a NUL, made a space.
    expect(processKind(0, `/usr/local/bin/node ${WORKER} `, ME)).toBe("root");
  });

  it("is root's own daemon, for root", () => {
    expect(processKind(0, RUNS_WORKER, 0)).toBe("daemon");
  });

  it("is something else when another user runs it, or who the user is can't be told", () => {
    expect(processKind(502, RUNS_WORKER, ME)).toBe("other");
    expect(processKind(0, RUNS_WORKER, undefined)).toBe("other");
    expect(processKind(ME, RUNS_WORKER, undefined)).toBe("other");
  });

  it("is something else when it doesn't run the worker's script", () => {
    for (const args of [
      "/sbin/launchd",
      "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/dist/index.js start",
      "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/dist/daemon/worker.json",
      "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/dist/daemon/worker.js.map",
      "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/src/daemon/worker.js",
    ]) {
      expect(processKind(0, args, ME), args).toBe("other");
      expect(processKind(ME, args, ME), args).toBe("other");
    }
  });
});

describe("telling a process apart (engram#680)", () => {
  beforeEach(() => {
    theUsual();
    running([OTHER_USERS_DAEMON, 502, RUNS_WORKER]);
  });

  for (const platform of ["darwin", "linux"] as const) {
    describe(`on ${platform}`, () => {
      beforeEach(() => on(platform));

      it("says which is the user's daemon, which one root runs for them, and which is neither", () => {
        expect(identifyProcess(OWN_DAEMON)).toBe("daemon");
        expect(identifyProcess(ROOT_DAEMON)).toBe("root");
        expect(identifyProcess(OTHER_USERS_DAEMON)).toBe("other");
        expect(identifyProcess(ROOT_PROGRAM)).toBe("other");
        expect(identifyProcess(GONE)).toBe("other");
      });

      it("takes root's daemon for root's own when the CLI runs as root", () => {
        asUser(0);
        expect(identifyProcess(ROOT_DAEMON)).toBe("daemon");
        expect(identifyProcess(OWN_DAEMON)).toBe("other");
      });
    });
  }

  it("on macOS, asks ps about that one process", () => {
    expect(identifyProcess(ROOT_DAEMON)).toBe("root");
    expect(ran()).toEqual([psOne(ROOT_DAEMON)]);
    expect(fake.reads).toEqual([]);
  });

  it("on macOS, can't tell when ps fails but for there being no such process", () => {
    fake.psFails = "timeout";
    expect(identifyProcess(ROOT_DAEMON)).toBe("unknown");
    fake.psFails = "exit";
    expect(identifyProcess(ROOT_DAEMON)).toBe("other");
  });

  it("on Linux, reads /proc, and can't tell when it can't read it", () => {
    on("linux");
    expect(identifyProcess(ROOT_DAEMON)).toBe("root");
    expect(fake.reads).toEqual([`stat /proc/${ROOT_DAEMON}`, `read /proc/${ROOT_DAEMON}/cmdline`]);
    expect(ran()).toEqual([]);
    fake.unreadable.add(ROOT_DAEMON);
    expect(identifyProcess(ROOT_DAEMON)).toBe("unknown");
  });
});

describe("the PID file of a daemon running as root (engram#680)", () => {
  beforeEach(() => theUsual());

  for (const platform of ["darwin", "linux"] as const) {
    it(`on ${platform}, names it, and is kept`, () => {
      on(platform);
      pidFile(ROOT_DAEMON);
      expect(daemonInPidFile()).toEqual({ pid: ROOT_DAEMON, root: true });
      // It isn't the user's own daemon.
      expect(confirmedDaemonInPidFile()).toBeNull();
      expect(readFileSync(PID_FILE, "utf-8")).toBe(String(ROOT_DAEMON));
    });
  }

  it("names the user's own daemon as it did", () => {
    pidFile(OWN_DAEMON);
    expect(daemonInPidFile()).toEqual({ pid: OWN_DAEMON, root: false });
    expect(confirmedDaemonInPidFile()).toBe(OWN_DAEMON);
  });

  it("names nothing for another program, a process that has exited, or this one", () => {
    for (const pid of [ROOT_PROGRAM, GONE, process.pid]) {
      pidFile(pid);
      expect(daemonInPidFile(), String(pid)).toBeNull();
    }
    // A process that has exited isn't asked about.
    expect(ran()).toEqual([psOne(ROOT_PROGRAM)]);
  });
});

describe("Engram's job in launchd's system domain (engram#680)", () => {
  const plist = "/Users/jane/Library/LaunchAgents/app.getengram.daemon.plist";

  it("is found in what launchctl prints, when it was loaded from the user's plist", () => {
    expect(parseSystemJob(systemPrint({ plist, pid: ROOT_DAEMON }), plist)).toEqual({ pid: ROOT_DAEMON });
    expect(parseSystemJob(systemPrint({ plist }), plist)).toEqual({ pid: null });
    const spaced = "/Users/Jane Doe/Library/LaunchAgents/app.getengram.daemon.plist";
    expect(parseSystemJob(systemPrint({ plist: spaced, pid: 7 }), spaced)).toEqual({ pid: 7 });
  });

  it("isn't the user's when it was loaded from any other plist", () => {
    for (const other of [
      "/Library/LaunchDaemons/app.getengram.daemon.plist",
      "/Users/bob/Library/LaunchAgents/app.getengram.daemon.plist",
      `${plist}.bak`,
      "/Users/jane/Library/LaunchAgents",
    ]) {
      expect(parseSystemJob(systemPrint({ plist: other, pid: ROOT_DAEMON }), plist), other).toBeNull();
    }
  });

  it("takes only the job's own keys, never what is nested in them", () => {
    const job = systemPrint({
      plist: "/Library/LaunchDaemons/app.getengram.daemon.plist",
      nested: [`path = ${plist}`],
    });
    expect(parseSystemJob(job, plist)).toBeNull();
    expect(parseSystemJob(systemPrint({ plist, nested: ["pid = 4242"] }), plist)).toEqual({ pid: null });
  });

  it("is nothing in output that isn't a job's", () => {
    expect(parseSystemJob("", plist)).toBeNull();
    expect(parseSystemJob(`path = ${plist}\npid = 4242\n`, plist)).toBeNull();
  });

  it("is asked of launchctl on macOS, which says when there is none", () => {
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    expect(systemJob()).toEqual({ pid: ROOT_DAEMON });
    expect(ran()).toEqual([LOOK]);
    expect(vi.mocked(execFileSync).mock.calls[0][2]).toMatchObject({ encoding: "utf-8", timeout: expect.any(Number) });

    fake.systemPrint = systemPrint();
    expect(systemJob()).toEqual({ pid: null });
    // Loaded from another home's plist.
    fake.systemPrint = systemPrint({ plist: "/Users/bob/Library/LaunchAgents/app.getengram.daemon.plist", pid: 9 });
    expect(systemJob()).toBeNull();
    // None loaded: launchctl exits 113.
    fake.systemPrint = null;
    expect(systemJob()).toBeNull();
  });

  it("is never asked about off macOS, or without launchctl", () => {
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    for (const platform of ["linux", "win32"] as const) {
      on(platform);
      expect(systemJob()).toBeNull();
    }
    on("darwin");
    vi.stubEnv("PATH", join(home.dir, "no-bin"));
    expect(systemJob()).toBeNull();
    expect(ran()).toEqual([]);
  });

  it("is unloaded with sudo launchctl bootout", () => {
    expect(SYSTEM_JOB).toBe("system/app.getengram.daemon");
    expect(SYSTEM_JOB_UNLOAD).toBe("sudo launchctl bootout system/app.getengram.daemon");
  });
});

describe("the daemon running as root for the user (engram#680)", () => {
  beforeEach(() => theUsual());

  it("is the one the PID file names, whatever launchd's system domain runs", () => {
    expect(rootDaemonPid({ pid: ROOT_DAEMON, root: true }, { pid: OLD_ROOT_DAEMON })).toBe(ROOT_DAEMON);
    expect(ran()).toEqual([]);
  });

  it("else, on macOS, the one the job in launchd's system domain runs, confirmed", () => {
    expect(rootDaemonPid(null, { pid: ROOT_DAEMON })).toBe(ROOT_DAEMON);
    expect(ran()).toEqual([psOne(ROOT_DAEMON)]);
    // The user's own daemon named in the PID file is no daemon running as root.
    expect(rootDaemonPid({ pid: OWN_DAEMON, root: false }, { pid: ROOT_DAEMON })).toBe(ROOT_DAEMON);
  });

  it("is none when the job runs no daemon running as root, or none at all", () => {
    expect(rootDaemonPid(null, null)).toBeNull();
    expect(rootDaemonPid({ pid: OWN_DAEMON, root: false }, null)).toBeNull();
    expect(rootDaemonPid(null, { pid: null })).toBeNull();
    expect(rootDaemonPid(null, { pid: process.pid })).toBeNull();
    expect(ran()).toEqual([]);
    for (const pid of [OWN_DAEMON, ROOT_PROGRAM, GONE]) expect(rootDaemonPid(null, { pid }), String(pid)).toBeNull();
  });

  it("is looked up in the PID file, then in launchd's system domain, unless the caller has", () => {
    pidFile(ROOT_DAEMON);
    fake.systemPrint = systemPrint({ pid: OLD_ROOT_DAEMON });
    expect(rootDaemonPid()).toBe(ROOT_DAEMON);
    // The PID file names it: launchd isn't asked.
    expect(ran()).toEqual([psOne(ROOT_DAEMON)]);
    rmSync(PID_FILE);
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    expect(rootDaemonPid()).toBe(ROOT_DAEMON);
    fake.systemPrint = null;
    expect(rootDaemonPid()).toBeNull();
  });

  it("is found, with the job that runs it", () => {
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    expect(findRootDaemon()).toEqual({ pid: ROOT_DAEMON, job: { pid: ROOT_DAEMON } });
    fake.systemPrint = systemPrint();
    pidFile(ROOT_DAEMON);
    expect(findRootDaemon()).toEqual({ pid: ROOT_DAEMON, job: { pid: null } });
    fake.systemPrint = null;
    expect(findRootDaemon()).toEqual({ pid: ROOT_DAEMON, job: null });
  });

  it("is looked for only where the caller hasn't looked", () => {
    pidFile(ROOT_DAEMON);
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    expect(findRootDaemon(null, null)).toBeNull();
    expect(findRootDaemon({ pid: ROOT_DAEMON, root: true }, null)).toEqual({ pid: ROOT_DAEMON, job: null });
    expect(ran()).toEqual([]);
  });

  it("on Linux, is the one the PID file names, and launchd is never asked", () => {
    on("linux");
    pidFile(ROOT_DAEMON);
    fake.systemPrint = systemPrint({ pid: ROOT_DAEMON });
    expect(findRootDaemon()).toEqual({ pid: ROOT_DAEMON, job: null });
    expect(ran()).toEqual([]);
  });

  it("is never looked for on Windows", () => {
    on("win32");
    asUser(undefined);
    pidFile(ROOT_DAEMON);
    expect(findRootDaemon()).toBeNull();
    expect(ran()).toEqual([]);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("is none when looking for it fails: that never stops start, stop or status", () => {
    vi.mocked(rootDaemonPid).mockImplementationOnce(() => {
      throw new Error("ps went away");
    });
    pidFile(ROOT_DAEMON);
    expect(findRootDaemon()).toBeNull();
  });
});

describe("what is said of it (engram#680)", () => {
  it("says it runs as root, and how to stop it: through launchd when its job runs it", () => {
    const root = { pid: 4242, job: { pid: 4242 } };
    expect(rootStopCommand(root)).toBe("sudo launchctl bootout system/app.getengram.daemon");
    expect(rootDaemonLines(root)).toEqual({
      problem: "A daemon started with sudo is still running as root (pid 4242).",
      fixes: ["Stop it with: sudo launchctl bootout system/app.getengram.daemon"],
    });
  });

  it("says to kill it when nothing in launchd runs it", () => {
    const root = { pid: 4242, job: null };
    expect(rootStopCommand(root)).toBe("sudo kill 4242");
    expect(rootDaemonLines(root)).toEqual({
      problem: "A daemon started with sudo is still running as root (pid 4242).",
      fixes: ["Stop it with: sudo kill 4242"],
    });
  });

  it("says to unload the job in launchd's system domain too, which would start another", () => {
    for (const job of [{ pid: null }, { pid: 4343 }]) {
      const root = { pid: 4242, job };
      expect(rootStopCommand(root)).toBe("sudo kill 4242");
      expect(rootDaemonLines(root).fixes).toEqual([
        "Stop it with: sudo kill 4242",
        "Also unload the job 'sudo engram install' loaded into launchd's system domain: sudo launchctl bootout system/app.getengram.daemon",
      ]);
    }
  });

  it("says when that job is left, running no daemon", () => {
    expect(systemJobLeft()).toBe(
      "The job 'sudo engram install' loaded into launchd's system domain is still there, and would run the daemon as root. Unload it with: sudo launchctl bootout system/app.getengram.daemon",
    );
  });

  it("says of daemons running as root that nothing ties to the user how to stop them", () => {
    expect(untiedRootLine([4242])).toBe(
      "A daemon is running as root (pid 4242), most likely started with sudo. Stop it with: sudo kill 4242",
    );
    expect(untiedRootLine([4242, 4343])).toBe(
      "Daemons are running as root (pids 4242, 4343), most likely started with sudo. Stop them with: sudo kill 4242 4343",
    );
  });
});

describe("daemons running as root that nothing ties to the user (engram#680)", () => {
  beforeEach(() => {
    theUsual();
    running(
      [OLD_ROOT_DAEMON, 0, RUNS_OLD_WORKER],
      [OTHER_USERS_DAEMON, 502, RUNS_WORKER],
      // This process, as root: never itself.
      [process.pid, 0, RUNS_WORKER],
    );
  });

  it("on macOS, are every process ps lists running the worker's script as root", () => {
    expect(rootWorkerPids()).toEqual([ROOT_DAEMON, OLD_ROOT_DAEMON]);
    expect(ran()).toEqual([PS_ALL]);
    expect(vi.mocked(execFileSync).mock.calls[0][2]).toMatchObject({ encoding: "utf-8", timeout: expect.any(Number) });
  });

  it("on macOS, are none when ps fails", () => {
    fake.psFails = "timeout";
    expect(rootWorkerPids()).toEqual([]);
    fake.psFails = "exit";
    expect(rootWorkerPids()).toEqual([]);
  });

  it("on Linux, are every process in /proc running it as root, read only for root's processes", () => {
    on("linux");
    fake.vanished.add(ROOT_PROGRAM);
    running([1, 0, "/sbin/init splash"]);
    expect(rootWorkerPids()).toEqual([ROOT_DAEMON, OLD_ROOT_DAEMON, 1].filter((pid) => pid !== 1));
    expect(ran()).toEqual([]);
    // Only the PIDs in it, and the command line of root's processes alone.
    expect(fake.reads).not.toContain("stat /proc/self");
    expect(fake.reads).not.toContain(`read /proc/${OWN_DAEMON}/cmdline`);
    expect(fake.reads).not.toContain(`read /proc/${OTHER_USERS_DAEMON}/cmdline`);
    expect(fake.reads).toContain(`read /proc/1/cmdline`);
  });

  it("on Linux, are none when /proc can't be listed, and skip what can't be read", () => {
    on("linux");
    fake.unreadable.add(ROOT_DAEMON);
    expect(rootWorkerPids()).toEqual([OLD_ROOT_DAEMON]);
    fake.procUnlisted = true;
    expect(rootWorkerPids()).toEqual([]);
  });

  it("are none for root itself, on Windows, or when who the user is can't be told", () => {
    asUser(0);
    expect(rootWorkerPids()).toEqual([]);
    asUser(undefined);
    expect(rootWorkerPids()).toEqual([]);
    asUser(ME);
    on("win32");
    expect(rootWorkerPids()).toEqual([]);
    expect(ran()).toEqual([]);
    expect(fake.reads).toEqual([]);
  });

  it("leave out the daemons the caller knows of", () => {
    expect(untiedRootWorkers([ROOT_DAEMON, null], null)).toEqual([OLD_ROOT_DAEMON]);
    expect(untiedRootWorkers([], null)).toEqual([ROOT_DAEMON, OLD_ROOT_DAEMON]);
  });

  it("on Linux, are looked for only when root has files in ~/.engram", () => {
    on("linux");
    expect(untiedRootWorkers([], null)).toEqual([]);
    expect(untiedRootWorkers([], foreign(false))).toEqual([]);
    expect(fake.reads).toEqual([]);
    expect(untiedRootWorkers([], foreign(true))).toEqual([ROOT_DAEMON, OLD_ROOT_DAEMON]);
  });

  it("are none when looking for them fails", () => {
    vi.mocked(rootWorkerPids).mockImplementationOnce(() => {
      throw new Error("ps went away");
    });
    expect(untiedRootWorkers([], null)).toEqual([]);
  });
});

describe("the tests' own home (engram#680)", () => {
  it("is a temporary one", () => {
    expect(home.dir.startsWith(tmpdir())).toBe(true);
    expect(existsSync(ENGRAM_DIR)).toBe(true);
  });
});
