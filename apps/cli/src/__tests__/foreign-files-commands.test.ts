import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#659 — `engram start`, `install`, `status`, `stop`, and auto-capture,
 * when files in ~/.engram are another user's, as `sudo engram …` leaves them.
 *
 * Who owns what is given, not made: making a file root's takes root, and
 * nothing here runs as root or changes an owner. foreignFiles is the real
 * one, asked about owners and access this test gives it. process.platform
 * is linux, child_process is a fake, and the home directory is a temp dir:
 * nothing reaches systemd, ~/.config or the real ~/.engram, and no process
 * is signalled.
 */

const { home, daemon, given, imported, spawn, execSync, execFileSync, execFile, saveConfig } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, something that holds it
  // and doesn't answer, or nothing. And a daemon running as root for the
  // user, if one runs (engram#680).
  daemon: { answering: null as { pid: number } | "silent" | null, root: null as number | null },
  // What in ~/.engram is root's and 0600, by name; ".engram" for the folder.
  given: { roots: [] as string[] },
  imported: { worker: false },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
  saveConfig: vi.fn(async () => {}),
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
vi.mock("../config.js", () => {
  const loadConfigStrict = vi.fn(async () => ({ apiKey: "engram-test-key-659" }));
  return {
    loadConfigStrict,
    saveConfig,
    resolveBaseUrl: () => "https://engram.invalid",
  };
});
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
// Mocked again before each test, so each import is seen: an import that
// was already made is otherwise never made again.
function mockWorker(): void {
  vi.doMock("../daemon/worker.js", () => {
    imported.worker = true;
    return {};
  });
}
mockWorker();
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    if (a === "silent") return { state: "silent" };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION, ...a } };
  };
  return {
    ...real,
    probeDaemon,
    // The daemon running as root, as /proc would tell it (engram#680):
    // alive, and root's.
    alive: (pid: number) => pid === daemon.root || real.alive(pid),
    identifyProcess: (pid: number) => (pid === daemon.root ? "root" : real.identifyProcess(pid)),
    rootWorkerPids: () => (daemon.root === null ? [] : [daemon.root]),
  };
});
// The real check, of owners and access given here: the user is uid 1000,
// and what given.roots names is root's and 0600.
vi.mock("../daemon/ownership.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/ownership.js")>();
  const { basename } = await import("node:path");
  const isRoots = (path: string): boolean => given.roots.includes(basename(path));
  return {
    ...real,
    foreignFiles: () =>
      real.foreignFiles({
        platform: "linux",
        euid: 1000,
        env: {},
        dir: "/home/alex/.engram",
        ownerOf: (path) => (isRoots(path) ? 0 : 1000),
        canAccess: (path) => !isRoots(path),
      }),
  };
});

/** The OS this runs on. */
const HOST = process.platform;

home.dir = mkdtempSync(join(tmpdir(), "engram-659c-"));
const CONFIG = join(home.dir, "config");
const NO_BIN = join(home.dir, "no-bin");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const ENGRAM_DIR = join(home.dir, ".engram");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const KEY_FILE = join(ENGRAM_DIR, "vault-key");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { LOG_FILE } = await import("../daemon/launch.js");
const { autoEnableCapture, daemonInstall, daemonStart, daemonStatus, daemonStop } = await import("../daemon/commands.js");
const { generateUnit, unitPath, wantsPath } = await import("../daemon/systemd.js");

const FIX = 'sudo chown -R "$(id -un)" ~/.engram';
const DB_IS_ROOTS = "daemon.db in ~/.engram belongs to root, not to you, so";
const KEY_IS_ROOTS =
  "vault-key in ~/.engram belongs to root, not to you. Until it is yours, captured messages wait on this machine: nothing is lost.";
