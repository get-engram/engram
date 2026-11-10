import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#673 — `engram stop`, `uninstall`, `start`, `status` and auto-capture,
 * when ~/.engram/config.json can't be read.
 *
 * `engram stop` read it leniently and saved it back with only
 * `autocapture: "off"` in it: the API key and the folders excluded from
 * capture were gone. It now says capture couldn't be recorded off, and
 * leaves the file alone. `engram status` says why capture waits, not that
 * the daemon should be running or that no one is signed in, and
 * auto-capture starts nothing: a daemon started now would only wait.
 *
 * config.js is the real one, on a temp home. process.platform is linux,
 * child_process is a fake, and nothing reaches systemd, ~/.config or the
 * real ~/.engram; no process is signalled.
 */

const { home, daemon, imported, spawn, execSync, execFileSync, execFile } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number } | null },
  imported: { worker: false },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
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
vi.mock("../daemon/worker.js", () => {
  imported.worker = true;
  return {};
});
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});
// Everything in ~/.engram is the user's (engram#659 has the rest).
vi.mock("../daemon/ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/ownership.js")>()),
  foreignFiles: () => null,
}));

/** The OS this runs on. */
const HOST = process.platform;

home.dir = mkdtempSync(join(tmpdir(), "engram-673-daemon-"));
const XDG = join(home.dir, "config");
const NO_BIN = join(home.dir, "no-bin");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const STATUS_FILE = join(ENGRAM_DIR, "status.json");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { LOG_FILE } = await import("../daemon/launch.js");
const { autoEnableCapture, daemonStart, daemonStatus, daemonStop, daemonUninstall } = await import(
  "../daemon/commands.js"
);
const { generateUnit, unitPath, wantsPath } = await import("../daemon/systemd.js");

const TAIL = "Q9Z7LEAK";
/** The file cut short just after the key: JSON.parse's own message quotes the end of the key. */
const BROKEN = `{"apiKey":"engram_sk_live_test_673_${TAIL}","n":x}`;
const SINCE = "2026-11-09T00:00:00.000Z";
const WAITS = "so Engram can't tell which folders you excluded from capture. New messages wait until it's fixed; nothing is skipped.";
const FIX = [
  "  Fix the file: it holds your API key and the folders you excluded, so Engram",
  "  won't save over it. To start over instead: run 'engram stop', remove it, add",
  "  back the folders you excluded ('engram exclude add <path>'), then 'engram login'.",
];
const NOTE = [
  "Note: ~/.engram/config.json was empty, so any folders you had excluded from",
  "  capture are lost. Add them back with: engram exclude add <path>",
];

/** What `engram <command>` says when it can't record that capture is off. */
const unrecorded = (command: string) => [
  "Couldn't record that capture is off: ~/.engram/config.json isn't valid JSON.",
  `  Once it's fixed, run 'engram ${command}' again, or the next engram command turns capture back on.`,
];

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

