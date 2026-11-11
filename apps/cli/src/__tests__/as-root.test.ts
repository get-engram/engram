import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";
import { rootForAnotherUser, type RootCheck } from "../daemon/as-root.js";

/**
 * engram#653 — the daemon and start at login are the user's own. `sudo
 * engram start`, `sudo engram install`, and auto-capture after any `sudo
 * engram …`, would set them up for root instead.
 *
 * These run as whoever runs the tests: being root is process.geteuid
 * stubbed to 0, process.platform is switched, child_process is a fake that
 * records what would have run, and the home directory is a temp dir.
 * Nothing reaches launchd, systemd, ~/Library, ~/.config or ~/.engram.
 */

const { home, daemon, imported, spawn, execSync, execFileSync, execFile, saveConfig } = vi.hoisted(() => ({
  home: { dir: "" },
  // Whether a daemon answers on the socket.
  daemon: { answering: false },
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
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./helpers/child-process.js")).recordingNoEnvValues({
    ...(await importOriginal<typeof import("node:child_process")>()),
    spawn,
    execSync,
    execFileSync,
    execFile,
  }),
);
vi.mock("../config.js", () => {
  const loadConfigStrict = vi.fn(async () => ({ apiKey: "eng_test_653" }));
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
  const probeDaemon = async (): Promise<Probe> =>
    daemon.answering
      ? { state: "answered", info: { pid: 4242, ready: true, stopping: false, stopFile: false, vaultKeyReread: true, vaultChangeNotice: true, version: real.VERSION } }
      : { state: "none", stale: false };
  return { ...real, probeDaemon };
});

/** The OS this runs on. */
const HOST = process.platform;

home.dir = mkdtempSync(join(tmpdir(), "engram-653-"));
const BIN = join(home.dir, "bin");
const CONFIG = join(home.dir, "config");
const WORKER = join(home.dir, "cli", "dist", "daemon", "worker.js");
const PLIST = join(home.dir, "Library", "LaunchAgents", "app.getengram.daemon.plist");
const UNIT = join(CONFIG, "systemd", "user", "engram.service");
const ENGRAM_DIR = join(home.dir, ".engram");
mkdirSync(dirname(WORKER), { recursive: true });
writeFileSync(WORKER, "");
mkdirSync(BIN);
// Never run: execFileSync is the fake. They are there to be found on PATH.
for (const tool of ["launchctl", "systemctl"]) {
  writeFileSync(join(BIN, tool), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
}

const { autoEnableCapture, daemonInstall, daemonStart, daemonStop, daemonUninstall } = await import("../daemon/commands.js");

afterAll(() => {
  rmSync(home.dir, { recursive: true, force: true });
});

describe("who counts as root for someone else", () => {
  /** Root on Linux, in a home root owns, run straight (no sudo). */
  const root: RootCheck = { platform: "linux", euid: 0, env: {}, home: "/root", ownerOf: () => 0 };

  it("is never anyone but root, and never on Windows", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(rootForAnotherUser({ ...root, platform, euid: 1000, env: { SUDO_UID: "1000" }, ownerOf: () => 1000 })).toBe(false);
      expect(rootForAnotherUser({ ...root, platform, euid: undefined, env: { SUDO_UID: "1000" } })).toBe(false);
    }
    expect(rootForAnotherUser({ ...root, platform: "win32", env: { SUDO_UID: "1000" }, ownerOf: () => 1000 })).toBe(false);
  });

  it("is any root on macOS, which has no login session for root", () => {
    expect(rootForAnotherUser({ ...root, platform: "darwin" })).toBe(true);
  });

  it("is root through sudo, run0, pkexec or doas, for someone other than root", () => {
    expect(rootForAnotherUser(root)).toBe(false);
    expect(rootForAnotherUser({ ...root, env: { SUDO_UID: "1000" } })).toBe(true);
    expect(rootForAnotherUser({ ...root, env: { PKEXEC_UID: "1000" } })).toBe(true);
    expect(rootForAnotherUser({ ...root, env: { DOAS_USER: "alex" } })).toBe(true);
    // Root that ran sudo is still root.
    expect(rootForAnotherUser({ ...root, env: { SUDO_UID: "0" } })).toBe(false);
    expect(rootForAnotherUser({ ...root, env: { PKEXEC_UID: "0" } })).toBe(false);
    expect(rootForAnotherUser({ ...root, env: { DOAS_USER: "root" } })).toBe(false);
    // Not a uid: no evidence of anyone else.
    for (const SUDO_UID of ["", "alex", "-1", "1000x"]) {
      expect(rootForAnotherUser({ ...root, env: { SUDO_UID } })).toBe(false);
    }
    expect(rootForAnotherUser({ ...root, env: { DOAS_USER: "" } })).toBe(false);
  });

  it("is root in a home directory someone else owns, as when sudo keeps HOME", () => {
    expect(rootForAnotherUser({ ...root, home: "/home/alex", ownerOf: () => 1000 })).toBe(true);
    // A home that can't be looked at says nothing either way.
    expect(rootForAnotherUser({ ...root, ownerOf: () => null })).toBe(false);
  });

  it("looks at the home directory it is given", () => {
    const asked: string[] = [];
    rootForAnotherUser({ ...root, home: "/home/alex", ownerOf: (path) => (asked.push(path), 0) });
    expect(asked).toEqual(["/home/alex"]);
  });
});