const LOG_IS_ROOTS = "daemon.log in ~/.engram belongs to root, not to you, so the daemon can't write its log.";
/** A user this process isn't: what owns a file that is another user's. */
const OTHER_UID = (process.geteuid?.() ?? 0) + 1000;
/** What `engram start` and `engram status` say once the log can be written again (engram#679). */
const RESTART = "  Once it can be written, 'engram stop' and then 'engram start' have the daemon write to it again.";

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

// POSIX hosts only, and not as root: the commands look at the effective
// uid, and Windows has none to stand in for. The Linux and macOS jobs run
// these.
describe.skipIf(HOST === "win32" || process.geteuid?.() === 0)("files in ~/.engram that aren't the user's (engram#659)", () => {
  const realIsTTY = process.stdin.isTTY;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    daemon.answering = null;
    daemon.root = null;
    given.roots = [];
    imported.worker = false;
    mockWorker();
    rmSync(CONFIG, { recursive: true, force: true });
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    vi.stubEnv("XDG_CONFIG_HOME", CONFIG);
    // No systemctl to be found: start at login says it isn't available.
    vi.stubEnv("PATH", NO_BIN);
    vi.stubEnv("NO_COLOR", "1");
    // What the test run itself sets to keep auto-capture out of other tests.
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    for (const name of ["SUDO_UID", "PKEXEC_UID", "DOAS_USER"]) vi.stubEnv(name, undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    spawn.mockReset();
    execSync.mockReset();
    execFile.mockReset();
    execFileSync.mockReset();
    saveConfig.mockClear();
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
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** A daemon answers on the socket: this process stands in for it. */
  function daemonRunning(pid = process.pid): void {
    daemon.answering = { pid };
  }

  /** A worker that starts and answers on the socket, ready. */
  function startsAWorker(): void {
    spawn.mockImplementation(() => {
      daemonRunning();
      return Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    });
  }

  /** A daemon.db SQLite can't open, as one it isn't let read can't be. */
  function unreadableDb(): void {
    writeFileSync(DB_FILE, "not a database\n".repeat(20));
  }

  /** A vault key it can't read, as one that is root's and 0600 can't be. */
  function unreadableKey(): void {
    writeFileSync(KEY_FILE, "not read\n");
    chmodSync(KEY_FILE, 0o000);
  }

  /**
   * A daemon.log that can't be written (engram#679): one of the user's own
   * made read-only, or, with the euid spied on, another user's.
   */
  function unwritableLog(mode = 0o000): void {
    writeFileSync(LOG_FILE, "");
    chmodSync(LOG_FILE, mode);
  }

  /** Start at login on: a unit of ours for this CLI, enabled. */
  function startAtLoginOn(): void {
    mkdirSync(dirname(wantsPath()), { recursive: true });
    writeFileSync(
      unitPath(),
      generateUnit({ node: process.execPath, worker: WORKER, log: LOG_FILE, engramDir: ENGRAM_DIR, home: home.dir, path: "/usr/bin:/bin" }),
    );
    writeFileSync(wantsPath(), "");
  }

  /** Nothing was started, and start at login wasn't touched. */
  function expectNothingStarted(): void {
    expect(spawn).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(imported.worker).toBe(false);
    expect(existsSync(join(CONFIG, "systemd"))).toBe(false);
  }

  describe("engram start", () => {
    it("starts nothing while they stop the daemon, in the foreground or with --install either", async () => {
      given.roots = ["daemon.db"];
      // As the CLI parses them: a bare --install is "".
      for (const flags of [{}, { install: "" }, { foreground: "" }, { f: "" }] as Record<string, string>[]) {
        errs.length = 0;
        process.exitCode = undefined;
        await daemonStart([], flags);
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([
          `${DB_IS_ROOTS} the daemon can't start, and nothing new is captured.`,
          `  Make it yours with: ${FIX}`,
          "  Then run 'engram start' again.",
        ]);
      }
      expect(out).toEqual([]);
      expectNothingStarted();
    });

    it("starts the daemon without its log while that is another user's, in the foreground too (engram#679)", async () => {
      given.roots = ["daemon.log"];
      unwritableLog();
      // Root's, as a `sudo engram start` before 0.7.0 left it: no chmod of
      // the user's fixes that.
      vi.spyOn(process, "geteuid").mockReturnValue(OTHER_UID);
      startsAWorker();
      await daemonStart([], {});
      // Said once: no "Then run 'engram start' again", it starts.
      expect(errs).toEqual([LOG_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(spawn).toHaveBeenCalledTimes(1);
      // Its output is dropped: the log can't be opened.
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore" });
      expect(out).toEqual([
        `Engram daemon started (pid ${process.pid})`,
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        // The fix is the chown above, not a chmod.
        RESTART,
        `DB:  ${DB_FILE}`,
      ]);
      expect(process.exitCode).toBeUndefined();

      // The foreground has no log: what it says goes to the terminal.
      daemon.answering = null;
      errs.length = 0;
      out.length = 0;
      await daemonStart([], { foreground: "" });
      expect(errs).toEqual([LOG_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(out).toEqual(["Starting daemon in foreground..."]);
      expect(imported.worker).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it("starts the daemon without a log the user made read-only, and says what fixes it (engram#679)", async () => {
      unwritableLog(0o400);
      startsAWorker();
      await daemonStart([], {});
      // The user's own: nothing in ~/.engram is another user's.
      expect(errs).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore" });
      expect(out).toEqual([
        `Engram daemon started (pid ${process.pid})`,
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
        RESTART,
        `DB:  ${DB_FILE}`,
      ]);
      expect(process.exitCode).toBeUndefined();
      // Left as the user made it: only the fix they run changes it.
      expect(statSync(LOG_FILE).mode & 0o777).toBe(0o400);
    });

    it("points at the log of a daemon that isn't answering only while it can be written (engram#679)", async () => {
      daemon.answering = "silent";
      await daemonStart([], {});
      expect(out).toEqual([
        "Daemon already running, but it isn't answering right now",
        `  It may be busy, or still starting. Its log: ${LOG_FILE}`,
      ]);

      // Nothing in it would say why: the daemon runs without it.
      unwritableLog(0o400);
      out.length = 0;
      await daemonStart([], {});
      expect(out).toEqual(["Daemon already running, but it isn't answering right now", "  It may be busy, or still starting."]);
      expect(errs).toEqual([]);
      expect(spawn).not.toHaveBeenCalled();
    });

    it("starts nothing while ~/.engram itself is closed to the user", async () => {
      given.roots = [".engram"];
      await daemonStart([], {});
      expect(process.exitCode).toBe(1);
      expect(errs[0]).toBe("~/.engram belongs to root, not to you, so the daemon can't start, and nothing new is captured.");
      expectNothingStarted();
    });

    it("says what only stops updates, and starts the daemon", async () => {
      given.roots = ["status.json"];
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual([
        "status.json in ~/.engram belongs to root, not to you, so Engram can't update it.",
        `  Make it yours with: ${FIX}`,
      ]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out[0]).toBe(`Engram daemon started (pid ${process.pid})`);
      expect(process.exitCode).toBeUndefined();
    });

    it("says what they stop once a running daemon stops, and leaves it running", async () => {
      given.roots = ["daemon.db"];
      daemonRunning();
      await daemonStart([], {});
      expect(out).toEqual([`Daemon already running (pid ${process.pid})`]);
      expect(errs).toEqual([`${DB_IS_ROOTS} the daemon can't start again once it stops.`, `  Make it yours with: ${FIX}`]);
      expect(process.exitCode).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("starts the daemon while another user's vault key holds its sends, in the foreground too (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      startsAWorker();
      await daemonStart([], {});
      // Said once: no "Then run 'engram start' again", it starts.
      expect(errs).toEqual([KEY_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out[0]).toBe(`Engram daemon started (pid ${process.pid})`);
      expect(process.exitCode).toBeUndefined();

      daemon.answering = null;
      errs.length = 0;
      await daemonStart([], { foreground: "" });
      expect(errs).toEqual([KEY_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(imported.worker).toBe(true);
      expect(process.exitCode).toBeUndefined();
    });

    it("says what another user's vault key holds to a running daemon, and leaves it running (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      daemonRunning();
      await daemonStart([], {});
      expect(out).toEqual([`Daemon already running (pid ${process.pid})`]);
      expect(errs).toEqual([KEY_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(process.exitCode).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("says nothing of them when everything is the user's", async () => {
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      // Its output goes to the log, made for it.
      const stdio = (spawn.mock.calls[0]?.[2] as { stdio: unknown }).stdio;
      expect(stdio).toEqual(["ignore", expect.any(Number), expect.any(Number)]);
      expect(statSync(LOG_FILE).mode & 0o777).toBe(0o600);
      expect(out).toEqual([`Engram daemon started (pid ${process.pid})`, `Log: ${LOG_FILE}`, `DB:  ${DB_FILE}`]);
    });
  });

  describe("engram install", () => {
    it("doesn't turn on start at login while they stop the daemon", async () => {
      given.roots = ["daemon.db"];
      await daemonInstall();
      expect(process.exitCode).toBe(1);
      expect(errs).toEqual([
        `${DB_IS_ROOTS} the daemon can't start, and nothing new is captured.`,
        `  Make it yours with: ${FIX}`,
        "  Then run 'engram install' again.",
      ]);
      expect(out).toEqual([]);
      expectNothingStarted();
    });

    it("turns it on while the daemon's log is another user's: that only costs the log (engram#679)", async () => {
      given.roots = ["daemon.log"];
      await daemonInstall();
      expect(errs).toEqual([LOG_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(out[0]).toBe("Start at login isn't available here: it needs a systemd user session ('systemctl --user').");
      expect(process.exitCode).toBeUndefined();
    });

    it("turns it on with a daemon running, and says what they stop once it stops", async () => {
      given.roots = ["daemon.db"];
      daemonRunning();
      await daemonInstall();
      expect(errs).toEqual([`${DB_IS_ROOTS} the daemon can't start again once it stops.`, `  Make it yours with: ${FIX}`]);
      // On to start at login, which this machine has no systemd for.
      expect(out).toEqual([
        "Start at login isn't available here: it needs a systemd user session ('systemctl --user').",
        "  The daemon keeps running until you sign out or restart. Run 'engram start' again after that.",
      ]);
      expect(process.exitCode).toBeUndefined();
    });

    it("turns it on while another user's vault key holds sends (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      await daemonInstall();
      expect(errs).toEqual([KEY_IS_ROOTS, `  Make it yours with: ${FIX}`]);
      expect(out[0]).toBe("Start at login isn't available here: it needs a systemd user session ('systemctl --user').");
      expect(process.exitCode).toBeUndefined();
    });

    it("turns it on when they only stop updates", async () => {
      given.roots = ["status.json", "daemon.pid"];
      await daemonInstall();
      expect(errs).toEqual([
        "status.json and daemon.pid in ~/.engram belong to root, not to you, so Engram can't update them.",
        `  Make them yours with: ${FIX}`,
      ]);
      expect(out[0]).toBe("Start at login isn't available here: it needs a systemd user session ('systemctl --user').");
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe("auto-capture", () => {
    it("starts nothing after signing in, and says why", async () => {
      for (const roots of [["daemon.db"], ["daemon.db", "daemon.log"], [".engram"]]) {
        given.roots = roots;
        out.length = 0;
        await autoEnableCapture({ after: "login" });
        expect(out).toEqual([`  Auto-capture wasn't turned on: files in ~/.engram aren't yours. Make them yours with: ${FIX}`]);
      }
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expectNothingStarted();
    });

    it("starts the daemon when only its log is another user's (engram#679)", async () => {
      given.roots = ["daemon.log"];
      unwritableLog();
      startsAWorker();
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn.mock.calls[0]?.[2]).toMatchObject({ stdio: "ignore" });
      expect(out).toContain(
        "Auto-capture is on — conversations from supported agents on this machine save to your Engram.",
      );
      expect(out.join("\n")).not.toContain("wasn't turned on");
    });

    it("starts nothing after another command, and says nothing: the banner before it did", async () => {
      given.roots = ["daemon.db"];
      await autoEnableCapture({ after: "command" });
      expect(out).toEqual([]);
      expect(errs).toEqual([]);
      expectNothingStarted();
    });

    it("starts the daemon while another user's vault key holds sends (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      startsAWorker();
      await autoEnableCapture({ after: "login" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out).toContain(
        "Auto-capture is on — conversations from supported agents on this machine save to your Engram.",
      );
      expect(out.join("\n")).not.toContain("wasn't turned on");
    });

    it("starts the daemon when they only stop updates", async () => {
      given.roots = ["status.json"];
      startsAWorker();
      await autoEnableCapture({ after: "command" });
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out).toContain(
        "Auto-capture is on — conversations from supported agents on this machine save to your Engram.",
      );
    });
  });

  describe("engram status", () => {
    it("says a running daemon runs without its log while that is another user's (engram#679)", async () => {
      given.roots = ["daemon.log"];
      unwritableLog();
      vi.spyOn(process, "geteuid").mockReturnValue(OTHER_UID);
      daemonRunning();
      await daemonStatus();
      expect(out.slice(0, 5)).toEqual([
        `Status: running (pid ${process.pid})`,
        "",
        `  ${LOG_IS_ROOTS}`,
        `  Make it yours with: ${FIX}`,
        "",
      ]);
      const at = out.findIndex((line) => line.startsWith("Log: "));
      expect(out.slice(at, at + 2)).toEqual([
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        RESTART,
      ]);
      expect(out.join("\n")).not.toContain("To fix it");
      expect(errs).toEqual([]);
    });

    it("says what fixes a log the user made read-only, or a ~/.engram it can't be made in (engram#679)", async () => {
      daemonRunning();
      unwritableLog(0o400);
      await daemonStatus();
      let at = out.findIndex((line) => line.startsWith("Log: "));
      expect(out.slice(at)).toEqual([
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
        RESTART,
      ]);

      rmSync(LOG_FILE);
      chmodSync(ENGRAM_DIR, 0o500);
      try {
        out.length = 0;
        await daemonStatus();
      } finally {
        chmodSync(ENGRAM_DIR, 0o700);
      }
      at = out.findIndex((line) => line.startsWith("Log: "));
      expect(out.slice(at, at + 2)).toEqual([
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`,
        "  To fix it, run: chmod u+w ~/.engram",
      ]);
      expect(errs).toEqual([]);
    });

    it("gives no chmod that wouldn't make the log writable (engram#679)", async () => {
      daemonRunning();
      // A folder in its place: one made writable would still be a folder.
      mkdirSync(LOG_FILE, { mode: 0o500 });
      try {
        await daemonStatus();
      } finally {
        chmodSync(LOG_FILE, 0o700);
      }
      let at = out.findIndex((line) => line.startsWith("Log: "));
      expect(out.slice(at)).toEqual([`Log: ${LOG_FILE} can't be written (EISDIR), so the daemon runs without it.`, RESTART]);

      // ~/.engram can be written in, but not searched: the log's own mode
      // lets the user write it, and the folder's write bit is set already.
      rmSync(LOG_FILE, { recursive: true });
      writeFileSync(LOG_FILE, "", { mode: 0o600 });
      chmodSync(ENGRAM_DIR, 0o600);
      try {
        out.length = 0;
        await daemonStatus();
      } finally {
        chmodSync(ENGRAM_DIR, 0o700);
      }
      at = out.findIndex((line) => line.startsWith("Log: "));
      expect(out.slice(at, at + 2)).toEqual([`Log: ${LOG_FILE} can't be written (EACCES), so the daemon runs without it.`, RESTART]);
    });

    it("says only where the log is while it can be written, made or not (engram#679)", async () => {
      daemonRunning();
      await daemonStatus();
      expect(existsSync(LOG_FILE)).toBe(false);
      expect(out.filter((line) => line.startsWith("Log: "))).toEqual([`Log: ${LOG_FILE}`]);
      expect(out.join("\n")).not.toContain("can't be written");
    });

    it("says a stopped daemon's output is in the journal while its log can't be written (engram#679)", async () => {
      unwritableLog(0o400);
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "Auto-start: enabled (systemd)",
        "  It should be running: start at login is on. It may have stopped after an error.",
        "  The end of its output says why: journalctl --user -u engram",
        "  Run 'engram start' to start it again.",
        // Nothing runs, so nothing to restart once it can be written.
        `Log: ${LOG_FILE} can't be written (EACCES), so the daemon will run without it.`,
        "  To fix it, run: chmod u+w ~/.engram/daemon.log",
      ]);
      expect(errs).toEqual([]);
    });

    it("says why a stopped daemon is stopped, and what to run once they are the user's", async () => {
      given.roots = ["daemon.db"];
      unreadableDb();
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "Local capture DB unreadable: it isn't yours, see below.",
        "",
        `  ${DB_IS_ROOTS} the daemon can't start, and nothing new is captured.`,
        `  Make it yours with: ${FIX}`,
        "  Then run: engram start",
        "",
        // Not "It should be running …, it may have stopped after an error":
        // what it says above is why.
        "Auto-start: enabled (systemd)",
      ]);
      expect(errs).toEqual([]);
    });

    it("still says it should be running when they only stop updates", async () => {
      given.roots = ["status.json"];
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "",
        "  status.json in ~/.engram belongs to root, not to you, so Engram can't update it.",
        `  Make it yours with: ${FIX}`,
        "",
        "Auto-start: enabled (systemd)",
        "  It should be running: start at login is on. It may have stopped after an error.",
        `  The end of its log says why: ${LOG_FILE}`,
        "  Run 'engram start' to start it again.",
      ]);
    });

    it("says another user's vault key holds sends, and still that a stopped daemon should run (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "",
        `  ${KEY_IS_ROOTS}`,
        `  Make it yours with: ${FIX}`,
        // Not "Then run: engram start": it doesn't stop the daemon.
        "",
        "Auto-start: enabled (systemd)",
        "  It should be running: start at login is on. It may have stopped after an error.",
        `  The end of its log says why: ${LOG_FILE}`,
        "  Run 'engram start' to start it again.",
      ]);
      expect(errs).toEqual([]);
    });

    it("says another user's vault key holds a running daemon's sends, and how many wait (engram#695)", async () => {
      given.roots = ["vault-key"];
      unreadableKey();
      daemonRunning();
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          health: "error",
          error_type: "vault_key",
          pending_messages: 3,
          last_error_at: "2026-11-10T12:00:00.000Z",
        }),
      );
      await daemonStatus();
      expect(out.slice(0, 5)).toEqual([
        `Status: running (pid ${process.pid})`,
        "",
        `  ${KEY_IS_ROOTS}`,
        `  Make it yours with: ${FIX}`,
        "",
      ]);
      // Then what the daemon says of it: how many wait, since when.
      const at = out.indexOf(
        "  WARNING: Your vault key (~/.engram/vault-key) can't be read, so messages wait here rather than be sent with your vault's secrets in them. Nothing is lost.",
      );
      expect(at).toBeGreaterThan(4);
      expect(out.slice(at + 1, at + 3)).toEqual(["  3 messages waiting to sync", "  Last error: 2026-11-10T12:00:00.000Z"]);
      expect(errs).toEqual([]);
    });

    it("says what they stop once a running daemon stops", async () => {
      given.roots = ["daemon.db"];
      unreadableDb();
      daemonRunning();
      await daemonStatus();
      const at = out.indexOf(`Status: running (pid ${process.pid})`);
      expect(at).toBe(0);
      expect(out.slice(1, 6)).toEqual([
        "Local capture DB unreadable: it isn't yours, see below.",
        "",
        `  ${DB_IS_ROOTS} the daemon can't start again once it stops.`,
        `  Make it yours with: ${FIX}`,
        "",
      ]);
      expect(out).not.toContain("  Then run: engram start");
    });

    it("says the database may need a rebuild only when it is the user's", async () => {
      unreadableDb();
      await daemonStatus();
      expect(out).toContain("Local capture DB unreadable (native module mismatch?) — the daemon rebuilds it on start.");
      expect(out.join("\n")).not.toContain("not to you");
    });

    it("doesn't take the database for one that isn't the user's when another file is", async () => {
      given.roots = ["status.json"];
      unreadableDb();
      await daemonStatus();
      expect(out).toContain("Local capture DB unreadable (native module mismatch?) — the daemon rebuilds it on start.");
      expect(out).toContain("  status.json in ~/.engram belongs to root, not to you, so Engram can't update it.");
    });
  });

  describe("engram stop", () => {
    it("says how to stop a daemon that runs as another user", async () => {
      daemonRunning(4242);
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });
      await daemonStop();
      expect(errs).toEqual([
        "Failed to stop daemon (pid 4242)",
        "  It runs as another user (root, if it was started with sudo). Stop it with: sudo kill 4242",
      ]);
      expect(process.exitCode).toBe(1);
    });

    it("points at the log of a daemon that isn't answering only while it can be written (engram#679)", async () => {
      daemon.answering = "silent";
      await daemonStop();
      expect(errs).toEqual([
        "The daemon isn't answering, and no process could be confirmed as it, so nothing was stopped.",
        `  It may be busy, or still starting: try again in a minute. Its log: ${LOG_FILE}`,
      ]);
      expect(process.exitCode).toBe(1);

      unwritableLog(0o400);
      errs.length = 0;
      await daemonStop();
      expect(errs).toEqual([
        "The daemon isn't answering, and no process could be confirmed as it, so nothing was stopped.",
        "  It may be busy, or still starting: try again in a minute.",
      ]);
    });

    it("says only that it failed for any other reason", async () => {
      daemonRunning(4242);
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("kill EINVAL"), { code: "EINVAL" });
      });
      await daemonStop();
      expect(errs).toEqual(["Failed to stop daemon (pid 4242)"]);
      expect(process.exitCode).toBe(1);
    });

    it("never says sudo on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      // There, the PID file must name the process the pipe's answer gives.
      writeFileSync(join(ENGRAM_DIR, "daemon.pid"), "4242");
      daemonRunning(4242);
      vi.mocked(process.kill).mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });
      await daemonStop();
      expect(errs).toEqual(["Failed to stop daemon (pid 4242)"]);
      expect(process.exitCode).toBe(1);
    });
  });

  describe("with the daemon that made them still running as root (engram#680)", () => {
    const ROOT = 4243;
    const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
    const PROBLEM = `A daemon started with sudo is still running as root (pid ${ROOT}).`;
    // Said after how to stop it: made the user's while it runs, it makes more.
    const FILES = ["daemon.db in ~/.engram belongs to root, not to you, so the daemon can't start.", `  Then make it yours with: ${FIX}`];

    beforeEach(() => {
      // `sudo engram start` before engram#653: its PID file names it, and
      // the database it made is root's.
      daemon.root = ROOT;
      writeFileSync(PID_FILE, String(ROOT));
      given.roots = ["daemon.db"];
    });

    it("start and install say to stop it, then to make the files the user's, and change nothing", async () => {
      const runs: [() => Promise<void>, string, string][] = [
        [() => daemonStart([], {}), "No daemon of yours starts while it runs.", "engram start"],
        [() => daemonStart([], { install: "" }), "No daemon of yours starts while it runs.", "engram start --install"],
        [() => daemonInstall(), "Start at login wasn't turned on: no daemon of yours starts while it runs.", "engram install"],
      ];
      for (const [run, why, again] of runs) {
        errs.length = 0;
        process.exitCode = undefined;
        await run();
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([`${PROBLEM} ${why}`, `  Stop it with: sudo kill ${ROOT}`, ...FILES, `  Then run '${again}' again.`]);
      }
      expect(out).toEqual([]);
      expectNothingStarted();
      expect(readFileSync(PID_FILE, "utf-8")).toBe(String(ROOT));
    });

    it("status says it runs as root, how to stop it, then to make the files the user's, once", async () => {
      await daemonStatus();
      expect(out).toContain(`Status: running as root (pid ${ROOT}), started with sudo`);
      expect(out.join("\n")).toContain(
        [
          "",
          `  ${PROBLEM} 'engram stop' can't stop it, and no daemon of yours starts while it runs.`,
          `  Stop it with: sudo kill ${ROOT}`,
          `  ${FILES[0]}`,
          FILES[1],
          "  Then run: engram start",
          "",
        ].join("\n"),
      );
      expect(out.filter((line) => line.includes("belongs to root"))).toHaveLength(1);
      expect(process.exitCode).toBeUndefined();
    });

    it("status names the log it writes to: root writes to it whoever owns it, so it runs with it (engram#679)", async () => {
      given.roots = ["daemon.db", "daemon.log"];
      unwritableLog();
      await daemonStatus();
      expect(out).toContain(`Status: running as root (pid ${ROOT}), started with sudo`);
      expect(out.filter((line) => line.startsWith("Log: "))).toEqual([`Log: ${LOG_FILE}`]);
      expect(out).not.toContain(RESTART);
      expect(out.join("\n")).not.toMatch(/can't be written|To fix it|journalctl/);
    });

    it("status, its PID file gone, says it as one nothing ties to the user, then the files, a blank line between", async () => {
      rmSync(PID_FILE);
      await daemonStatus();
      expect(out[0]).toBe("Status: stopped");
      const text = out.join("\n");
      expect(text).toContain(
        [
          "",
          `  A daemon is running as root (pid ${ROOT}), most likely started with sudo. Stop it with: sudo kill ${ROOT}`,
          "",
          `  ${DB_IS_ROOTS} the daemon can't start, and nothing new is captured.`,
          `  Make it yours with: ${FIX}`,
          "  Then run: engram start",
          "",
        ].join("\n"),
      );
      expect(text).not.toContain("\n\n\n");
    });

    it("status, with the user's own daemon running, says the one beside it, then the files, a blank line between", async () => {
      rmSync(PID_FILE);
      daemonRunning();
      await daemonStatus();
      expect(out[0]).toBe(`Status: running (pid ${process.pid})`);
      const text = out.join("\n");
      expect(text).toContain(
        [
          "",
          `  A daemon is running as root (pid ${ROOT}), most likely started with sudo. Stop it with: sudo kill ${ROOT}`,
          "",
          `  ${DB_IS_ROOTS}`,
        ].join("\n"),
      );
      expect(text).not.toContain("\n\n\n");
    });

    it("stop says it can't stop it, then to make the files the user's", async () => {
      await daemonStop();
      expect(process.exitCode).toBe(1);
      expect(errs).toEqual([`${PROBLEM} 'engram stop' can't stop it.`, `  Stop it with: sudo kill ${ROOT}`, ...FILES]);
      expect(out).toEqual([]);
      expect(readFileSync(PID_FILE, "utf-8")).toBe(String(ROOT));
    });
  });
});
