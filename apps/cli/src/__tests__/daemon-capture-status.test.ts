import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#584: a transcript that can't be queued in daemon.db is held and
// retried, and the user is told: status.json (`engram status` and the CLI
// banner), one warning in daemon.log and one desktop notification per
// episode. Separate from sync health: a successful send says nothing about
// whether new lines can be queued.

const { home, execFile } = vi.hoisted(() => ({ home: { dir: "" }, execFile: vi.fn() }));

// status.ts writes ~/.engram/status.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-584-status-"));
mkdirSync(join(home.dir, ".engram"));

const {
  recordCaptureStall,
  recordCaptureResumed,
  recordSuccess,
  readStatus,
  captureErrorSummary,
  configProblemSummary,
} = await import("../daemon/status.js");

const FULL = "database or disk is full";
const HOUR = 60 * 60_000;
const realPlatform = process.platform;

// Notifications are rate-limited per process; each test starts two hours
// after the last one, with the limit behind it.
let clock = Date.UTC(2026, 10, 8, 12, 0, 0);

beforeEach(() => {
  clock += 2 * HOUR;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  execFile.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Every test ends with nothing stalled: the set of stalled files is
  // module state.
  expect(readStatus().capture_error).toBeNull();
});

process.on("exit", () => rmSync(home.dir, { recursive: true, force: true }));

const logged = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

describe("capture errors in status.json (engram#584)", () => {
  it("records the first stall, warns once and notifies once", () => {
    recordCaptureStall("/t/a.jsonl", FULL);
    expect(readStatus().capture_error).toEqual({
      message: FULL,
      since: new Date(clock).toISOString(),
      files: 1,
    });
    expect(logged().filter((l) => l.includes("WARNING"))).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "notify-send",
      [
        "Engram can't capture",
        `New messages can't be queued (${FULL}). Free up disk space, or check ~/.engram/daemon.db. ` +
          "Capture resumes where it stopped.",
      ],
      expect.objectContaining({ windowsHide: true, timeout: 30_000 }),
      expect.any(Function),
    );

    // More files, and the same file failing again: counted, not repeated.
    vi.setSystemTime(clock + 60_000);
    recordCaptureStall("/t/b.jsonl", FULL);
    recordCaptureStall("/t/a.jsonl", FULL);
    expect(readStatus().capture_error).toMatchObject({
      since: new Date(clock).toISOString(),
      files: 2,
    });
    expect(logged().filter((l) => l.includes("WARNING"))).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(1);

    recordCaptureResumed("/t/a.jsonl");
    expect(readStatus().capture_error).toMatchObject({ files: 1 });
    recordCaptureResumed("/t/b.jsonl");
    expect(readStatus().capture_error).toBeNull();
    expect(logged()).toContain("[engram] capture resumed: new messages are being queued again");
  });

  it("keeps the latest reason", () => {
    recordCaptureStall("/t/a.jsonl", "database is locked");
    recordCaptureStall("/t/a.jsonl", FULL);
    expect(readStatus().capture_error?.message).toBe(FULL);
    recordCaptureResumed("/t/a.jsonl");
  });

  it("ignores a file that never stalled", () => {
    recordCaptureStall("/t/a.jsonl", FULL);
    recordCaptureResumed("/t/other.jsonl");
    expect(readStatus().capture_error).toMatchObject({ files: 1 });
    recordCaptureResumed("/t/a.jsonl");
    expect(logged().filter((l) => l.includes("capture resumed"))).toHaveLength(1);
  });

  it("isn't cleared by a successful sync", () => {
    recordCaptureStall("/t/a.jsonl", FULL);
    recordSuccess(0);
    expect(readStatus().capture_error).toMatchObject({ message: FULL });
    expect(readStatus().health).toBe("healthy");
    recordCaptureResumed("/t/a.jsonl");
  });

  it("notifies at most once an hour, and logs each episode", () => {
    recordCaptureStall("/t/a.jsonl", FULL);
    recordCaptureResumed("/t/a.jsonl");
    vi.setSystemTime(clock + HOUR - 1);
    recordCaptureStall("/t/a.jsonl", FULL);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(logged().filter((l) => l.includes("WARNING"))).toHaveLength(2);
    recordCaptureResumed("/t/a.jsonl");

    vi.setSystemTime(clock + HOUR);
    recordCaptureStall("/t/a.jsonl", FULL);
    expect(execFile).toHaveBeenCalledTimes(2);
    recordCaptureResumed("/t/a.jsonl");
  });

  it("shortens a long reason, never the advice", () => {
    const long = `disk I/O error: ${"x".repeat(80)}`;
    recordCaptureStall("/t/a.jsonl", long);
    const body = String(execFile.mock.calls[0][1][1]);
    expect(body).toContain(`(${long.slice(0, 59)}…)`);
    expect(body).not.toContain(long);
    expect(body).toMatch(/Free up disk space, or check ~\/\.engram\/daemon\.db\. Capture resumes where it stopped\.$/);
    // status.json keeps the whole reason.
    expect(readStatus().capture_error?.message).toBe(long);
    recordCaptureResumed("/t/a.jsonl");
  });

  it("never lets a notifier failure reach the watcher", () => {
    execFile.mockImplementation(() => {
      throw new Error("spawn ENOENT");
    });
    expect(() => recordCaptureStall("/t/a.jsonl", FULL)).not.toThrow();
    recordCaptureResumed("/t/a.jsonl");
  });
});

