import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#581: the notifier called a bare `require`, which doesn't exist in
// this ES-module build. The ReferenceError was swallowed, so no "memory is
// full" or "needs attention" notification was ever shown, and every test
// that only checked "doesn't throw" passed.

const { home, execFile } = vi.hoisted(() => {
  // vi.hoisted runs before imports: use require-free globals only.
  return { home: { dir: "" }, execFile: vi.fn() };
});

// status.ts writes ~/.engram/status.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-581-"));
mkdirSync(join(home.dir, ".engram"));

const { recordFailure, recordSuccess, notifyCommand, notifyDesktopBeforeExit, TOAST_STATEMENTS } = await import(
  "../daemon/status.js"
);

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  recordSuccess(0); // clears the once-per-error-type memory
  execFile.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

describe("desktop notifications (engram#581)", () => {
  it("shows a macOS notification when authentication fails", () => {
    onPlatform("darwin");
    recordFailure("401 Unauthorized", "auth", 3);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFile.mock.calls[0];
    expect(cmd).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain('with title "Engram needs attention"');
    expect(args[1]).toContain("engram auth login");
  });

  it("shows a Linux notification with the numbers when memory is full", () => {
    onPlatform("linux");
    recordFailure("storage_full", "storage_full", 12, { storage: { used: 1000, limit: 1000 } });
    expect(execFile).toHaveBeenCalledWith(
      "notify-send",
      ["Engram memory is full", "1,000/1,000 messages used. New captures are paused."],
      expect.objectContaining({ windowsHide: true, timeout: 30_000 }),
      expect.any(Function),
    );
    // The environment is left alone: notify-send inherits the daemon's.
    expect(execFile.mock.calls[0][2].env).toBeUndefined();
  });

  it("shows a Windows toast, with the title and body kept out of the script (engram#614)", () => {
    onPlatform("win32");
    vi.stubEnv("SystemRoot", "C:\\Windows");
    // Set here, so its name keeps this case: Windows keeps an inherited
    // variable's own, such as SYSTEMROOT, when the environment is copied.
    vi.stubEnv("ENGRAM_TEST_KEPT", "kept");
    recordFailure("401 Unauthorized", "auth", 3);
    expect(execFile).toHaveBeenCalledTimes(1);
    const [file, args, options, callback] = execFile.mock.calls[0];
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", TOAST_STATEMENTS.join("; ")]);
    expect(options).toEqual(expect.objectContaining({ windowsHide: true, timeout: 30_000 }));
    expect(options.env).toEqual(
      expect.objectContaining({
        ENGRAM_NOTIFY_TITLE: "Engram needs attention",
        ENGRAM_NOTIFY_BODY: expect.stringContaining("engram auth login"),
        // the rest of the daemon's environment comes along: PowerShell needs it
        ENGRAM_TEST_KEPT: "kept",
      }),
    );
    expect(callback).toEqual(expect.any(Function));
  });

  it("shows nothing where there is no way to (engram#614)", () => {
    onPlatform("freebsd");
    expect(() => recordFailure("401", "auth", 1)).not.toThrow();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("notifies once per error type until a sync succeeds", () => {
    onPlatform("darwin");
    recordFailure("401", "auth", 1);
    recordFailure("401", "auth", 2);
    expect(execFile).toHaveBeenCalledTimes(1);
    recordSuccess(0);
    recordFailure("401", "auth", 1);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it("stays quiet for errors that clear on their own", () => {
    onPlatform("darwin");
    for (const type of ["network", "server", "rate_limit"] as const) {
      recordFailure("x", type, 1);
    }
    expect(execFile).not.toHaveBeenCalled();
  });

  it("never lets a notifier failure reach syncing", () => {
    onPlatform("darwin");
    execFile.mockImplementation(() => {
      throw new Error("spawn EACCES");
    });
    expect(() => recordFailure("401", "auth", 1)).not.toThrow();
  });

  it("writes status.json under the (temp) home", () => {
    recordFailure("401", "auth", 4);
    const status = JSON.parse(readFileSync(join(home.dir, ".engram", "status.json"), "utf-8"));
    expect(status.error_type).toBe("auth");
    expect(status.pending_messages).toBe(4);
  });
});

describe("how a notification is shown on each platform (engram#614)", () => {
  // What a title or body could hold that a shell, PowerShell, the Windows
  // command line or XML would act on, were it put into a script or markup.
  const TITLE = `Engram's "test" $(Write-Output pwned) \`whoami\``;
  const BODY = `<b>not bold</b> & %PATH% C:\\Users\\O'Brien\\.engram $env:USERPROFILE; exit 1 — …`;

  it("passes the title and body to PowerShell only as environment variables", () => {
    const command = notifyCommand(TITLE, BODY, "win32", "C:\\Windows");
    expect(command).not.toBeNull();
    const { file, args, env } = command!;
    expect(file).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toEqual(["-NoProfile", "-NonInteractive", "-Command", TOAST_STATEMENTS.join("; ")]);
    expect(env).toEqual({ ENGRAM_NOTIFY_TITLE: TITLE, ENGRAM_NOTIFY_BODY: BODY });
    for (const arg of args) {
      for (const part of ["pwned", "whoami", "O'Brien", "<b>", "%PATH%", "USERPROFILE", "exit 1"]) {
        expect(arg).not.toContain(part);
      }
    }
  });

  it("builds a script the Windows command line passes through unchanged", () => {
    const script = notifyCommand(TITLE, BODY, "win32", "C:\\Windows")!.args[3];
    // Double quotes and line breaks are what Windows argument quoting rewrites.
    expect(script).not.toMatch(/["\r\n]/);
    expect(script).toContain("$template.CreateTextNode($env:ENGRAM_NOTIFY_TITLE)");
    expect(script).toContain("$template.CreateTextNode($env:ENGRAM_NOTIFY_BODY)");
    expect(TOAST_STATEMENTS[0]).toBe("$ErrorActionPreference = 'Stop'");
    // Nothing that turns off PowerShell's own checks, or hides what it runs.
    const flags = notifyCommand(TITLE, BODY, "win32")!.args.join(" ").toLowerCase();
    for (const flag of ["-encodedcommand", "-executionpolicy", "bypass", "-file"]) {
      expect(flags).not.toContain(flag);
    }
  });

  it("finds Windows PowerShell under the system root, wherever Windows is", () => {
    expect(notifyCommand("t", "b", "win32", "D:\\WINDOWS")!.file).toBe(
      "D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });

  it("escapes what AppleScript would read on macOS", () => {
    expect(notifyCommand('say "hi" \\ there', 'a "b"', "darwin")).toEqual({
      file: "osascript",
      args: ["-e", 'display notification "a \\"b\\"" with title "say \\"hi\\" \\\\ there"'],
    });
  });

  it("hands Linux the title and body as two arguments", () => {
    expect(notifyCommand(TITLE, BODY, "linux")).toEqual({ file: "notify-send", args: [TITLE, BODY] });
  });

  it("has no way on other platforms", () => {
    expect(notifyCommand(TITLE, BODY, "freebsd")).toBeNull();
    expect(notifyCommand(TITLE, BODY, "aix")).toBeNull();
  });
});

describe("a notification from a daemon about to exit (engram#659)", () => {
  afterEach(() => vi.useRealTimers());

  /** Whether `shown` has settled, once what is already queued has run. */
  async function settled(shown: Promise<void>): Promise<boolean> {
    let done = false;
    void shown.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    return done;
  }

  it("settles once the notification has been shown, and not before", async () => {
    vi.useFakeTimers();
    onPlatform("darwin");
    const shown = notifyDesktopBeforeExit("Engram capture has stopped", "Run the fix.");
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, , callback] = execFile.mock.calls[0];
    expect(cmd).toBe("osascript");
    expect(args[1]).toContain('display notification "Run the fix." with title "Engram capture has stopped"');
    expect(await settled(shown)).toBe(false);
    callback(null, "", "");
    expect(await settled(shown)).toBe(true);
    // Its time limit doesn't keep the process waiting after that.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles when showing it fails", async () => {
    vi.useFakeTimers();
    onPlatform("linux");
    const shown = notifyDesktopBeforeExit("t", "b");
    execFile.mock.calls[0][3](new Error("notify-send: not found"), "", "");
    expect(await settled(shown)).toBe(true);
  });

  it("settles after its time when the notifier doesn't finish", async () => {
    vi.useFakeTimers();
    onPlatform("darwin");
    const shown = notifyDesktopBeforeExit("t", "b", 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(await settled(shown)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(shown)).toBe(true);
  });

  it("settles at once where there is no way to show it, or the notifier can't be started", async () => {
    vi.useFakeTimers();
    onPlatform("freebsd");
    expect(await settled(notifyDesktopBeforeExit("t", "b"))).toBe(true);
    expect(execFile).not.toHaveBeenCalled();
    onPlatform("linux");
    execFile.mockImplementation(() => {
      throw new Error("spawn EAGAIN");
    });
    expect(await settled(notifyDesktopBeforeExit("t", "b"))).toBe(true);
  });
});