// The commands, as root and as the user. POSIX hosts only: Windows has no
// effective uid to stand in for, and the Linux and macOS jobs run these.
describe.skipIf(HOST === "win32")("engram start, install and auto-capture as root (engram#653)", () => {
  const realIsTTY = process.stdin.isTTY;
  let out: string[];
  let errs: string[];

  beforeEach(() => {
    out = [];
    errs = [];
    daemon.answering = false;
    imported.worker = false;
    rmSync(join(home.dir, "Library"), { recursive: true, force: true });
    rmSync(CONFIG, { recursive: true, force: true });
    rmSync(ENGRAM_DIR, { recursive: true, force: true });
    vi.stubEnv("XDG_CONFIG_HOME", CONFIG);
    vi.stubEnv("PATH", BIN);
    vi.stubEnv("NO_COLOR", "1");
    // What the test run itself sets to keep auto-capture out of other tests.
    vi.stubEnv("ENGRAM_NO_AUTOCAPTURE", "");
    vi.stubEnv("ENGRAM_API_KEY", undefined);
    for (const name of ["SUDO_UID", "PKEXEC_UID", "DOAS_USER"]) vi.stubEnv(name, undefined);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    spawn.mockReset();
    execSync.mockReset();
    execFile.mockReset();
    execFileSync.mockReset().mockReturnValue("");
    saveConfig.mockClear();
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

  /** Run as `platform`, and as root when `asRoot`; otherwise as whoever runs the tests. */
  function on(platform: "darwin" | "linux", asRoot: boolean): void {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    if (asRoot) vi.spyOn(process, "geteuid").mockReturnValue(0);
  }

  /** Nothing ran, and nothing was written: no job, no unit, no ~/.engram, no config. */
  function expectNothingDone(): void {
    expect(spawn).not.toHaveBeenCalled();
    expect(execSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
    expect(imported.worker).toBe(false);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(existsSync(join(home.dir, "Library"))).toBe(false);
    expect(existsSync(CONFIG)).toBe(false);
    expect(existsSync(ENGRAM_DIR)).toBe(false);
  }

  for (const platform of ["darwin", "linux"] as const) {
    describe(`on ${platform === "darwin" ? "macOS" : "Linux"}, through sudo`, () => {
      beforeEach(() => {
        on(platform, true);
        vi.stubEnv("SUDO_UID", "1000");
      });

      it("engram install changes nothing, and says to run it as yourself", async () => {
        await daemonInstall();
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([
          "Start at login is per user, and this is running as root.",
          "  Run 'engram install' as yourself, without sudo.",
        ]);
        expect(out).toEqual([]);
        expectNothingDone();
      });

      it("engram start changes nothing, with --install or --foreground either", async () => {
        // As the CLI parses them: a bare --install is "".
        const cases: Record<string, string>[] = [{}, { install: "" }, { foreground: "" }, { f: "" }];
        for (const flags of cases) {
          errs.length = 0;
          process.exitCode = undefined;
          await daemonStart([], flags);
          expect(process.exitCode).toBe(1);
          expect(errs).toEqual([
            "Engram's daemon runs as you, and this is running as root.",
            "  Run 'engram start' as yourself, without sudo.",
          ]);
        }
        expect(out).toEqual([]);
        expectNothingDone();
      });

      it("engram start changes nothing with a daemon running either", async () => {
        daemon.answering = true;
        await daemonStart([], { install: "" });
        expect(process.exitCode).toBe(1);
        expectNothingDone();
      });

      it("auto-capture after a command does nothing, and says nothing", async () => {
        await autoEnableCapture({ after: "command" });
        expect(out).toEqual([]);
        expect(errs).toEqual([]);
        expectNothingDone();
      });

      it("auto-capture after signing in says why capture isn't on", async () => {
        await autoEnableCapture({ after: "login" });
        expect(out).toEqual([
          "  Auto-capture runs as you, not as root, so it wasn't turned on: sign in again without sudo.",
        ]);
        expect(errs).toEqual([]);
        expect(process.exitCode).toBeUndefined();
        expectNothingDone();
      });

      // Each saves that capture is off: as root, in a config.json root owns,
      // which the user's own CLI then can't read (engram#682).
      it("engram uninstall changes nothing, and says to run it as yourself (engram#682)", async () => {
        await daemonUninstall();
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([
          "Engram runs as you, and this is running as root.",
          "  Run 'engram uninstall' as yourself, without sudo.",
        ]);
        expect(out).toEqual([]);
        expectNothingDone();
      });

      it("engram stop changes nothing with a daemon running, and says to run it as yourself (engram#682)", async () => {
        daemon.answering = true;
        await daemonStop();
        expect(process.exitCode).toBe(1);
        expect(errs).toEqual([
          "Engram runs as you, and this is running as root.",
          "  Run 'engram stop' as yourself, without sudo. For a daemon started with sudo, it says what stops it.",
        ]);
        expect(out).toEqual([]);
        expectNothingDone();
      });
    });
  }

  // The same commands, as the user: what the refusals above stop is real.
  // Skipped when the tests themselves run as root.
  const userIt = process.geteuid?.() === 0 ? it.skip : it;

  userIt("as the user on macOS, engram install writes the plist and asks launchctl", async () => {
    on("darwin", false);
    daemon.answering = true;
    // launchctl's answer for a job it hasn't loaded.
    execFileSync.mockImplementation((_file: string, args: string[]) => {
      if (args[0] === "list") throw new Error('Could not find service "app.getengram.daemon" in domain for port');
      return "";
    });
    await daemonInstall();
    expect(errs).toEqual([]);
    expect(existsSync(PLIST)).toBe(true);
    const files = execFileSync.mock.calls.map((call) => call[0]);
    expect(files).toContain(join(BIN, "launchctl"));
    expect(files).not.toContain("/bin/launchctl");
    expect(execFileSync.mock.calls.map((call) => call[1][0])).toContain("bootstrap");
  });

  userIt("as the user on Linux, engram install writes the unit and asks systemctl", async () => {
    on("linux", false);
    daemon.answering = true;
    await daemonInstall();
    expect(errs).toEqual([]);
    expect(existsSync(UNIT)).toBe(true);
    expect(execFileSync.mock.calls.map((call) => call[0])).toContain(join(BIN, "systemctl"));
  });

  userIt("as the user, engram stop and uninstall save that capture is off", async () => {
    on("linux", false);
    await daemonStop();
    await daemonUninstall();
    expect(saveConfig.mock.calls.map((call) => ((call as unknown[])[0] as { autocapture?: string }).autocapture)).toEqual(["off", "off"]);
  });

  // The temp home is the test user's: to root, it is someone else's home.
  userIt("as root on Linux without sudo, in a home someone else owns, engram install changes nothing", async () => {
    on("linux", true);
    await daemonInstall();
    expect(process.exitCode).toBe(1);
    expect(errs[0]).toBe("Start at login is per user, and this is running as root.");
    expectNothingDone();
  });
});
