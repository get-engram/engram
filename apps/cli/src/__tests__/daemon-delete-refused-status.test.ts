import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// engram#597: status.json says when the key in use can't delete
// conversations, and how many opt-outs wait for a key that can, so that
// `engram status` says it once. The daemon used to log it at every flush.

const { home, execFile } = vi.hoisted(() => ({ home: { dir: "" }, execFile: vi.fn() }));

// status.ts writes ~/.engram/status.json: point it at a temp home.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));
// No desktop notification is shown for real.
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./helpers/child-process.js")).recordingNoEnvValues({
    ...(await importOriginal<typeof import("node:child_process")>()),
    execFile,
  }),
);

home.dir = mkdtempSync(join(tmpdir(), "engram-597-status-"));
mkdirSync(join(home.dir, ".engram"));
const STATUS_FILE = join(home.dir, ".engram", "status.json");

const {
  deleteRefusedSummary,
  readStatus,
  recordDeletesRefused,
  recordFailure,
  recordSignedIn,
  recordSignedOut,
  recordSuccess,
} = await import("../daemon/status.js");

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const SINCE = "2026-11-09T12:00:00.000Z";

const onDisk = () => JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as Record<string, unknown>;

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

describe("delete_refused in status.json (engram#597)", () => {
  it("says how many wait, and since the first refusal", () => {
    expect(onDisk().delete_refused).toBeNull();
    recordDeletesRefused(1);
    expect(onDisk().delete_refused).toEqual({ since: SINCE, deletes: 1 });
    expect(readStatus().delete_refused).toEqual({ since: SINCE, deletes: 1 });

    // Another opt-out, later: counted, and still since the first.
    vi.setSystemTime(T0 + 60_000);
    recordDeletesRefused(2);
    expect(onDisk().delete_refused).toEqual({ since: SINCE, deletes: 2 });
  });

  it("is written only when it changes", () => {
    recordDeletesRefused(2);
    rmSync(STATUS_FILE);
    // Each flush gives the same count.
    recordDeletesRefused(2);
    expect(existsSync(STATUS_FILE)).toBe(false);
    recordDeletesRefused(3);
    expect(onDisk().delete_refused).toEqual({ since: SINCE, deletes: 3 });
  });

  it("is cleared when none wait, and nothing is written when none did", () => {
    recordDeletesRefused(2);
    recordDeletesRefused(0);
    expect(onDisk().delete_refused).toBeNull();
    rmSync(STATUS_FILE);
    recordDeletesRefused(0);
    expect(existsSync(STATUS_FILE)).toBe(false);
  });

  it("starts over for the next key: signing in or out clears it", () => {
    recordDeletesRefused(2);
    recordSignedIn();
    expect(onDisk().delete_refused).toBeNull();

    vi.setSystemTime(T0 + 60_000);
    recordDeletesRefused(1);
    expect(onDisk().delete_refused).toEqual({ since: "2026-11-09T12:01:00.000Z", deletes: 1 });
    recordSignedOut();
    expect(onDisk().delete_refused).toBeNull();
  });

  it("stays through syncs and sync errors: it isn't about sending", () => {
    recordDeletesRefused(2);
    recordSuccess(0);
    expect(onDisk().delete_refused).toEqual({ since: SINCE, deletes: 2 });
    recordFailure("fetch failed", "network", 3);
    expect(onDisk().health).not.toBe("healthy");
    expect(onDisk().delete_refused).toEqual({ since: SINCE, deletes: 2 });
  });

  it("is null in a status.json written before it existed", () => {
    writeFileSync(STATUS_FILE, JSON.stringify({ health: "healthy" }));
    expect(readStatus().delete_refused).toBeNull();
  });
});

describe("deleteRefusedSummary (engram#597)", () => {
  it.each([
    [1, "1 conversation you opted out of is"],
    [2, "2 conversations you opted out of are"],
    [1234, "1,234 conversations you opted out of are"],
  ])("%i: %s waiting", (deletes, which) => {
    expect(deleteRefusedSummary({ since: SINCE, deletes })).toBe(
      `This API key can't delete conversations, so ${which} waiting to be deleted from Engram. ` +
        `Create a key with the 'delete' permission at getengram.app/dashboard, then run ` +
        `'engram auth login <key>'.`,
    );
  });
});
