import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type Mock } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Probe } from "../daemon/instance.js";

/**
 * engram#602 — the daemon on Windows. `engram start` built the worker's path
 * from URL#pathname and died with MODULE_NOT_FOUND on "C:\C:\…", and
 * `--install` wrote a macOS plist and ran launchctl.
 *
 * These run the Windows code paths on any OS: process.platform is switched to
 * win32, reg.exe is a fake registry, the home directory is a temp dir, and
 * nothing reaches the real registry, launchd or ~/.engram.
 *
 * engram#612 — the daemon is what answers on its named pipe, never a PID
 * file alone. Here `daemon.answering` is what answers, and process.kill is
 * fake: a signal reaches only a made-up process, never a real one.
 */

const { home, registry, daemon, spawn, execSync, execFileSync } = vi.hoisted(() => {
  // vi.hoisted runs before imports: use require-free globals only.
  return {
    home: { dir: "" },
    // HKCU\…\Run and StartupApproved\Run, as far as our one value goes:
    // the Run entry's command line, and the switch's data as reg exports it.
    registry: { value: null as string | null, approved: null as string | null },
    // What answers on the daemon's named pipe: a daemon, something that
    // holds it and doesn't answer, no pipe to be had at all, or nothing.
    daemon: {
      answering: null as
        | { pid: number; ready?: boolean; stopping?: boolean; version?: string }
        | "silent"
        | "unavailable"
        | null,
    },
    spawn: vi.fn(),
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

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
vi.mock("../config.js", () => ({
  loadConfig: vi.fn(async () => ({})),
  saveConfig: vi.fn(async () => {}),
  getBaseUrl: () => "https://engram.invalid",
  resolveBaseUrl: () => "https://engram.invalid",
}));
// An install has dist/daemon/login-start.js beside launch.js; under vitest the
// module beside launch.ts is login-start.ts. Point at a file that exists.
vi.mock("../daemon/launch.js", async (importOriginal) => {
  const path = await import("node:path");
  return {
    ...(await importOriginal<typeof import("../daemon/launch.js")>()),
    loginStartPath: () => path.join(home.dir, "login-start.js"),
  };
});
// The probe answers from `daemon.answering`; the rest is the real module.
vi.mock("../daemon/instance.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../daemon/instance.js")>();
  const probeDaemon = async (): Promise<Probe> => {
    const a = daemon.answering;
    if (a === null) return { state: "none", stale: false };
    if (a === "silent") return { state: "silent" };
    if (a === "unavailable") return { state: "unavailable", reason: "no pipe in this test" };
    return { state: "answered", info: { ready: true, stopping: false, version: real.VERSION, ...a } };
  };
  return { ...real, probeDaemon };
});

home.dir = mkdtempSync(join(tmpdir(), "engram-602-"));
const ENGRAM_DIR = join(home.dir, ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const PLIST = join(home.dir, "Library", "LaunchAgents", "app.getengram.daemon.plist");
const LOGIN_START = join(home.dir, "login-start.js");
writeFileSync(LOGIN_START, "");

const { workerPathFor, loginStartPathFor, workerPath } = await import("../daemon/launch.js");
const { VERSION } = await import("../daemon/instance.js");
const {
  daemonInstall,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  parseApprovedExport,
  parseRunExport,
  runEntryCommand,
  waitForWorker,
} = await import("../daemon/commands.js");
const { claudeProjectDir } = await import("../daemon/parser.js");
const { recoveredSessionMeta } = await import("../daemon/db.js");
const { openUrlCommand } = await import("../commands/upgrade.js");

const REG_EXE = "C:\\Windows\\System32\\reg.exe";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const APPROVED_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
const APPROVED_EXPORTED = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
// Startup apps' switch for an entry, as reg export writes it: off carries
// the time it was switched off.
const SWITCHED_OFF = "hex:03,00,00,00,d0,7a,1b,9c,2f,4e,dc,01";
const SWITCHED_ON = "hex:02,00,00,00,00,00,00,00,00,00,00,00";
const ENTRY = `"${realpathSync.native(process.execPath)}" "${LOGIN_START}"`;
const BROKEN_ENTRY = '"C:\\old\\node.exe" "C:\\old\\cli\\dist\\daemon\\login-start.js"';

/** A string value as a .reg file writes it. */
function regString(data: string): string {
  return `"${data.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** What `reg export` writes for a key (the Run key unless named): UTF-16 with a byte-order mark. */
function regExport(
  values: Record<string, string>,
  subkeyValues: Record<string, string> = {},
  key = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
): Buffer {
  const lines = [
    "Windows Registry Editor Version 5.00",
    "",
    `[${key}]`,
    ...Object.entries(values).map(([name, data]) => `"${name}"=${data}`),
    "",
    `[${key}\\AutorunsDisabled]`,
    ...Object.entries(subkeyValues).map(([name, data]) => `"${name}"=${data}`),
    "",
    "",
  ];
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(lines.join("\r\n"), "utf16le")]);
}

/** reg.exe against `registry`; a missing value fails as reg does (exit 1). */
function fakeReg(_file: string, args: string[]): string {
  const [verb, key, ...rest] = args;
  const approved = key === APPROVED_KEY;
  if (!approved && key !== RUN_KEY) throw new Error(`unexpected key ${key}`);
  const missing = () =>
    Object.assign(new Error("ERROR: The system was unable to find the specified registry key or value."), {
      status: 1,
    });
  const ok = "The operation completed successfully.\r\n\r\n";
  switch (verb) {
    case "export": {
      if (approved) {
        const others = { OneDrive: SWITCHED_ON };
        const values = registry.approved === null ? others : { ...others, Engram: registry.approved };
        writeFileSync(rest[0], regExport(values, {}, APPROVED_EXPORTED));
        return ok;
      }
      const others = { OneDrive: regString('"C:\\Users\\op\\OneDrive.exe" /background') };
      const values = registry.value === null ? others : { ...others, Engram: regString(registry.value) };
      writeFileSync(rest[0], regExport(values));
      return ok;
    }
    case "add":
      // The switch is the user's; the CLI only ever clears it.
      if (approved) throw new Error("never writes the Startup apps switch");
      registry.value = rest[rest.indexOf("/d") + 1];
      return ok;
    case "delete":
      if (approved) {
        if (registry.approved === null) throw missing();
        registry.approved = null;
        return ok;
      }
      if (registry.value === null) throw missing();
      registry.value = null;
      return ok;
    default:
      throw new Error(`unexpected reg ${verb}`);
  }
}

/** A spawned worker, as far as the CLI looks at one. */
function fakeChild(pid: number | undefined = process.pid) {
  return Object.assign(new EventEmitter(), { pid, unref: vi.fn() });
}

/** A worker that starts and answers on the pipe, ready. */
function fakeSpawn() {
  daemonRunning();
  return fakeChild();
}

/** A daemon: it answers on the pipe and wrote its PID file. This process stands in for it unless `pid` is made up. */
function daemonRunning(pid = process.pid): void {
  pidFile(pid);
  daemon.answering = { pid };
}

/** A PID file naming `pid`, and nothing more. */
function pidFile(pid: number): void {
  mkdirSync(ENGRAM_DIR, { recursive: true });
  writeFileSync(PID_FILE, String(pid));
}

/**
 * Made-up processes for `engram stop`, by PID: the fake kill finds these
 * (and this process) alive, and sends a signal to these alone. A signal for
 * any other PID fails the test before it reaches a process.
 */
const processes = new Map<number, { onTerm?: () => void }>();
/** The signals the fake kill took, in order. */
const signalled: Array<[number, string]> = [];
const timers: NodeJS.Timeout[] = [];

function fakeKill(pid: number, signal: string | number = "SIGTERM"): true {
  if (signal === 0) {
    if (pid === process.pid || processes.has(pid)) return true;
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }
  const proc = processes.get(pid);
  if (!proc) throw new Error(`a test sent ${String(signal)} to pid ${pid}, which no test made up`);
  signalled.push([pid, String(signal)]);
  if (signal === "SIGTERM") proc.onTerm?.();
  return true;
}

/**
 * A made-up process. It exits `exitsIn` ms from now, or `onTermExitsIn` ms
 * after SIGTERM, or never; its pipe goes with it.
 */
function madeUp(pid: number, when: { exitsIn?: number; onTermExitsIn?: number } = {}): void {
  const exit = () => {
    processes.delete(pid);
    const a = daemon.answering;
    if (a !== null && typeof a === "object" && a.pid === pid) daemon.answering = null;
  };
  const { exitsIn, onTermExitsIn } = when;
  processes.set(pid, {
    onTerm: onTermExitsIn === undefined ? undefined : () => void timers.push(setTimeout(exit, onTermExitsIn)),
  });
  if (exitsIn !== undefined) timers.push(setTimeout(exit, exitsIn));
}

function strayPlist(): void {
  mkdirSync(dirname(PLIST), { recursive: true });
  writeFileSync(PLIST, "<plist/>");
}

function regCalls(verb: string): unknown[][] {
  return execFileSync.mock.calls.filter(([, args]) => args[0] === verb);
}

function output(): string {
  return [console.log as Mock, console.error as Mock]
    .flatMap((m) => m.mock.calls.map((c) => c.join(" ")))
    .join("\n");
}

const realPlatform = process.platform;
function onWindows(): void {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}

beforeEach(() => {
  registry.value = null;
  registry.approved = null;
  daemon.answering = null;
  processes.clear();
  signalled.length = 0;
  vi.spyOn(process, "kill").mockImplementation(fakeKill);
  rmSync(PID_FILE, { force: true });
  rmSync(join(home.dir, "Library"), { recursive: true, force: true });
  spawn.mockReset().mockImplementation(fakeSpawn);
  execSync.mockReset();
  execFileSync.mockReset().mockImplementation(fakeReg);
  vi.stubEnv("SystemRoot", "C:\\Windows");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const t of timers.splice(0)) clearTimeout(t);
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  process.exitCode = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("the worker's path (engram#602)", () => {
  const dir = "C:\\Users\\John Smith\\AppData\\Roaming\\npm\\node_modules\\@getengram\\cli\\dist\\daemon\\";
  const url =
    "file:///C:/Users/John%20Smith/AppData/Roaming/npm/node_modules/@getengram/cli/dist/daemon/launch.js";

  it("is a Windows path with one drive prefix and the space decoded", () => {
    expect(workerPathFor(url, true)).toBe(`${dir}worker.js`);
    expect(loginStartPathFor(url, true)).toBe(`${dir}login-start.js`);
  });

  it("decodes letters outside ASCII", () => {
    expect(
      workerPathFor(
        "file:///C:/Users/Ana%20Mar%C3%ADa/AppData/Roaming/npm/node_modules/@getengram/cli/dist/daemon/launch.js",
        true,
      ),
    ).toBe("C:\\Users\\Ana María\\AppData\\Roaming\\npm\\node_modules\\@getengram\\cli\\dist\\daemon\\worker.js");
  });

  it("decodes a space on macOS and Linux too", () => {
    // URL#pathname left it as %20 there as well.
    expect(
      workerPathFor(
        "file:///Users/John%20Smith/.npm-global/lib/node_modules/@getengram/cli/dist/daemon/launch.js",
        false,
      ),
    ).toBe("/Users/John Smith/.npm-global/lib/node_modules/@getengram/cli/dist/daemon/worker.js");
  });

  it("is never built from URL#pathname", () => {
    for (const file of ["launch.ts", "login-start.ts", "commands.ts", "instance.ts"]) {
      const src = readFileSync(join(__dirname, "..", "daemon", file), "utf-8");
      expect(src).not.toMatch(/\.pathname\b/);
    }
  });
});

describe("Windows transcript paths (engram#602)", () => {
  const claudeFile = "C:\\Users\\op\\.claude\\projects\\C--Users-op-code-engram\\0b7d5e.jsonl";

  it("files a Windows Claude Code session under its project", () => {
    expect(claudeProjectDir(claudeFile)).toBe("engram");
    expect(claudeProjectDir("/Users/op/.claude/projects/-Users-op-code-engram/0b7d5e.jsonl")).toBe("engram");
  });

  it("recognizes recovered Windows sessions by host", () => {
    expect(recoveredSessionMeta("s1", claudeFile)).toMatchObject({
      host: "claude-code",
      projectDir: "engram",
      recovered: true,
    });
    expect(
      recoveredSessionMeta(
        "s2",
        "C:\\Users\\op\\.codex\\sessions\\2026\\11\\08\\rollout-2026-11-08T10-00-00-0b7d5e.jsonl",
      ),
    ).toMatchObject({ host: "codex", recovered: true });
  });
});

describe("the Windows startup entry (engram#602)", () => {
  const command = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\John Smith\\login-start.js"';

  it("quotes both paths, so spaces in them survive", () => {
    expect(runEntryCommand("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\John Smith\\login-start.js")).toBe(
      command,
    );
  });

  const read = (exported: Buffer) => parseRunExport(exported.toString("utf16le"));

  it("is read back out of a reg export, escapes undone", () => {
    expect(read(regExport({ Engram: regString(command) }))).toBe(command);
  });

  it("keeps letters that reg query would have mangled", () => {
    // reg query prints in the console's code page; the export is UTF-16.
    const accented = '"C:\\Users\\Ana María\\node.exe" "C:\\Users\\Ana María\\login-start.js"';
    expect(read(regExport({ OneDrive: regString("x"), Engram: regString(accented) }))).toBe(accented);
    const cjk = '"C:\\Users\\田中\\node.exe" "C:\\Users\\田中\\login-start.js"';
    expect(read(regExport({ Engram: regString(cjk) }))).toBe(cjk);
  });

  it("is not found when only other programs, or a subkey, have one", () => {
    expect(read(regExport({}))).toBeNull();
    expect(read(regExport({ EngramHelper: regString("C:\\helper.exe") }))).toBeNull();
    // Autoruns parks switched-off entries in a subkey; that one isn't on.
    expect(read(regExport({}, { Engram: regString(command) }))).toBeNull();
    expect(parseRunExport("")).toBeNull();
  });

  it("is there, unreadable, when it isn't a plain string", () => {
    expect(read(regExport({ Engram: "hex(2):22,00,43,00,00,00" }))).toBe("");
  });

  const switchedOff = (values: Record<string, string>) =>
    parseApprovedExport(regExport(values, {}, APPROVED_EXPORTED).toString("utf16le"));

  it("is switched off in Startup apps when its switch's first byte is odd", () => {
    expect(switchedOff({ Engram: SWITCHED_OFF })).toBe(true);
    expect(switchedOff({ Engram: SWITCHED_ON })).toBe(false);
    expect(switchedOff({ Engram: "hex:06,00,00,00,00,00,00,00,00,00,00,00" })).toBe(false);
    // Long binary data wraps; the first byte is always on the first line.
    expect(switchedOff({ Engram: "hex:03,00,00,00,d0,7a,1b,9c,2f,\\\n  4e,dc,01" })).toBe(true);
  });

  it("is on when Startup apps has no switch for it", () => {
    // Windows writes one only once someone flips it.
    expect(switchedOff({ OneDrive: SWITCHED_OFF })).toBe(false);
    expect(switchedOff({})).toBe(false);
    expect(parseApprovedExport("")).toBe(false);
  });
});

describe("opening checkout in the browser (engram#602)", () => {
  const url = "https://checkout.stripe.com/c/pay/cs_test_a1#fid=x&next=it's";

  it("hands the URL over as one argument, with no shell in between", () => {
    expect(openUrlCommand(url, "darwin")).toEqual({ file: "/usr/bin/open", args: [url] });
    expect(openUrlCommand(url, "linux")).toEqual({ file: "xdg-open", args: [url] });
    expect(openUrlCommand(url, "win32", "C:\\Windows")).toEqual({
      file: "C:\\Windows\\System32\\rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    });
  });

  it("runs the rundll32 in the system's own Windows directory", () => {
    expect(openUrlCommand(url, "win32", "D:\\WINDOWS")?.file).toBe("D:\\WINDOWS\\System32\\rundll32.exe");
  });

  it("opens only web URLs", () => {
    for (const notWeb of ["file:///C:/Windows/notepad.exe", "ms-settings:startupapps", "not a url"]) {
      for (const platform of ["darwin", "linux", "win32"] as const) {
        expect(openUrlCommand(notWeb, platform)).toBeNull();
      }
    }
  });
});

describe("start at login on Windows (engram#602)", () => {
  it("engram install adds a Run entry and starts the daemon, with no launchd", async () => {
    onWindows();
    await daemonInstall();

    expect(registry.value).toBe(ENTRY);
    expect(regCalls("add")).toHaveLength(1);
    expect(regCalls("add")[0][1]).toEqual(["add", RUN_KEY, "/v", "Engram", "/t", "REG_SZ", "/d", ENTRY, "/f"]);
    for (const [file, , opts] of execFileSync.mock.calls) {
      expect(file).toBe(REG_EXE);
      expect(opts).toMatchObject({ windowsHide: true });
    }

    // No plist, no ~/Library, no launchctl.
    expect(existsSync(join(home.dir, "Library"))).toBe(false);
    expect(execSync).not.toHaveBeenCalled();

    // launchctl load starts the agent on macOS; install starts it here too.
    expect(output()).toContain("Engram daemon started");
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = spawn.mock.calls[0];
    expect(file).toBe(process.execPath);
    expect(args).toEqual([workerPath()]);
    expect(opts).toMatchObject({ detached: true, windowsHide: true });
  });

  it("engram install says so when the daemon it starts dies", async () => {
    onWindows();
    spawn.mockImplementation(() => {
      const child = fakeChild();
      setTimeout(() => child.emit("exit", 1, null), 50);
      return child;
    });
    await daemonInstall();
    expect(registry.value).toBe(ENTRY);
    expect(output()).toContain("Daemon failed to start");
    expect(output()).toContain(`type "${join(ENGRAM_DIR, "daemon.log")}"`);
    expect(process.exitCode).toBe(1);
  });

  it("engram install turns an entry switched off in Startup apps back on", async () => {
    onWindows();
    daemonRunning();
    registry.value = ENTRY;
    registry.approved = SWITCHED_OFF;
    await daemonInstall();
    expect(registry.approved).toBeNull();
    expect(registry.value).toBe(ENTRY);
  });

  it("engram start repairs an entry but leaves the Startup apps switch where it is", async () => {
    onWindows();
    registry.value = BROKEN_ENTRY;
    registry.approved = SWITCHED_OFF;
    await daemonStart([], {});
    expect(registry.value).toBe(ENTRY);
    expect(registry.approved).toBe(SWITCHED_OFF);
    expect(regCalls("delete")).toHaveLength(0);
  });

  it("engram install leaves a running daemon alone", async () => {
    onWindows();
    daemonRunning();
    await daemonInstall();
    expect(registry.value).toBe(ENTRY);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("engram start --install starts one daemon and adds the entry", async () => {
    onWindows();
    await daemonStart([], { install: "" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(registry.value).toBe(ENTRY);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("engram start --install adds the entry when the daemon is already running", async () => {
    onWindows();
    daemonRunning();
    await daemonStart([], { install: "" });
    expect(spawn).not.toHaveBeenCalled();
    expect(registry.value).toBe(ENTRY);
  });

  it("engram start waits for a worker that is slow to load, then installs", async () => {
    // Node's first start on Windows is slow while antivirus scans each file;
    // half a second was the old limit.
    onWindows();
    spawn.mockImplementation(() => {
      setTimeout(daemonRunning, 1_200);
      return fakeChild();
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await daemonStart([], { install: "" });
    expect(exit).not.toHaveBeenCalled();
    expect(output()).toContain("Engram daemon started");
    expect(registry.value).toBe(ENTRY);
  });

  it("engram start reports a worker that dies, and installs nothing", async () => {
    onWindows();
    spawn.mockImplementation(() => {
      const child = fakeChild();
      setTimeout(() => child.emit("exit", 1, null), 50);
      return child;
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await daemonStart([], { install: "" });
    expect(exit).toHaveBeenCalledWith(1);
    expect(output()).toContain("Daemon failed to start");
    expect(output()).toContain(`type "${join(ENGRAM_DIR, "daemon.log")}"`);
    expect(registry.value).toBeNull();
  });

  it("engram start repairs an entry whose programs are gone", async () => {
    onWindows();
    registry.value = BROKEN_ENTRY;
    await daemonStart([], {});
    expect(registry.value).toBe(ENTRY);
  });

  it("engram start leaves a working entry as it is", async () => {
    onWindows();
    const working = `"${process.execPath}" "${LOGIN_START}"`;
    registry.value = working;
    await daemonStart([], {});
    expect(registry.value).toBe(working);
    expect(regCalls("add")).toHaveLength(0);
  });

  it("engram uninstall removes the entry, and the plist older CLIs wrote", async () => {
    onWindows();
    strayPlist();
    registry.value = ENTRY;
    await daemonUninstall();
    expect(registry.value).toBeNull();
    expect(regCalls("delete")[0][1]).toEqual(["delete", RUN_KEY, "/v", "Engram", "/f"]);
    expect(existsSync(PLIST)).toBe(false);
    expect(execSync).not.toHaveBeenCalled();
  });

  it("engram uninstall clears a Startup apps switch along with the entry", async () => {
    onWindows();
    registry.value = ENTRY;
    registry.approved = SWITCHED_OFF;
    await daemonUninstall();
    expect(registry.value).toBeNull();
    expect(registry.approved).toBeNull();
  });

  it("engram uninstall says so when start at login was never on", async () => {
    onWindows();
    await daemonUninstall();
    expect(output()).toContain("Auto-start isn't on.");
    expect(regCalls("delete")).toHaveLength(0);
  });

  it("engram status shows the entry, and a broken one, running or not", async () => {
    onWindows();
    registry.value = ENTRY;
    await daemonStatus();
    expect(output()).toContain("stopped");
    expect(output()).toContain("enabled (Windows sign-in)");
    expect(output()).not.toContain("broken");

    (console.log as Mock).mockClear();
    daemonRunning();
    registry.value = BROKEN_ENTRY;
    await daemonStatus();
    expect(output()).toContain("running");
    expect(output()).toContain("broken, run 'engram start' to repair");
  });

  it("engram status says when the entry is switched off in Startup apps", async () => {
    onWindows();
    registry.value = ENTRY;
    registry.approved = SWITCHED_OFF;
    await daemonStatus();
    expect(output()).toContain("off — switched off in Windows Startup apps");
    expect(output()).toContain("'engram install' turns it back on");
    expect(output()).not.toContain("enabled (Windows sign-in)");

    (console.log as Mock).mockClear();
    registry.approved = SWITCHED_ON;
    await daemonStatus();
    expect(output()).toContain("enabled (Windows sign-in)");
    expect(output()).not.toContain("switched off");
  });

  it("a plist an older CLI wrote never reads as auto-start", async () => {
    onWindows();
    strayPlist();
    daemonRunning();
    await daemonStatus();
    expect(output()).not.toContain("Auto-start");
    expect(execSync).not.toHaveBeenCalled();
  });
});

describe("waiting for the worker to start (engram#602, engram#612)", () => {
  it("is running once it answers on the pipe as itself, ready", async () => {
    const child = fakeChild(4242);
    timers.push(setTimeout(() => (daemon.answering = { pid: 4242 }), 250));
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "running", pid: 4242 });
  });

  it("is still starting while it answers as not ready yet", async () => {
    daemon.answering = { pid: 4242, ready: false };
    expect(await waitForWorker(fakeChild(4242) as never, 300)).toEqual({ state: "starting", pid: 4242 });
  });

  it("is still starting while alive and not answering, whatever the PID file says", async () => {
    // A PID file isn't an answer: one left by an earlier daemon can name
    // this PID as well.
    pidFile(4242);
    expect(await waitForWorker(fakeChild(4242) as never, 300)).toEqual({ state: "starting", pid: 4242 });
  });

  it("isn't running while another daemon answers and it hasn't exited", async () => {
    daemon.answering = { pid: 777 };
    expect(await waitForWorker(fakeChild(4242) as never, 300)).toEqual({ state: "starting", pid: 4242 });
  });

  it("is running once its PID file names it, where there is no pipe or socket", async () => {
    // A home folder too long for a socket path (see daemonEndpoint).
    daemon.answering = "unavailable";
    timers.push(setTimeout(() => pidFile(4242), 250));
    expect(await waitForWorker(fakeChild(4242) as never, 5_000)).toEqual({ state: "running", pid: 4242 });
  });

  it("has failed once it exits, without waiting out the limit", async () => {
    const child = fakeChild(4242);
    timers.push(setTimeout(() => child.emit("exit", 1, null), 50));
    const before = Date.now();
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "failed" });
    expect(Date.now() - before).toBeLessThan(2_000);
  });

  it("is the daemon already running when it exits 0, having found that one", async () => {
    // launchd started one as the plist loaded, or two starts raced: the
    // worker found a daemon answering and left the capture to it.
    daemon.answering = { pid: 777 };
    const child = fakeChild(4242);
    timers.push(setTimeout(() => child.emit("exit", 0, null), 50));
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "running", pid: 777 });
  });

  it("waits for that daemon to be ready", async () => {
    daemon.answering = { pid: 777, ready: false };
    const child = fakeChild(4242);
    timers.push(setTimeout(() => child.emit("exit", 0, null), 50));
    timers.push(setTimeout(() => (daemon.answering = { pid: 777 }), 400));
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "running", pid: 777 });
  });

  it("has failed when it exits 0 and no daemon answers", async () => {
    const child = fakeChild(4242);
    timers.push(setTimeout(() => child.emit("exit", 0, null), 50));
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "failed" });
  });

  it("has failed when it could not be started at all", async () => {
    const child = fakeChild(undefined);
    timers.push(setTimeout(() => child.emit("error", new Error("spawn EAGAIN")), 50));
    expect(await waitForWorker(child as never, 5_000)).toEqual({ state: "failed" });
  });
});

describe("one daemon, found by its pipe, on Windows (engram#612)", () => {
  it("engram stop signals the daemon, waits for it to exit, and removes its PID file", async () => {
    onWindows();
    daemonRunning(4242);
    madeUp(4242, { onTermExitsIn: 300 });
    await daemonStop();
    expect(signalled).toEqual([[4242, "SIGTERM"]]);
    expect(output()).toContain("Daemon stopped (pid 4242)");
    // On Windows SIGTERM ends the process outright: it removes nothing itself.
    expect(existsSync(PID_FILE)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("engram stop waits for a daemon that is stopping already, and doesn't signal it again", async () => {
    onWindows();
    daemonRunning(4242);
    daemon.answering = { pid: 4242, stopping: true };
    madeUp(4242, { exitsIn: 300 });
    await daemonStop();
    expect(signalled).toEqual([]);
    expect(output()).toContain("Daemon stopped (pid 4242)");
  });

  it("engram stop signals nothing that only a PID file names", async () => {
    // Signing out ends the daemon without a chance to clean up, and Windows
    // reuses PIDs: the one in the file can be another program's by now.
    onWindows();
    pidFile(4242);
    madeUp(4242);
    await daemonStop();
    expect(signalled).toEqual([]);
    expect(output()).toContain("Daemon is not running.");
    expect(process.exitCode).toBeUndefined();
  });

  it("engram stop signals nothing when the pipe's answer and the PID file disagree", async () => {
    // A pipe's name is one namespace for the whole machine.
    onWindows();
    pidFile(5151);
    madeUp(5151);
    daemon.answering = { pid: 4242 };
    madeUp(4242);
    await daemonStop();
    expect(signalled).toEqual([]);
    expect(output()).toContain("doesn't name it, so nothing was stopped");
    expect(process.exitCode).toBe(1);
  });

  it("engram stop signals nothing when something holds the pipe and doesn't answer", async () => {
    onWindows();
    pidFile(4242);
    madeUp(4242);
    daemon.answering = "silent";
    await daemonStop();
    expect(signalled).toEqual([]);
    expect(output()).toContain("isn't answering, and no process could be confirmed as it");
    expect(process.exitCode).toBe(1);
  });

  it("engram status reports a daemon only when one answers", async () => {
    onWindows();
    pidFile(4242);
    madeUp(4242);
    await daemonStatus();
    expect(output()).toContain("Status: stopped");
    expect(output()).not.toContain("4242");
  });

  it("engram status says when the daemon is busy, still starting, or stopping", async () => {
    onWindows();
    daemon.answering = "silent";
    await daemonStatus();
    expect(output()).toContain("Status: not answering — the daemon's named pipe is held, but nothing replies");

    (console.log as Mock).mockClear();
    daemon.answering = { pid: 4242, ready: false };
    await daemonStatus();
    expect(output()).toContain("Status: running (pid 4242)");
    expect(output()).toContain("Still starting up.");

    (console.log as Mock).mockClear();
    daemon.answering = { pid: 4242, stopping: true };
    await daemonStatus();
    expect(output()).toContain("Status: stopping (pid 4242)");
  });

  it("engram status says when the daemon runs another version, and how to switch", async () => {
    onWindows();
    daemon.answering = { pid: 4242, version: "0.6.9" };
    await daemonStatus();
    expect(output()).toContain(
      `It runs version 0.6.9, and this CLI is ${VERSION}: run 'engram stop' and then 'engram start' to switch.`,
    );

    (console.log as Mock).mockClear();
    daemon.answering = { pid: 4242 };
    await daemonStatus();
    expect(output()).not.toContain("It runs version");
  });

  it("engram start starts a daemon when only a PID file names a process", async () => {
    onWindows();
    pidFile(4242);
    madeUp(4242);
    await daemonStart([], {});
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output()).toContain("Engram daemon started");
    expect(signalled).toEqual([]);
  });

  it("engram start waits for a daemon that is stopping, then starts one", async () => {
    // `engram stop` and then `engram start`, with a send still finishing.
    onWindows();
    daemon.answering = { pid: 4242, stopping: true };
    madeUp(4242, { exitsIn: 300 });
    await daemonStart([], {});
    expect(output()).toContain("Waiting for the daemon that is stopping (pid 4242) to finish...");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(output()).toContain("Engram daemon started");
  });

  it("engram start starts no second daemon beside one that isn't answering", async () => {
    onWindows();
    daemon.answering = "silent";
    await daemonStart([], {});
    expect(spawn).not.toHaveBeenCalled();
    expect(output()).toContain("Daemon already running, but it isn't answering right now");
  });
});

// Last: resetModules leaves the modules imported above on their old instances.
describe("the Windows sign-in launcher (engram#602)", () => {
  it("starts the worker hidden, without trusting the last session's PID file", async () => {
    // Signing out ended the old daemon; its PID may belong to another program
    // now, as this test's PID file (naming a live process) stands in for.
    // The worker finds out for itself whether a daemon runs (engram#612).
    pidFile(process.pid);
    vi.resetModules();
    await import("../daemon/login-start.js");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][2]).toMatchObject({ detached: true, windowsHide: true });
  });

  /**
   * The modules of ours that `entries` (in src/daemon) load, all the way
   * down, failing on any import that is neither a Node built-in nor ours.
   * `dynamic`: import() too, not only the imports that load first.
   */
  function modulesLoaded(entries: string[], dynamic: boolean): string[] {
    const imports = dynamic ? /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g : /\b(?:from|import)\s+["']([^"']+)["']/g;
    const seen = new Set<string>();
    const visit = (file: string): void => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf-8");
      const specifiers = [...src.matchAll(imports)].map((m) => m[1]);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const s of specifiers) {
        if (s.startsWith("node:")) continue;
        expect(s.startsWith("./") || s.startsWith("../"), `${basename(file)} imports ${s}`).toBe(true);
        visit(join(dirname(file), s.replace(/\.js$/, ".ts")));
      }
    };
    for (const file of entries) visit(join(__dirname, "..", "daemon", file));
    return [...seen].map((f) => basename(f)).sort();
  }

  it("imports nothing but Node built-ins: it runs before the ABI preflight", () => {
    // launch.ts, login-start.ts, and every module of ours they import, all
    // the way down: launch.ts imports private-files.ts (engram#627).
    // A new import here is a new module to check for the same rule.
    expect(modulesLoaded(["launch.ts", "login-start.ts"], true)).toEqual([
      "launch.ts",
      "login-start.ts",
      "private-files.ts",
    ]);
  });

  it("the worker claims its lock with Node built-ins only, before the ABI preflight", () => {
    // worker.ts takes the single-daemon lock (instance.ts, engram#612) and
    // then preflights better-sqlite3: neither may load it. The daemon's
    // body comes after, through import().
    expect(modulesLoaded(["worker.ts"], false)).toEqual([
      "instance.ts",
      "launch.ts",
      "preflight.ts",
      "private-files.ts",
      "worker.ts",
    ]);
    const worker = readFileSync(join(__dirname, "..", "daemon", "worker.ts"), "utf-8");
    expect(worker).toContain('await import("./worker-main.js")');
  });
});
