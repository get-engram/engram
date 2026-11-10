import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#681 — `engram stop`, `uninstall` and `start` when
 * ~/.engram/config.json can be read but not written.
 *
 * `engram stop` records that capture is off in config.json: that is what
 * keeps the next engram command from starting the daemon again. When the
 * save failed, it was swallowed: the daemon stopped, stop said so and
 * exited 0, and the next command started it again. It now still stops the
 * daemon, but says capture couldn't be recorded off, why, and what fixes
 * it, and exits 1. `engram start` over an "off" it can't replace says that
 * other commands won't start the daemon again after it stops.
 *
 * config.js is the real one, on a temp home, and the files are made read
 * only for real. process.platform is linux, child_process is a fake, and
 * nothing reaches systemd, ~/.config or the real ~/.engram; no process is
 * signalled.
 */

const { home, daemon, failWrite, ownedByAnother, spawn, execSync, execFileSync, execFile } = vi.hoisted(() => ({
  home: { dir: "" },
  // What answers on the daemon's socket: a daemon, or nothing.
  daemon: { answering: null as { pid: number } | null },
  // A write of config.json fails with this code, for a failure a test can't
  // make for real: a full disk, say.
  failWrite: { code: null as string | null },
  // This path is another user's, as stat says: a test can't chown one.
  ownedByAnother: { path: null as string | null },
  spawn: vi.fn(),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const statSync = ((path: string, options?: unknown) => {
    const st = (real.statSync as (p: string, o?: unknown) => import("node:fs").Stats)(path, options);
    if (path !== ownedByAnother.path) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st) as object) as import("node:fs").Stats, st, { uid: st.uid + 1 });
  }) as typeof real.statSync;
  return { ...real, statSync, default: { ...real, statSync } };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn,
  execSync,
  execFileSync,
  execFile,
}));
vi.mock("../private-files.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../private-files.js")>();
  return {
    ...real,
    writePrivateFileSync: (file: string, data: string, options?: Parameters<typeof real.writePrivateFileSync>[2]) => {
      if (failWrite.code !== null && file.endsWith("config.json")) {
        throw Object.assign(new Error(`${failWrite.code}: failed, open '${file}'`), { code: failWrite.code });
      }
      real.writePrivateFileSync(file, data, options);
    },
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
vi.mock("../daemon/worker.js", () => ({}));
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    return { state: "answered", info: { ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION, ...a } };
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

home.dir = mkdtempSync(join(tmpdir(), "engram-681-daemon-"));
const XDG = join(home.dir, "config");
const NO_BIN = join(home.dir, "no-bin");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const ENGRAM_DIR = join(home.dir, ".engram");
const CONFIG_FILE = join(ENGRAM_DIR, "config.json");
const ELSEWHERE = join(home.dir, "dotfiles");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(NO_BIN);

const { autoEnableCapture, daemonInstall, daemonStart, daemonStop, daemonUninstall } = await import("../daemon/commands.js");
const { saveFailure } = await import("../config.js");

const KEY = "engram_sk_live_test_681_fine";
const SETTINGS = JSON.stringify({ apiKey: KEY, excludePaths: ["/work"] });
const OFF = JSON.stringify({ apiKey: KEY, autocapture: "off" });
const DENIED = "~/.engram/config.json can't be written: permission denied";

/** What `engram <command>` says when it can't record that capture is off. */
const unrecorded = (command: string, problem: string, fix: string | null) => [
  `Couldn't record that capture is off: ${problem}.`,
  ...(fix
    ? [`  To fix it, run: ${fix}`, `  Then run 'engram ${command}' again, or the next engram command turns capture back on.`]
    : [`  Once it's fixed, run 'engram ${command}' again, or the next engram command turns capture back on.`]),
];

/** What `engram <command>` says when it can't replace an "off" with "on". */
const stillOff = (command: string, problem: string, fix: string | null) => [
  `Note: couldn't record that capture is on: ${problem}.`,
  "  Until it is, other engram commands won't start the daemon again if it stops.",
  ...(fix ? [`  To fix it, run: ${fix}`, `  Then run 'engram ${command}' again.`] : [`  Once it's fixed, run 'engram ${command}' again.`]),
];

afterAll(() => {
  // Made only where the tests run.
  if (existsSync(ENGRAM_DIR)) chmodSync(ENGRAM_DIR, 0o700);
  rmSync(home.dir, { recursive: true, force: true });
});

// POSIX hosts only, and not as root: root writes a file whatever its
// permissions say. The Linux and macOS jobs run these.
describe.skipIf(HOST === "win32" || process.geteuid?.() === 0)("a config.json that can't be written (engram#681)", () => {
  const realIsTTY = process.stdin.isTTY;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    daemon.answering = null;
    failWrite.code = null;
    ownedByAnother.path = null;
    rmSync(XDG, { recursive: true, force: true });
    if (existsSync(ENGRAM_DIR)) chmodSync(ENGRAM_DIR, 0o700);
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    rmSync(ELSEWHERE, { recursive: true, force: true });
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
    // So the next test, and afterAll, can remove what is in it.
    chmodSync(ENGRAM_DIR, 0o700);
    Object.defineProperty(process, "platform", { value: HOST, configurable: true });
    Object.defineProperty(process.stdin, "isTTY", { value: realIsTTY, configurable: true });
    process.exitCode = undefined;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** config.json holds `text`, with `mode`. */
  const config = (text: string, mode = 0o600) => {
    writeFileSync(CONFIG_FILE, text, { mode });
    chmodSync(CONFIG_FILE, mode);
  };
  const modeOf = (path: string) => statSync(path).mode & 0o777;
  const expectUnchanged = (text: string, mode: number) => {
    expect(readFileSync(CONFIG_FILE, "utf-8")).toBe(text);
    expect(modeOf(CONFIG_FILE)).toBe(mode);
    // Nothing written beside it either, a half-made replacement among them.
    chmodSync(ENGRAM_DIR, 0o700);
    expect(readdirSync(ENGRAM_DIR).filter((f) => f.startsWith("config"))).toEqual(["config.json"]);
  };

  /** A daemon answers on the socket: this process stands in for it. */
  function daemonRunning(pid = process.pid): void {
    daemon.answering = { pid };
  }

  /** The daemon, pid 4242, stops on SIGTERM; no other process is signalled. */
  function stopsOnSigterm(): void {
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
  }

  /** A worker that starts and answers on the socket, ready. */
  function startsAWorker(): void {
    spawn.mockImplementation(() => {
      daemonRunning();
      return Object.assign(new EventEmitter(), { pid: process.pid, unref: vi.fn() });
    });
  }

  describe("engram stop", () => {
    it("a read-only config.json: stops the daemon, says capture couldn't be recorded off and the chmod, exits 1", async () => {
      config(SETTINGS, 0o400);
      stopsOnSigterm();
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, "chmod u+w ~/.engram/config.json"));
      expect(out).toEqual(["Daemon stopped (pid 4242)"]);
      expect(process.kill).toHaveBeenCalledWith(4242, "SIGTERM");
      // Not all it was asked to do: a script can tell.
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, 0o400);
    });

    it("with no daemon running: says so too", async () => {
      config(SETTINGS, 0o400);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, "chmod u+w ~/.engram/config.json"));
      expect(out).toEqual(["Daemon is not running."]);
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, 0o400);
    });

    it("what it says is so: the next command starts the daemon again, and stop after the chmod keeps it off", async () => {
      config(SETTINGS, 0o400);
      await daemonStop();
      expect(process.exitCode).toBe(1);
      startsAWorker();
      await autoEnableCapture({ after: "command" });
      expect(spawn).toHaveBeenCalledTimes(1);

      // The fix it gave, then stop again.
      chmodSync(CONFIG_FILE, 0o600);
      stopsOnSigterm();
      out = [];
      errs = [];
      process.exitCode = undefined;
      await daemonStop();
      expect(errs).toEqual([]);
      expect(process.exitCode).toBeUndefined();
      expect(JSON.parse(readFileSync(CONFIG_FILE, "utf-8"))).toEqual({ apiKey: KEY, excludePaths: ["/work"], autocapture: "off" });
      spawn.mockClear();
      await autoEnableCapture({ after: "command" });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("a read-only ~/.engram: the chmod is for the folder", async () => {
      config(SETTINGS);
      chmodSync(ENGRAM_DIR, 0o500);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, "chmod u+w ~/.engram"));
      expect(process.exitCode).toBe(1);
      expect(modeOf(ENGRAM_DIR)).toBe(0o500);
      expectUnchanged(SETTINGS, 0o600);
    });

    it("a read-only ~/.engram with no config.json in it: the chmod is for the folder", async () => {
      chmodSync(ENGRAM_DIR, 0o500);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, "chmod u+w ~/.engram"));
      expect(process.exitCode).toBe(1);
      chmodSync(ENGRAM_DIR, 0o700);
      expect(readdirSync(ENGRAM_DIR)).toEqual([]);
    });

    it("both read-only: the chmod is for both, the folder first", async () => {
      config(SETTINGS, 0o400);
      chmodSync(ENGRAM_DIR, 0o500);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, "chmod u+w ~/.engram ~/.engram/config.json"));
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, 0o400);
    });

    it("a config.json that is a link: no chmod, which would be for another file", async () => {
      mkdirSync(ELSEWHERE);
      const target = join(ELSEWHERE, "engram.json");
      writeFileSync(target, SETTINGS);
      chmodSync(target, 0o400);
      symlinkSync(target, CONFIG_FILE);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, null));
      expect(process.exitCode).toBe(1);
      expect(readFileSync(target, "utf-8")).toBe(SETTINGS);
    });

    it("files that are another user's: no chmod (their chown is said before the command)", async () => {
      config(SETTINGS, 0o400);
      const uid = process.geteuid!();
      vi.spyOn(process, "geteuid").mockReturnValue(uid + 1);
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, null));
      expect(process.exitCode).toBe(1);
    });

    it("a config.json that is another user's in a read-only ~/.engram of yours: no chmod, which wouldn't be enough", async () => {
      config(SETTINGS);
      chmodSync(ENGRAM_DIR, 0o500);
      ownedByAnother.path = CONFIG_FILE;
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, null));
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["with the write permissions there", 0o600],
      ["on a read-only file", 0o400],
    ])("a locked file (EPERM), %s: no chmod, which can't change a locked file", async (_, mode) => {
      config(SETTINGS, mode);
      failWrite.code = "EPERM";
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, null));
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, mode);
    });

    it("permission denied with the write permissions there, as an ACL can deny it: no chmod, which wouldn't help", async () => {
      config(SETTINGS);
      failWrite.code = "EACCES";
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", DENIED, null));
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, 0o600);
    });

    it("a read-only disk: no chmod, even for a read-only file", async () => {
      config(SETTINGS, 0o400);
      failWrite.code = "EROFS";
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", "~/.engram/config.json can't be written: the disk it's on is read-only", null));
      expect(process.exitCode).toBe(1);
    });

    it.each([
      ["ENOSPC", "~/.engram/config.json can't be written: the disk it's on is full"],
      ["EROFS", "~/.engram/config.json can't be written: the disk it's on is read-only"],
      ["EDQUOT", "~/.engram/config.json can't be written: the disk quota is used up"],
      ["EIO", "~/.engram/config.json can't be written (EIO)"],
    ])("%s: says why, with no chmod", async (code, problem) => {
      config(SETTINGS);
      failWrite.code = code;
      await daemonStop();
      expect(errs).toEqual(unrecorded("stop", problem, null));
      expect(process.exitCode).toBe(1);
      // The message of the error names the path: it isn't quoted.
      expect(errs.join("\n")).not.toContain(home.dir);
      expectUnchanged(SETTINGS, 0o600);
    });
  });

  describe("saveFailure", () => {
    const errno = (code: string) => Object.assign(new Error(`${code}: open '${CONFIG_FILE}'`), { code });

    it("no chmod on Windows, where a file's permissions aren't its mode", () => {
      config(SETTINGS, 0o400);
      expect(saveFailure(errno("EACCES"))).toEqual({ problem: DENIED, fix: "chmod u+w ~/.engram/config.json" });
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(saveFailure(errno("EACCES"))).toEqual({ problem: DENIED, fix: null });
    });
  });

  describe("engram uninstall", () => {
    it("a read-only config.json: says capture couldn't be recorded off, exits 1", async () => {
      config(SETTINGS, 0o400);
      await daemonUninstall();
      expect(errs).toEqual(unrecorded("uninstall", DENIED, "chmod u+w ~/.engram/config.json"));
      expect(out).toEqual(["Auto-start isn't on."]);
      expect(process.exitCode).toBe(1);
      expectUnchanged(SETTINGS, 0o400);
    });
  });

  describe("engram start", () => {
    it("over an \"off\" it can't replace: starts the daemon, and says other commands won't start it again", async () => {
      config(OFF, 0o400);
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual(stillOff("start", DENIED, "chmod u+w ~/.engram/config.json"));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(out[0]).toBe(`Engram daemon started (pid ${process.pid})`);
      // Capture is on, as asked.
      expect(process.exitCode).toBeUndefined();
      expectUnchanged(OFF, 0o400);
    });

    it("engram install, over an \"off\" it can't replace: says to run install again", async () => {
      config(OFF, 0o400);
      startsAWorker();
      await daemonInstall();
      expect(errs.slice(0, 4)).toEqual(stillOff("install", DENIED, "chmod u+w ~/.engram/config.json"));
      expect(process.exitCode).toBeUndefined();
      expectUnchanged(OFF, 0o400);
    });

    it("what it says is so: with the daemon stopped, other commands don't start it", async () => {
      config(OFF, 0o400);
      startsAWorker();
      await daemonStart([], {});
      daemon.answering = null;
      spawn.mockClear();
      await autoEnableCapture({ after: "command" });
      expect(spawn).not.toHaveBeenCalled();
    });

    it("over an \"off\", a full disk: says why, with no chmod", async () => {
      config(OFF);
      failWrite.code = "ENOSPC";
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual(stillOff("start", "~/.engram/config.json can't be written: the disk it's on is full", null));
      expect(process.exitCode).toBeUndefined();
    });

    it("with no \"off\" to replace: says nothing, since nothing changes", async () => {
      config(SETTINGS, 0o400);
      startsAWorker();
      await daemonStart([], {});
      expect(errs).toEqual([]);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
      expectUnchanged(SETTINGS, 0o400);
    });
  });
});
