import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#723 — `engram start`, `install`, `status`, `stop`, and auto-capture
 * in a ~/.engram that is the user's, and that its own permissions keep them
 * out of, as `chmod -R 600 ~/.engram` leaves it. What they said was about
 * the files in it ("config.json can't be read", "Fix the file", a chmod of
 * the file), and start started a daemon that then stopped at once.
 *
 * The folder's mode is really changed, in a temp home, and put back after
 * each test, and config.json is read by the real config.js. process.platform
 * is linux, child_process is a fake, and what answers on the daemon's
 * socket is made up: nothing reaches systemd, ~/.config, the network or the
 * real ~/.engram, and no process is signalled. POSIX only, and not as
 * root, whom no mode keeps out.
 */

const { home, daemon, imported, spawn, execSync, execFileSync, execFile, fetched } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, or (null) whatever the
  // real probe finds, which is nothing, or a socket it can't look at.
  daemon: { answering: null as { pid: number } | null },
  imported: { worker: false },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  fetched: [] as string[],
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
  execFile,
}));
// An install has dist/daemon/worker.js beside launch.js; under vitest the
// module beside launch.ts is worker.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    workerPath: () => path.join(home.dir, "cli", "dist", "daemon", "worker.js"),
  };
});
// `engram start --foreground` runs the worker in the process by importing it.
function mockWorker(): void {
  vi.doMock("../daemon/worker.js", () => {
    imported.worker = true;
    return {};
  });
}
mockWorker();
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (options?: Parameters<typeof real.probeDaemon>[0]): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return real.probeDaemon(options);
    return {
      state: "answered",
      info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION, ...a },
    };
  };
  // No daemon runs as root: nothing reads /proc for one.
  return { ...real, probeDaemon, rootWorkerPids: () => [] };
});

const HOST = process.platform;

// A socket path can be 103 bytes at most on macOS: a long TMPDIR won't do.
home.dir = mkdtempSync(join(Buffer.byteLength(tmpdir()) <= 60 ? tmpdir() : "/tmp", "e723d-"));
const XDG = join(home.dir, "config");
const NO_BIN = join(home.dir, "no-bin");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG = join(ENGRAM_DIR, "config.json");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { LOG_FILE } = await import("../daemon/launch.js");
const { autoEnableCapture, daemonInstall, daemonStart, daemonStatus, daemonStop } = await import("../daemon/commands.js");
const { unitPath } = await import("../daemon/systemd.js");

const SETTINGS = JSON.stringify({ apiKey: "engram-test-key-723" }, null, 2);
const OPENING = "~/.engram is yours, but its permissions keep you from opening the files in it";
const MAKING = "~/.engram is yours, but its permissions keep you from making files in it";
const FIX_SEARCH = "  To fix it, run: chmod u+x ~/.engram";
const FIX_WRITE = "  To fix it, run: chmod u+w ~/.engram";

afterAll(() => {
  chmodSync(ENGRAM_DIR, 0o700);
  rmSync(home.dir, { recursive: true, force: true });
});

