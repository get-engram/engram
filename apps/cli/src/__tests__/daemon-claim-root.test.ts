import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#680 — the daemon's claim (claimDaemonLock) when a daemon left
 * running as root for the user, by `sudo engram start` or `sudo engram
 * install` before engram#653, still runs: the worker exits, and takes
 * nothing. And a worker that is itself root, for another user, takes nothing
 * at all.
 *
 * In a temp home. The root daemon is made up: ps, launchctl, /proc and
 * signal 0 are fakes, and whether this process runs as root for another
 * user is mocked. Each test claims in a fresh copy of instance.js, which
 * claims once, and the signal and exit handlers a claim sets are removed
 * after. POSIX only, and not as root, which sees no daemon as root's.
 */

const { home, fake } = vi.hoisted(() => ({
  home: { dir: "" },
  fake: {
    /** Whether this process runs as root for another user. */
    asRoot: false,
    /** The processes ps, /proc and signal 0 know of, by PID. */
    processes: new Map<number, { uid: number; args: string }>(),
    /**
     * What `launchctl print system/app.getengram.daemon` prints, made when it
     * is asked, in the home the claim runs in; null: there is no such job.
     */
    systemPrint: null as (() => string) | null,
    /** The programs run, and what was read of /proc. */
    calls: [] as string[],
    unexpected: [] as string[],
  },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

vi.mock("../daemon/as-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/as-root.js")>()),
  rootForAnotherUser: () => fake.asRoot,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const failed = (status: number): Error => Object.assign(new Error("Command failed"), { status });
  const execFileSync = vi.fn((file: string, args: readonly string[] = []): string => {
    const command = args.join(" ");
    const one = /^-ww -o uid=,args= -p (\d+)$/.exec(command);
    if (file === "/bin/ps" && one !== null) {
      fake.calls.push(`ps ${one[1]}`);
      const p = fake.processes.get(Number(one[1]));
      if (p === undefined) throw failed(1);
      return `${String(p.uid).padStart(5)} ${p.args}\n`;
    }
    if (/[\\/]launchctl$/.test(file) && command === "print system/app.getengram.daemon") {
      fake.calls.push("launchctl print");
      if (fake.systemPrint === null) throw failed(113);
      return fake.systemPrint();
    }
    fake.unexpected.push(`${file} ${command}`);
    throw new Error(`unexpected: ${file} ${command}`);
  });
  return (await import("./helpers/child-process.js")).recordingNoEnvValues({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync,
  });
});

// /proc, as Linux has it, for the made-up processes; every other path is the real one.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const isProc = (path: unknown): path is string => typeof path === "string" && /^\/proc(?:\/|$)/.test(path);
  const at = (path: string): { uid: number; args: string } => {
    fake.calls.push(`/proc ${path}`);
    const p = fake.processes.get(Number(/^\/proc\/(\d+)/.exec(path)?.[1]));
    if (p === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
    return p;
  };
  type Fn = (...args: unknown[]) => unknown;
  return {
    ...real,
    statSync: ((path: unknown, ...rest: unknown[]) =>
      isProc(path) ? { uid: at(path).uid } : (real.statSync as Fn)(path, ...rest)) as typeof real.statSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      isProc(path) ? `${at(path).args.split(" ").join("\0")}\0` : (real.readFileSync as Fn)(path, ...rest)) as typeof real.readFileSync,
  };
});

const POSIX = process.platform !== "win32";
const ME = process.geteuid?.();
const HOST = process.platform;

