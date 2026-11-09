import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#596: status.json says when the daemon next tries what failed, so
// `engram status` can show it, and a maintenance pause is told apart from
// an error on the server's side.

const { home, execFile } = vi.hoisted(() => ({ home: { dir: "" }, execFile: vi.fn() }));

// status.ts writes ~/.engram/status.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// No desktop notification is shown for real.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

home.dir = mkdtempSync(join(tmpdir(), "engram-596-status-"));
mkdirSync(join(home.dir, ".engram"));
const STATUS_FILE = join(home.dir, ".engram", "status.json");

const { recordFailure, recordNextRetry, recordSuccess, recordSignedOut, recordSignedIn, readStatus, syncErrorSummary } =
  await import("../daemon/status.js");

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const PAUSED = "Engram is paused for scheduled maintenance — messages queued, will retry.";

const onDisk = () => JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as Record<string, unknown>;
const logged = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  execFile.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  // The status is module state: every test starts signed in and healthy.
  recordSignedIn();
  recordSuccess(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

describe("next_retry_at in status.json (engram#596)", () => {
  it("records when what failed is tried again, and null when no timer is set", () => {
    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    expect(onDisk().next_retry_at).toBe("2026-11-09T12:00:05.000Z");
    expect(readStatus().next_retry_at).toBe("2026-11-09T12:00:05.000Z");

    // A failure that sets no timer doesn't leave the last one's behind.
    recordFailure("fetch failed", "network", 3);
    expect(onDisk().next_retry_at).toBeNull();
    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    recordFailure("fetch failed", "network", 3, { retryAt: null });
    expect(onDisk().next_retry_at).toBeNull();
  });

  it("is cleared by a success, and by signing out or in", () => {
    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    recordSuccess(0);
    expect(onDisk().next_retry_at).toBeNull();

    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    recordSignedOut();
    expect(onDisk().next_retry_at).toBeNull();

    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    recordSignedIn();
    expect(onDisk().next_retry_at).toBeNull();
  });

  it("is rewritten between failures only when it changes, leaving the failure as it was", () => {
    recordFailure("HTTP 503", "server", 3, { retryAt: T0 + 5_000 });
    const written = onDisk().updated_at;

    vi.setSystemTime(T0 + 1_000);
    recordNextRetry(T0 + 5_000);
    expect(onDisk().updated_at).toBe(written);

    recordNextRetry(T0 + 10_000);
    expect(onDisk()).toMatchObject({
      next_retry_at: "2026-11-09T12:00:10.000Z",
      updated_at: "2026-11-09T12:00:01.000Z",
    });

    // Nothing waits for a set time any more.
    vi.setSystemTime(T0 + 2_000);
    recordNextRetry(null);
    expect(onDisk()).toMatchObject({
      next_retry_at: null,
      updated_at: "2026-11-09T12:00:02.000Z",
      error_type: "server",
      last_error: "HTTP 503",
      pending_messages: 3,
      consecutive_failures: 1,
    });
  });

  it("reads as null from a status.json an older CLI wrote", () => {
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "warning", error_type: "server", pending_messages: 2 }));
    expect(readStatus()).toMatchObject({ next_retry_at: null, error_type: "server", pending_messages: 2 });
  });
});

describe("a maintenance pause in status.json (engram#596)", () => {
  it("is its own kind of failure, logged once, with no desktop notification", () => {
    recordFailure("Engram is paused for a few minutes of scheduled maintenance.", "paused", 4, {
      retryAt: T0 + 5_000,
    });
    recordFailure("Engram is paused for a few minutes of scheduled maintenance.", "paused", 4, {
      retryAt: T0 + 15_000,
    });
    expect(readStatus()).toMatchObject({
      health: "warning",
      error_type: "paused",
      pending_messages: 4,
      next_retry_at: "2026-11-09T12:00:15.000Z",
    });
    expect(logged().filter((l) => l.includes("WARNING"))).toEqual([`[engram] WARNING: ${PAUSED}`]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("has words of its own, and a network failure names Engram", () => {
    expect(syncErrorSummary("paused")).toBe(PAUSED);
    expect(syncErrorSummary("server")).toBe("Server error — messages queued, will retry.");
    expect(syncErrorSummary("network")).toBe("Can't reach Engram — messages queued, will retry.");
  });
});