// engram#673: transcripts held because config.json can't say which folders
// are excluded are the same episode in status.json, marked "config", in
// words of their own: freeing disk space wouldn't help.
describe("capture held for config.json (engram#673)", () => {
  const BAD = "~/.engram/config.json isn't valid JSON";

  it("records the stall as config's, warns once and notifies once", () => {
    recordCaptureStall("/t/a.jsonl", BAD, "config");
    expect(readStatus().capture_error).toEqual({
      message: BAD,
      since: new Date(clock).toISOString(),
      files: 1,
      kind: "config",
    });
    expect(logged()).toContain(
      `[engram] WARNING: Engram can't read the folders you excluded from capture (${BAD}), so 1 ` +
        "transcript is waiting. Fix the file, and capture picks up where it stopped: nothing is " +
        "skipped, and nothing from an excluded folder is captured.",
    );
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile).toHaveBeenCalledWith(
      "notify-send",
      [
        "Engram paused capture",
        `${BAD}, so Engram can't tell which folders you excluded. Fix it, and capture resumes ` +
          "where it stopped.",
      ],
      expect.objectContaining({ windowsHide: true, timeout: 30_000 }),
      expect.any(Function),
    );

    recordCaptureStall("/t/b.jsonl", BAD, "config");
    expect(readStatus().capture_error).toMatchObject({ files: 2, kind: "config" });
    expect(logged().filter((l) => l.includes("WARNING"))).toHaveLength(1);
    expect(execFile).toHaveBeenCalledTimes(1);

    recordCaptureResumed("/t/a.jsonl");
    expect(readStatus().capture_error).toMatchObject({ files: 1, kind: "config" });
    recordCaptureResumed("/t/b.jsonl");
  });

  it("says what the latest stall was about, when files wait for both", () => {
    recordCaptureStall("/t/a.jsonl", BAD, "config");
    recordCaptureStall("/t/b.jsonl", FULL);
    expect(readStatus().capture_error).toEqual({
      message: FULL,
      since: new Date(clock).toISOString(),
      files: 2,
    });
    recordCaptureStall("/t/a.jsonl", BAD, "config");
    expect(readStatus().capture_error).toMatchObject({ message: BAD, files: 2, kind: "config" });
    recordCaptureResumed("/t/a.jsonl");
    recordCaptureResumed("/t/b.jsonl");
  });
});

describe("captureErrorSummary", () => {
  it("says when config.json is what is wrong, not the disk", () => {
    expect(
      captureErrorSummary({
        message: "~/.engram/config.json is empty",
        since: "",
        files: 2,
        kind: "config",
      }),
    ).toBe(
      "Engram can't read the folders you excluded from capture (~/.engram/config.json is empty), " +
        "so 2 transcripts are waiting. Fix the file, and capture picks up where it stopped: " +
        "nothing is skipped, and nothing from an excluded folder is captured.",
    );
  });

  it("says the same of config.json itself, before anything waits", () => {
    expect(configProblemSummary("~/.engram/config.json isn't valid JSON")).toBe(
      "~/.engram/config.json isn't valid JSON, so Engram can't tell which folders you excluded " +
        "from capture. New messages wait until it's fixed; nothing is skipped.",
    );
  });

  it("says what's wrong, what to do and that nothing is skipped", () => {
    const one = captureErrorSummary({ message: FULL, since: "", files: 1 });
    expect(one).toContain(`(${FULL})`);
    expect(one).toContain("1 transcript is waiting");
    expect(one).toContain("Free up disk space");
    expect(one).toContain("nothing is skipped");
    expect(captureErrorSummary({ message: FULL, since: "", files: 1234 })).toContain(
      "1,234 transcripts are waiting",
    );
  });
});