// A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
const BASE = mkdtempSync(join(!POSIX || Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e680c-"));
const BIN = join(BASE, "bin");
mkdirSync(BIN);
// Never run: execFileSync is the fake above. It is there to be found on PATH.
writeFileSync(join(BIN, "launchctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

/** The made-up daemon root runs for the user. */
const ROOT = 40_201;
/** A program of root's own. */
const ROOT_PROGRAM = 40_202;
const RUNS_WORKER = "/usr/local/bin/node /usr/local/lib/node_modules/@getengram/cli/dist/daemon/worker.js";

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const EVENTS = [...SIGNALS, "exit"];
const emitter: NodeJS.EventEmitter = process;

let listenersBefore = new Map<string, Function[]>();
let release: (() => void) | null = null;

function on(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

/** The listeners on `event` this test's claim added. */
function added(event: string): Function[] {
  const before = listenersBefore.get(event) ?? [];
  return emitter.listeners(event).filter((listener) => !before.includes(listener));
}

function addedCounts(): Record<string, number> {
  return Object.fromEntries(EVENTS.map((event) => [event, added(event).length]));
}

/** What `launchctl print system/app.getengram.daemon` prints for a job loaded from the user's plist. */
function systemPrint(pid: number | null): string {
  const plist = join(home.dir, "Library", "LaunchAgents", "app.getengram.daemon.plist");
  return [
    "system/app.getengram.daemon = {",
    `\tpath = ${plist}`,
    "\ttype = LaunchDaemon",
    `\tstate = ${pid === null ? "not running" : "running"}`,
    "\tdomain = system",
    ...(pid === null ? [] : [`\tpid = ${pid}`]),
    "}",
    "",
  ].join("\n");
}

/** Signal 0, as the kernel answers it: root's processes are another user's. */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal !== 0) throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
  if (pid === process.pid) return true;
  const p = fake.processes.get(pid);
  if (p === undefined) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  if (p.uid !== ME) throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
  return true;
}

/** Claim the lock in a fresh home, as a worker starting on `platform` does. */
async function claimOn(platform: NodeJS.Platform, setUp: (engramDir: string) => void = () => {}) {
  home.dir = mkdtempSync(join(BASE, "h"));
  const engramDir = join(home.dir, ".engram");
  setUp(engramDir);
  on(platform);
  vi.resetModules();
  const instance = await import("../daemon/instance.js");
  release = instance.releaseDaemonLock;
  listenersBefore = new Map(EVENTS.map((event) => [event, emitter.listeners(event)]));
  const logs: string[] = [];
  const claim = await instance.claimDaemonLock({ log: (msg) => logs.push(msg), settleMs: 20, stopFile: false });
  return { claim, logs, engramDir, pidFile: join(engramDir, "daemon.pid"), socket: join(engramDir, "daemon.sock") };
}

/** A PID file naming `pid`, written before the claim. */
function pidFileNaming(pid: number): (engramDir: string) => void {
  return (engramDir) => {
    mkdirSync(engramDir, { recursive: true });
    writeFileSync(join(engramDir, "daemon.pid"), String(pid));
  };
}

beforeEach(() => {
  fake.asRoot = false;
  fake.processes.clear();
  fake.processes.set(ROOT, { uid: 0, args: RUNS_WORKER });
  fake.processes.set(ROOT_PROGRAM, { uid: 0, args: "/usr/sbin/cron -s" });
  fake.systemPrint = null;
  fake.calls = [];
  fake.unexpected = [];
  vi.stubEnv("PATH", BIN);
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
});

afterEach(() => {
  release?.();
  release = null;
  for (const event of EVENTS) {
    for (const listener of added(event)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
  }
  listenersBefore = new Map();
  on(HOST);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  expect(fake.unexpected).toEqual([]);
});

afterAll(() => rmSync(BASE, { recursive: true, force: true }));

const ROOT_MESSAGE = `a daemon started with sudo is still running as root (pid ${ROOT}); this one is exiting. Run 'engram status' to see how to stop it`;

describe.skipIf(!POSIX || ME === undefined || ME === 0)("the daemon's claim, with a daemon running as root (engram#680)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`on ${platform}, exits when the PID file names one, and leaves the PID file to it`, async () => {
      const { claim, logs, pidFile, socket } = await claimOn(platform, pidFileNaming(ROOT));
      expect(claim).toEqual({ state: "taken", message: ROOT_MESSAGE, retry: false });
      expect(logs).toEqual([ROOT_MESSAGE]);
      expect(readFileSync(pidFile, "utf-8")).toBe(String(ROOT));
      // It bound the socket while it looked, and let it go.
      expect(existsSync(socket)).toBe(false);
      // No exit handler, and the signal handlers it set go with the process.
      expect(addedCounts()).toEqual({ SIGTERM: 1, SIGINT: 1, SIGHUP: 1, exit: 0 });
      // The PID file named it: launchd's system domain wasn't asked.
      expect(fake.calls).not.toContain("launchctl print");
      release?.();
      expect(readFileSync(pidFile, "utf-8")).toBe(String(ROOT));
    });
  }

  it("on macOS, exits when the job in launchd's system domain runs one, with no PID file", async () => {
    fake.systemPrint = () => systemPrint(ROOT);
    const { claim, logs, pidFile, socket } = await claimOn("darwin");
    expect(claim).toEqual({ state: "taken", message: ROOT_MESSAGE, retry: false });
    expect(logs).toEqual([ROOT_MESSAGE]);
    expect(existsSync(pidFile)).toBe(false);
    expect(existsSync(socket)).toBe(false);
    expect(fake.calls).toEqual(["launchctl print", `ps ${ROOT}`]);
  });

  it("on macOS, is the daemon when that job runs no daemon, or another program", async () => {
    fake.systemPrint = () => systemPrint(null);
    const first = await claimOn("darwin");
    expect(first.claim).toEqual({ state: "held" });
    expect(readFileSync(first.pidFile, "utf-8")).toBe(String(process.pid));
    expect(existsSync(first.socket)).toBe(true);
    release?.();
    expect(existsSync(first.pidFile)).toBe(false);
    expect(existsSync(first.socket)).toBe(false);
    for (const event of EVENTS) {
      for (const listener of added(event)) emitter.removeListener(event, listener as (...args: unknown[]) => void);
    }

    fake.systemPrint = () => systemPrint(ROOT_PROGRAM);
    const second = await claimOn("darwin");
    expect(second.claim).toEqual({ state: "held" });
    expect(fake.calls).toEqual(["launchctl print", "launchctl print", `ps ${ROOT_PROGRAM}`]);
  });

  it("on Linux, is the daemon when no PID file names one, and asks nothing of launchd or ps", async () => {
    const { claim, pidFile } = await claimOn("linux");
    expect(claim).toEqual({ state: "held" });
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
    expect(fake.calls).toEqual([]);
  });

  it("is the daemon when the PID file names a program of root's that isn't one", async () => {
    const { claim, pidFile } = await claimOn("linux", pidFileNaming(ROOT_PROGRAM));
    expect(claim).toEqual({ state: "held" });
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
  });
});

describe.skipIf(!POSIX)("the daemon's claim, as root for another user (engram#680)", () => {
  it("is refused, and takes nothing: no handlers, no socket, no PID file, not even ~/.engram", async () => {
    fake.asRoot = true;
    fake.systemPrint = () => systemPrint(ROOT);
    const { claim, logs, engramDir } = await claimOn(HOST);
    const message =
      "daemon exiting: it runs as root, and Engram's daemon runs as you. Run 'engram start' as yourself, without sudo";
    expect(claim).toEqual({ state: "refused", message });
    expect(logs).toEqual([message]);
    expect(addedCounts()).toEqual({ SIGTERM: 0, SIGINT: 0, SIGHUP: 0, exit: 0 });
    expect(existsSync(engramDir)).toBe(false);
    expect(fake.calls).toEqual([]);
  });
});
