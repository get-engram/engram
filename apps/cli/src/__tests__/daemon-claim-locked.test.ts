import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * engram#723 — the daemon's claim (claimDaemonLock) in a ~/.engram that is
 * the user's, and that its own permissions keep them out of, as
 * `chmod -R 600 ~/.engram` leaves it: the worker takes nothing, says why on
 * the desktop as well as in its log (which is in that folder too), and
 * exits 0. And a daemon that is running when that happens says so once,
 * not every 30 seconds.
 *
 * In a temp home, with the folder's mode really changed and put back.
 * Nothing is run: execFileSync is a fake that only records, and so is the
 * desktop notification. Each test claims in a fresh copy of instance.js,
 * which claims once, and the signal and exit handlers a claim sets are
 * removed after. POSIX only, and not as root, whom no mode keeps out.
 */

const { home, fake } = vi.hoisted(() => ({
  home: { dir: "" },
  fake: {
    /** The desktop notifications shown before exiting: [title, body]. */
    notified: [] as [string, string][],
    /** Programs the code under test ran: none should be. */
    unexpected: [] as string[],
  },
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  notifyDesktopBeforeExit: async (title: string, body: string) => void fake.notified.push([title, body]),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const execFileSync = vi.fn((file: string, args: readonly string[] = []): string => {
    fake.unexpected.push(`${file} ${args.join(" ")}`);
    throw new Error(`unexpected: ${file} ${args.join(" ")}`);
  });
  return (await import("./helpers/child-process.js")).recordingNoEnvValues({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFileSync,
  });
});

const POSIX = process.platform !== "win32";
const ME = process.geteuid?.();
const HOST = process.platform;

// A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
const BASE = mkdtempSync(join(!POSIX || Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e723c-"));
const NO_BIN = join(BASE, "bin");
mkdirSync(NO_BIN);

const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const EVENTS = [...SIGNALS, "exit"];
const emitter: NodeJS.EventEmitter = process;

let listenersBefore = new Map<string, Function[]>();
let release: (() => void) | null = null;
/** The ~/.engram of the test running, put back to 0700 after it. */
let engramDir: string | null = null;

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

/** Signal 0 only, as the kernel answers it: this process, and no other. */
function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal !== 0) throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
  if (pid === process.pid) return true;
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

/**
 * Claim the lock as a worker starting on `platform` does, in a fresh home
 * whose ~/.engram holds config.json and has permission bits `mode`.
 */
async function claimIn(mode: number, platform: NodeJS.Platform = "linux") {
  home.dir = mkdtempSync(join(BASE, "h"));
  const dir = join(home.dir, ".engram");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "config.json"), "{}", { mode: 0o600 });
  engramDir = dir;
  chmodSync(dir, mode);
  on(platform);
  vi.resetModules();
  const instance = await import("../daemon/instance.js");
  release = instance.releaseDaemonLock;
  listenersBefore = new Map(EVENTS.map((event) => [event, emitter.listeners(event)]));
  const logs: string[] = [];
  const claim = await instance.claimDaemonLock({ log: (msg) => logs.push(msg), settleMs: 20, stopFile: false });
  return { claim, logs, instance, dir };
}

/** What is in `dir`, looked at with its mode put back. */
function contents(dir: string): string[] {
  chmodSync(dir, 0o700);
  return readdirSync(dir).sort();
}

beforeEach(() => {
  fake.notified = [];
  fake.unexpected = [];
  vi.stubEnv("PATH", NO_BIN);
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
});