// POSIX hosts only, and not as root, as for engram#659: the commands look
// at the effective uid. The Linux and macOS jobs run these.
describe.skipIf(HOST === "win32" || process.geteuid?.() === 0)("a config.json that can't be read (engram#673)", () => {
  const realIsTTY = process.stdin.isTTY;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    daemon.answering = null;
    imported.worker = false;
    rmSync(XDG, { recursive: true, force: true });
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    rmSync(join(home.dir, ".claude"), { recursive: true, force: true });
    mkdirSync(ENGRAM_DIR, { mode: 0o700 });
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
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const config = (text: string) => writeFileSync(CONFIG_FILE, text);
  const expectUnchanged = (text: string) => {
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(text);
    // Nothing written beside it either, a half-made replacement among them.
    expect(readdirSync(ENGRAM_DIR).filter((f) => f.startsWith("config"))).toEqual(["config.json"]);
  };

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
    expect(existsSync(join(XDG, "systemd"))).toBe(false);
  }

  describe("engram stop", () => {
    it("leaves the file alone, and says capture couldn't be recorded off", async () => {
      config(BROKEN);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop"));
      expect(out).toEqual(["Daemon is not running."]);
      // Not all it was asked to do: a script can tell.
      expect(process.exitCode).toBe(1);
      expectUnchanged(BROKEN);
    });

    it("stops a running daemon all the same", async () => {
      config(BROKEN);
      daemonRunning(4242);
      vi.mocked(process.kill).mockImplementation(((pid: number, signal?: string | number) => {
        if (pid !== 4242) throw new Error(`a test sent ${String(signal)} to pid ${pid}`);
        if (signal === "SIGTERM") {
          daemon.answering = null;
          return true;
        }
        if (signal === 0 && daemon.answering) return true;
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }) as typeof process.kill);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop"));
      expect(out).toEqual(["Daemon stopped (pid 4242)"]);
      expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
      expect(process.exitCode).toBe(1);
      expectUnchanged(BROKEN);
    });

    it("records capture off in an empty one, saying what that means", async () => {
      config("");
      await daemonStop();
      expect(errs).toEqual(NOTE);
      expect(JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))).toEqual({ autocapture: "off" });
      expect(process.exitCode).toBeUndefined();
    });

    it("records it in a good one, with what else is in it", async () => {
      config(JSON.stringify({ apiKey: "engram_sk_live_test_673_fine", excludePaths: ["/work"] }));
      await daemonStop();
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))).toEqual({
        apiKey: "engram_sk_live_test_673_fine",
        excludePaths: ["/work"],
        autocapture: "off",
      });
    });
  });

  describe("engram uninstall", () => {
    it("leaves the file alone, and says capture couldn't be recorded off", async () => {
      config(BROKEN);
      await daemonUninstall();
      expect(errs).toEqual(unrecorded("uninstall"));
      expect(out).toEqual(["Auto-start isn't on."]);
      expect(process.exitCode).toBe(1);
      expectUnchanged(BROKEN);
    });
  });

  describe("engram start", () => {
    it("starts the daemon, which waits on the file, and leaves the file alone", async () => {
      config(BROKEN);
      startsAWorker();
      await daemonStart([], {});
      // Recording "on" isn't needed: nothing turns capture off meanwhile.
      expect(errs).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out[0]).toBe(`Engram daemon started (pid ${process.pid})`);
      expectUnchanged(BROKEN);
    });
  });

  describe("engram status", () => {
    it("stopped: says why capture waits and how to fix it, not that it should be running", async () => {
      config(BROKEN);
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "",
        `  WARNING: ~/.engram/config.json isn't valid JSON, ${WAITS}`,
        ...FIX,
        "",
        // Not "It should be running: start at login is on": whether
        // 'engram stop' recorded capture off can't be told.
        "Auto-start: enabled (systemd)",
      ]);
      expect(errs).toEqual([]);
      expectUnchanged(BROKEN);
    });

    it("stopped, an empty file: what to add back, and to sign in again", async () => {
      config("");
      startAtLoginOn();
      await daemonStatus();
      expect(out).toEqual([
        "Status: stopped",
        "",
        `  WARNING: ~/.engram/config.json is empty, ${WAITS}`,
        "  Add back any folders you had excluded ('engram exclude add <path>'),",
        "  then sign in again ('engram login').",
        "",
        "Auto-start: enabled (systemd)",
      ]);
    });

    it("running: hosts are paused for config.json, said once, and not 'signed out'", async () => {
      config(BROKEN);
      mkdirSync(join(home.dir, ".claude", "projects"), { recursive: true });
      // The daemon, waiting on the file, found no key in it.
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          signed_out_at: SINCE,
          capture_error: { kind: "config", message: "~/.engram/config.json isn't valid JSON", since: SINCE, files: 2 },
        }),
      );
      daemonRunning();
      await daemonStatus();
      expect(out[0]).toBe(`Status: running (pid ${process.pid})`);
      expect(out).toContain("  ✓ Claude Code    paused (config.json, see below)");
      expect(out.filter((l) => l.includes("WARNING"))).toEqual([`  WARNING: ~/.engram/config.json isn't valid JSON, ${WAITS}`]);
      const said = out.join("\n");
      expect(said).not.toContain("Signed out");
      expect(said).not.toContain("engram auth login");
      expect(said).not.toContain(TAIL.slice(-4));
    });

    it("running, still signed in: said once, and not that the file reads fine", async () => {
      config(BROKEN);
      mkdirSync(join(home.dir, ".claude", "projects"), { recursive: true });
      // The usual case: the key in use stays while the file can't be read
      // (engram#594), and capture waits on it.
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          capture_error: { kind: "config", message: "~/.engram/config.json isn't valid JSON", since: SINCE, files: 2 },
        }),
      );
      daemonRunning();
      await daemonStatus();
      expect(out).toContain("  ✓ Claude Code    paused (config.json, see below)");
      expect(out.filter((l) => l.includes("WARNING"))).toEqual([`  WARNING: ~/.engram/config.json isn't valid JSON, ${WAITS}`]);
      const said = out.join("\n");
      expect(said).not.toContain("reads fine");
      expect(said).not.toContain("Signed out");
    });

    it("running, the file fixed: capture picks up on its own", async () => {
      config(JSON.stringify({ apiKey: "engram_sk_live_test_673_fine" }));
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({
          capture_error: { kind: "config", message: "~/.engram/config.json isn't valid JSON", since: SINCE, files: 2 },
        }),
      );
      daemonRunning();
      await daemonStatus();
      const at = out.indexOf("  Capture is waiting on ~/.engram/config.json, which reads fine now.");
      expect(at).toBeGreaterThan(0);
      expect(out.slice(at - 1, at + 4)).toEqual([
        "",
        "  Capture is waiting on ~/.engram/config.json, which reads fine now.",
        "  It picks up where it stopped within 5 minutes: nothing is skipped.",
        `  Since: ${SINCE}`,
        "",
      ]);
      expect(out.join("\n")).not.toContain("WARNING");
    });

    it("running: a stall queueing into daemon.db is still said, beside the file", async () => {
      config(BROKEN);
      writeFileSync(
        STATUS_FILE,
        JSON.stringify({ capture_error: { message: "database or disk is full", since: SINCE, files: 1 } }),
      );
      daemonRunning();
      await daemonStatus();
      const warnings = out.filter((l) => l.includes("WARNING"));
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toBe(`  WARNING: ~/.engram/config.json isn't valid JSON, ${WAITS}`);
      expect(warnings[1]).toContain("database or disk is full");
    });
  });

  describe("auto-capture", () => {
    it.each(["login", "command"] as const)("starts nothing after %s, and says nothing", async (after) => {
      config(BROKEN);
      await autoEnableCapture({ after });
      expect(out).toEqual([]);
      expect(errs).toEqual([]);
      expectNothingStarted();
      expectUnchanged(BROKEN);
    });

    it("starts nothing with an empty file, even with ENGRAM_API_KEY set", async () => {
      config("");
      vi.stubEnv("ENGRAM_API_KEY", "engram_sk_live_test_673_env");
      await autoEnableCapture({ after: "command" });
      expectNothingStarted();
      expectUnchanged("");
    });

    it("starts the daemon with a good file", async () => {
      config(JSON.stringify({ apiKey: "engram_sk_live_test_673_fine" }));
      startsAWorker();
      await autoEnableCapture({ after: "command" });
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });
});
