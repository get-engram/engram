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

const { recordFailure, recordSuccess } = await import("../daemon/status.js");

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
      expect.any(Function),
    );
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
