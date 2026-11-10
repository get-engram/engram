import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number } | null },
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
vi.mock("../daemon/worker.js", () => {
  imported.worker = true;
  return {};
});
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
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
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { LOG_FILE } = await import("../daemon/launch.js");
const { autoEnableCapture, daemonInstall, daemonStart, daemonStatus, daemonStop } = await import("../daemon/commands.js");
const { generateUnit, unitPath, wantsPath } = await import("../daemon/systemd.js");

const FIX = 'sudo chown -R "$(id -un)" ~/.engram';
const DB_IS_ROOTS = "daemon.db in ~/.engram belongs to root, not to you, so";

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
    given.roots = [];
    imported.worker = false;
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

    it("starts nothing while its log can't be opened, in the foreground either", async () => {
      // The foreground doesn't need the log, but the fix is the same.
      given.roots = ["daemon.log"];
      for (const flags of [{}, { foreground: "" }] as Record<string, string>[]) {
        errs.length = 0;
        process.exitCode = undefined;
        await daemonStart([], flags);
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([
          "daemon.log in ~/.engram belongs to root, not to you, so the daemon can't start, and nothing new is captured.",
          `  Make it yours with: ${FIX}`,
          "  Then run 'engram start' again.",
        ]);
      }
      expectNothingStarted();
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

    it("says nothing of them when everything is the user's", async () => {
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
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

    it("doesn't turn it on while the daemon's log can't be opened", async () => {
      given.roots = ["daemon.log"];
      await daemonInstall();
      expect(process.exitCode).toBe(1);
      expect(errs.at(-1)).toBe("  Then run 'engram install' again.");
      expectNothingStarted();
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
      for (const roots of [["daemon.db"], ["daemon.log"]]) {
        given.roots = roots;
        out.length = 0;
        await autoEnableCapture({ after: "login" });
        expect(out).toEqual([`  Auto-capture wasn't turned on: files in ~/.engram aren't yours. Make them yours with: ${FIX}`]);
      }
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expectNothingStarted();
    });

    it("starts nothing after another command, and says nothing: the banner before it did", async () => {
      given.roots = ["daemon.db"];
      await autoEnableCapture({ after: "command" });
      expect(out).toEqual([]);
      expect(errs).toEqual([]);
      expectNothingStarted();
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
});