afterEach(() => {
  // Before the release, which removes the socket and PID file from it.
  if (engramDir !== null) chmodSync(engramDir, 0o700);
  engramDir = null;
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

const OPENING = "~/.engram is yours, but its permissions keep you from opening the files in it";
const MAKING = "~/.engram is yours, but its permissions keep you from making files in it";

describe.skipIf(!POSIX || ME === undefined || ME === 0)("the daemon's claim, in a ~/.engram it is kept out of (engram#723)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    it(`on ${platform}, takes nothing in a folder it can't search, says why and the fix, and exits 0`, async () => {
      const { claim, logs, dir } = await claimIn(0o600, platform);
      const message = `daemon exiting: ${OPENING}, so the daemon can't start, and nothing new is captured.`;
      expect(claim).toEqual({ state: "refused", message });
      expect(logs).toEqual([message, "To fix it, run: chmod u+x ~/.engram", "Then run: engram start"]);
      // The log is in that folder too: the desktop is told.
      expect(fake.notified).toEqual([
        ["Engram capture has stopped", `${OPENING}, so the daemon can't start. To fix it, run: chmod u+x ~/.engram`],
      ]);
      // No socket and no PID file; nothing asked of launchd or systemd.
      expect(contents(dir)).toEqual(["config.json"]);
      // No exit handler, and the signal handlers it set go with the process.
      expect(addedCounts()).toEqual({ SIGTERM: 1, SIGINT: 1, SIGHUP: 1, exit: 0 });
    });
  }

  it("takes nothing in a folder nothing can be made in, and gives the fix for that", async () => {
    const { claim, logs, dir } = await claimIn(0o500);
    const message = `daemon exiting: ${MAKING}, so the daemon can't start, and nothing new is captured.`;
    expect(claim).toEqual({ state: "refused", message });
    expect(logs).toEqual([message, "To fix it, run: chmod u+w ~/.engram", "Then run: engram start"]);
    expect(fake.notified).toEqual([
      ["Engram capture has stopped", `${MAKING}, so the daemon can't start. To fix it, run: chmod u+w ~/.engram`],
    ]);
    expect(contents(dir)).toEqual(["config.json"]);
  });

  it("gives back every bit that is missing in one command", async () => {
    const { claim, logs } = await claimIn(0o000);
    expect(claim).toMatchObject({ state: "refused" });
    expect(logs[1]).toBe("To fix it, run: chmod u+rwx ~/.engram");
  });

  it("is the daemon in a folder that only can't be listed", async () => {
    const { claim, logs, dir } = await claimIn(0o300);
    expect(claim).toEqual({ state: "held" });
    expect(logs).toEqual([]);
    expect(fake.notified).toEqual([]);
    expect(readFileSync(join(dir, "daemon.pid"), "utf-8")).toBe(String(process.pid));
    expect(existsSync(join(dir, "daemon.sock"))).toBe(true);
  });

  it("says once, while it runs, that it can't check its socket and PID file, and again after it could", async () => {
    const { claim, logs, instance, dir } = await claimIn(0o700);
    expect(claim).toEqual({ state: "held" });
    const pidFile = join(dir, "daemon.pid");
    const said =
      "~/.engram's permissions keep this daemon from opening the files in it, so it can't check its socket and PID file. To fix it, run: chmod u+x ~/.engram";

    chmodSync(dir, 0o600);
    await instance.checkDaemonLock();
    await instance.checkDaemonLock();
    expect(logs).toEqual([said]);

    // Fixed: checked as before, and nothing more said. The socket and the
    // PID file are still its own.
    chmodSync(dir, 0o700);
    await instance.checkDaemonLock();
    expect(logs).toEqual([said]);
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));

    // Kept out again: said again, once.
    chmodSync(dir, 0o600);
    await instance.checkDaemonLock();
    await instance.checkDaemonLock();
    expect(logs).toEqual([said, said]);

    // A folder nothing can be made in still lets it check both, after one
    // it could open: nothing is said of the folder, and a PID file that no
    // longer names it is found, though it can't be written again there.
    chmodSync(dir, 0o700);
    await instance.checkDaemonLock();
    chmodSync(dir, 0o500);
    writeFileSync(pidFile, "1");
    await instance.checkDaemonLock();
    expect(logs).toEqual([said, said, "couldn't write ~/.engram/daemon.pid (EACCES)"]);
    chmodSync(dir, 0o700);
    await instance.checkDaemonLock();
    expect(readFileSync(pidFile, "utf-8")).toBe(String(process.pid));
    expect(existsSync(join(dir, "daemon.sock"))).toBe(true);
    expect(fake.notified).toEqual([]);
  });
});