describe.skipIf(HOST === "win32" || process.geteuid?.() === 0)("a ~/.engram its permissions keep the user out of (engram#723)", () => {
  const realIsTTY = process.stdin.isTTY;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    fetched.length = 0;
    daemon.answering = null;
    imported.worker = false;
    mockWorker();
    rmSync(XDG, { recursive: true, force: true });
    rmSync(join(home.dir, ".claude"), { recursive: true, force: true });
    if (existsSync(ENGRAM_DIR)) chmodSync(ENGRAM_DIR, 0o700);
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
    writeFileSync(CONFIG, SETTINGS, { mode: 0o600 });
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("XDG_CONFIG_HOME", XDG);
    // No systemctl to be found: start at login says it isn't available.
    vi.stubEnv("PATH", NO_BIN);
    vi.stubEnv("NO_COLOR", "1");
    // What the test run itself sets to keep auto-capture out of other tests.
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    vi.stubEnv("ENGRAM_BASE_URL", undefined);
    for (const name of ["SUDO_UID", "PKEXEC_UID", "DOAS_USER"]) vi.stubEnv(name, undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.stubGlobal("fetch", async (url: unknown) => {
      fetched.push(String(url));
      throw new Error("no network in these tests");
    });
    spawn.mockReset();
    execSync.mockReset();
    execFile.mockReset();
    execFileSync.mockReset();
    // Signal 0 finds this process alive; any other signal fails the test before it reaches a process.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 0 && pid === process.pid) return true;
      if (signal === 0) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
    }) as typeof process.kill);
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void out.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errs.push(args.join(" ")));
  });

  afterEach(() => {
    chmodSync(ENGRAM_DIR, 0o700);
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    expect(fetched).toEqual([]);
  });

  /** Run `command` with ~/.engram at `mode`, put back after: what it says is in out and errs. */
  async function inFolder(mode: number, command: () => Promise<void>): Promise<void> {
    chmodSync(ENGRAM_DIR, mode);
    try {
      await command();
    } finally {
      chmodSync(ENGRAM_DIR, 0o700);
    }
  }

  /** A daemon answers on the socket: this process stands in for it. */
  function daemonRunning(): void {
    daemon.answering = { pid: process.pid };
  }

  /** Nothing was started, start at login wasn't touched, and config.json is as it was. */
  function expectNothingChanged(settings = SETTINGS): void {
    expect(spawn).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(imported.worker).toBe(false);
    // No unit was written, in the folder systemd reads it from or anywhere else under it.
    expect(unitPath().startsWith(join(XDG, "systemd"))).toBe(true);
    expect(existsSync(join(XDG, "systemd"))).toBe(false);
    expect(readFileSync(CONFIG, "utf-8")).toBe(settings);
  }

  /** A daemon.db, as a stopped daemon leaves it, or (`open`) as a running one holds it: with its -wal and -shm files beside it. Close what it returns. */
  async function daemonDb(open: boolean): Promise<{ close(): void }> {
    const { DaemonDb } = await import("../daemon/db.js");
    const db = new DaemonDb(DB_FILE);
    if (open) return db;
    db.close();
    return { close() {} };
  }

  /** Claude Code is there to capture from. */
  function claudeCode(): void {
    mkdirSync(join(home.dir, ".claude", "projects"), { recursive: true });
  }

  const PAUSED = `${OPENING}, so capture is paused, and the daemon can't start again once it stops.`;
  const CANT_RESTART = `${MAKING}, so the daemon can't start again once it stops.`;
  const NOT_STARTED = (problem: string) => `${problem}, so the daemon can't start, and nothing new is captured.`;

  describe("engram start", () => {
    it.each([
      [{}, "engram start"],
      [{ install: "" }, "engram start --install"],
      // The fix is the same, and takes a moment.
      [{ foreground: "" }, "engram start"],
    ])("with %o, in one that keeps them from opening its files, starts nothing, and says why (exit 1)", async (flags, again) => {
      await inFolder(0o600, () => daemonStart([], flags));

      expect(errs).toEqual([NOT_STARTED(OPENING), FIX_SEARCH, `  Then run '${again}' again.`]);
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });

    it("in one that keeps them from making files, starts nothing, and records nothing (exit 1)", async () => {
      const off = JSON.stringify({ apiKey: "engram-test-key-723", autocapture: "off" }, null, 2);
      writeFileSync(CONFIG, off);

      await inFolder(0o500, () => daemonStart([], {}));

      expect(errs).toEqual([NOT_STARTED(MAKING), FIX_WRITE, "  Then run 'engram start' again."]);
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      // Recording capture on can't be done either, and isn't said: the
      // start that records it is the one to run once the folder is fixed.
      expectNothingChanged(off);
    });

    it("with one running that can't open its files, says capture is paused (exit 1)", async () => {
      daemonRunning();

      await inFolder(0o600, () => daemonStart([], {}));

      expect(out).toEqual([`Daemon already running (pid ${process.pid})`]);
      expect(errs).toEqual([PAUSED, FIX_SEARCH]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });

    it("with one running that can't make files, says it can't start again once it stops (exit 0)", async () => {
      daemonRunning();

      await inFolder(0o500, () => daemonStart([], {}));

      expect(out).toEqual([`Daemon already running (pid ${process.pid})`]);
      expect(errs).toEqual([CANT_RESTART, FIX_WRITE]);
      expect(process.exitCode).toBeUndefined();
      expectNothingChanged();
    });

    it.each([
      ["600", 0o600, PAUSED, FIX_SEARCH],
      ["500", 0o500, CANT_RESTART, FIX_WRITE],
    ])("--install, with one running in a ~/.engram at %s, doesn't turn on start at login (exit 1)", async (_, mode, problem, fix) => {
      daemonRunning();

      await inFolder(mode, () => daemonStart([], { install: "" }));

      expect(out).toEqual([`Daemon already running (pid ${process.pid})`]);
      expect(errs).toEqual([problem, fix, "  Then run 'engram start --install' again."]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });
  });

  describe("engram install", () => {
    it.each([
      ["stopped", "600", 0o600, NOT_STARTED(OPENING), FIX_SEARCH],
      ["stopped", "500", 0o500, NOT_STARTED(MAKING), FIX_WRITE],
      ["running", "600", 0o600, PAUSED, FIX_SEARCH],
      ["running", "500", 0o500, CANT_RESTART, FIX_WRITE],
    ])("with the daemon %s, in a ~/.engram at %s, doesn't turn on start at login, and says why (exit 1)", async (daemonIs, _, mode, problem, fix) => {
      if (daemonIs === "running") daemonRunning();

      await inFolder(mode, () => daemonInstall());

      expect(errs).toEqual([problem, fix, "  Then run 'engram install' again."]);
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });
  });

  describe("engram status", () => {
    it("in one that keeps them from opening its files, can't tell whether the daemon runs, and says why (exit 1)", async () => {
      (await daemonDb(false)).close();

      await inFolder(0o600, () => daemonStatus());

      // Not that config.json, the vault key, the database or the log can't
      // be read: that is every file in it.
      expect(out).toEqual([
        "Status: unknown — ~/.engram's permissions keep you from opening the files that say whether the daemon runs",
        "",
        `  ${NOT_STARTED(OPENING)}`,
        FIX_SEARCH,
        "  Then run: engram start",
        "",
      ]);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });

    it("with one running that can't open its files, says capture is paused, and why (exit 1)", async () => {
      const db = await daemonDb(true);
      writeFileSync(join(ENGRAM_DIR, "daemon.log"), "", { mode: 0o600 });
      claudeCode();
      daemonRunning();

      try {
        await inFolder(0o600, () => daemonStatus());
      } finally {
        db.close();
      }

      expect(out).toEqual([
        `Status: running (pid ${process.pid})`,
        "",
        `  ${PAUSED}`,
        FIX_SEARCH,
        "",
        "Hosts:",
        "  ✓ Claude Code    paused (~/.engram, see above)",
        "  · Codex CLI      not installed",
        // It writes to the log it opened as it started.
        `Log: ${LOG_FILE}`,
      ]);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });

    it("with one running that can't make files, shows what it captured, and that it can't start again (exit 0)", async () => {
      // The daemon holds the database open: its -wal and -shm files are
      // there, so it can be read.
      const db = await daemonDb(true);
      writeFileSync(join(ENGRAM_DIR, "daemon.log"), "", { mode: 0o600 });
      claudeCode();
      daemonRunning();

      try {
        await inFolder(0o500, () => daemonStatus());
      } finally {
        db.close();
      }

      expect(out).toEqual([
        `Status: running (pid ${process.pid})`,
        "Sessions captured: 0",
        "Pending sync:      0 messages",
        "Files tracked:     0",
        "",
        `  ${CANT_RESTART}`,
        FIX_WRITE,
        "",
        "Hosts:",
        "  ✓ Claude Code    capturing",
        "  · Codex CLI      not installed",
        `Log: ${LOG_FILE}`,
      ]);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
    });

    it("with one running that can't make files, and no log, says the fix once", async () => {
      daemonRunning();

      await inFolder(0o500, () => daemonStatus());

      expect(out.slice(-2)).toEqual([
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  Once it can be written, 'engram stop' and then 'engram start' have the daemon write to it again.",
      ]);
      expect(out.filter((line) => line === FIX_WRITE)).toHaveLength(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("with it stopped, in one that keeps them from making files, says why the database can't be read (exit 0)", async () => {
      // A stopped daemon leaves no -wal or -shm file, and SQLite makes them
      // to read the database.
      (await daemonDb(false)).close();

      await inFolder(0o500, () => daemonStatus());

      expect(out).toEqual([
        "Status: stopped",
        "Local capture DB unreadable: ~/.engram's own permissions get in the way.",
        "",
        `  ${NOT_STARTED(MAKING)}`,
        FIX_WRITE,
        "  Then run: engram start",
        "",
      ]);
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expectNothingChanged();
    });
  });

  describe("engram stop", () => {
    it("in one that keeps them from opening its files, says capture off wasn't recorded, and a daemon may still run (exit 1)", async () => {
      await inFolder(0o600, () => daemonStop());

      expect(errs).toEqual([
        "Couldn't record that capture is off: ~/.engram's permissions keep you from opening config.json in it.",
        FIX_SEARCH,
        "  Then run 'engram stop' again, or the next engram command turns capture back on.",
        "No daemon was found, but one may still be running: ~/.engram's permissions keep you from opening its socket and PID file.",
      ]);
      expect(out).toEqual([]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });

    it("in one that keeps them from making files, says capture off couldn't be saved (exit 1)", async () => {
      await inFolder(0o500, () => daemonStop());

      // engram#681: the fix is the folder's.
      expect(errs).toEqual([
        "Couldn't record that capture is off: ~/.engram/config.json can't be written: permission denied.",
        FIX_WRITE,
        "  Then run 'engram stop' again, or the next engram command turns capture back on.",
      ]);
      expect(out).toEqual(["Daemon is not running."]);
      expect(process.exitCode).toBe(1);
      expectNothingChanged();
    });
  });

  describe("auto-capture", () => {
    it.each([
      ["600", 0o600, OPENING, "chmod u+x ~/.engram"],
      ["500", 0o500, MAKING, "chmod u+w ~/.engram"],
    ])("after a login, in a ~/.engram at %s, isn't turned on, and says why", async (_, mode, problem, fix) => {
      await inFolder(mode, () => autoEnableCapture({ after: "login" }));

      expect(out).toEqual([`  Auto-capture wasn't turned on: ${problem}, so the daemon can't start. To fix it, run: ${fix}`]);
      expect(errs).toEqual([]);
      expectNothingChanged();
    });

    it.each([
      ["600", 0o600],
      ["500", 0o500],
    ])("after any other command, in a ~/.engram at %s, isn't turned on, and nothing is said", async (_, mode) => {
      await inFolder(mode, () => autoEnableCapture({ after: "command" }));

      expect(out).toEqual([]);
      expect(errs).toEqual([]);
      expectNothingChanged();
    });
  });
});
