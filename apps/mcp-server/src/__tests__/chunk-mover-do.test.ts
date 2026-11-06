import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock(import("../services/chunk-mover.js"), async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, runChunkMoverBatch: vi.fn(), runOrphanSweepBatch: vi.fn() };
});

import { ChunkMoverDO, parseStart, type ChunkMoverState } from "../services/chunk-mover-do.js";
import {
  emptyCounts,
  runChunkMoverBatch,
  runOrphanSweepBatch,
  type ChunkMoverBatch,
  type ChunkMoverCounts,
  type OrphanSweepBatch,
} from "../services/chunk-mover.js";
import type { Env } from "../types.js";

/**
 * engram#384: the Durable Object that drives the chunk copy/verify job and
 * the orphan sweep (engram#557). The page logic is tested against real
 * SQLite and R2 in chunk-text-r2.d1.test.ts and chunk-orphan-sweep.d1.test.ts;
 * this covers the driver — validation, the cursor, counts, pacing,
 * back-off, the delete cap, and that a stop or a forced restart arriving
 * while a page is in flight is never overwritten by that page.
 */

const batch = vi.mocked(runChunkMoverBatch);
const sweep = vi.mocked(runOrphanSweepBatch);

/** In-memory DurableObjectState: storage round-trips through structuredClone like the real one. */
function fakeState() {
  const store = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get(k: string) {
      return store.has(k) ? structuredClone(store.get(k)) : undefined;
    },
    async put(k: string, v: unknown) {
      store.set(k, structuredClone(v));
    },
    async setAlarm(t: number) {
      alarm = t;
    },
    async deleteAlarm() {
      alarm = null;
    },
    async getAlarm() {
      return alarm;
    },
  };
  return {
    state: { storage } as unknown as DurableObjectState,
    saved: () => store.get("s") as ChunkMoverState | undefined,
    alarmAt: () => alarm,
    /** The platform clears an alarm as it fires it. */
    clearFired: () => {
      alarm = null;
    },
  };
}

function page(over: Partial<ChunkMoverBatch> = {}): ChunkMoverBatch {
  return { ...emptyCounts(), nextAfter: 0, done: false, problems: [], ...over };
}

function sweepPage(over: Partial<OrphanSweepBatch> = {}): OrphanSweepBatch {
  return { ...emptyCounts(), nextAfterKey: null, done: false, capped: false, problems: [], ...over };
}

describe("ChunkMoverDO (engram#384)", () => {
  let fs: ReturnType<typeof fakeState>;
  let mover: ChunkMoverDO;
  const env = {} as Env;

  const call = async (path: string, init?: RequestInit) => {
    const res = await mover.fetch(new Request(`https://do${path}`, init));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const start = (body: unknown) =>
    call("/start", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  const fire = async () => {
    fs.clearFired();
    await mover.alarm();
  };

  beforeEach(() => {
    fs = fakeState();
    mover = new ChunkMoverDO(fs.state, env);
    batch.mockReset();
    sweep.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parseStart accepts a well-formed request and names what is wrong with a bad one", () => {
    expect(parseStart({ mode: "verify", org: "org_A-1", start: 10, repair: true })).toEqual({
      mode: "verify",
      org: "org_A-1",
      start: 10,
      repair: true,
      deleteOrphans: false,
      maxDeletes: 0,
      force: false,
    });
    expect(parseStart({ mode: "copy" })).toEqual({
      mode: "copy",
      org: null,
      start: 0,
      repair: false,
      deleteOrphans: false,
      maxDeletes: 0,
      force: false,
    });
    expect(parseStart({ mode: "copy", force: true })).toMatchObject({ force: true });

    expect(parseStart({})).toMatch(/mode/);
    expect(parseStart({ mode: "clear" })).toMatch(/mode/); // stage 2 is not this job
    expect(parseStart({ mode: "copy", repair: true })).toMatch(/verify only/);
    expect(parseStart({ mode: "verify", repair: "yes" })).toMatch(/repair/);
    expect(parseStart({ mode: "copy", org: "a/b" })).toMatch(/org/);
    expect(parseStart({ mode: "copy", org: "x".repeat(65) })).toMatch(/org/);
    expect(parseStart({ mode: "copy", org: 7 })).toMatch(/org/);
    expect(parseStart({ mode: "copy", start: -1 })).toMatch(/start/);
    expect(parseStart({ mode: "copy", start: 1.5 })).toMatch(/start/);
    expect(parseStart({ mode: "copy", start: "5" })).toMatch(/start/);
    expect(parseStart({ mode: "copy", start: Number.MAX_SAFE_INTEGER + 1 })).toMatch(/start/);
    expect(parseStart({ mode: "copy", delete: true })).toMatch(/orphans only/);
    expect(parseStart({ mode: "verify", maxDeletes: 5 })).toMatch(/orphans only/);
  });

  it("parseStart: an orphans run reports unless told to delete, and deleting needs an explicit cap", () => {
    const report = { mode: "orphans", org: null, start: 0, repair: false, deleteOrphans: false, maxDeletes: 0, force: false };
    expect(parseStart({ mode: "orphans" })).toEqual(report);
    expect(parseStart({ mode: "orphans", delete: false })).toEqual(report);
    expect(parseStart({ mode: "orphans", delete: true, maxDeletes: 12, force: true })).toEqual({
      ...report,
      deleteOrphans: true,
      maxDeletes: 12,
      force: true,
    });
    expect(parseStart({ mode: "orphans", delete: true, maxDeletes: 100_000 })).toMatchObject({ maxDeletes: 100_000 });

    expect(parseStart({ mode: "orphans", delete: true })).toMatch(/maxDeletes/);
    for (const bad of [0, -1, 1.5, "5", null, 100_001]) {
      expect(parseStart({ mode: "orphans", delete: true, maxDeletes: bad })).toMatch(/maxDeletes/);
    }
    expect(parseStart({ mode: "orphans", delete: "yes", maxDeletes: 5 })).toMatch(/delete must be a boolean/);
    expect(parseStart({ mode: "orphans", maxDeletes: 5 })).toMatch(/only with delete/);
    // The sweep lists the whole bucket: these would be silently meaningless.
    expect(parseStart({ mode: "orphans", org: "org_1" })).toMatch(/whole bucket/);
    expect(parseStart({ mode: "orphans", start: 5 })).toMatch(/whole bucket/);
    expect(parseStart({ mode: "orphans", repair: true })).toMatch(/whole bucket/);
  });

  it("before any run: status says never started, stop is a no-op, unknown paths 404", async () => {
    expect((await call("/status")).body).toEqual({ active: false, never_started: true, alarmSet: false });
    expect((await call("/stop", { method: "POST" })).body).toEqual({ stopped: false, reason: "never started" });
    expect((await call("/nope")).status).toBe(404);
  });

  it("rejects a body that is not JSON or not valid, and starts nothing", async () => {
    expect(await start("{not json")).toMatchObject({ status: 400, body: { error: "body must be JSON" } });
    expect(await start({ mode: "copy", repair: true })).toMatchObject({ status: 400 });
    expect(fs.saved()).toBeUndefined();
    expect(fs.alarmAt()).toBeNull();
  });

  it("walks pages from the cursor, sums the counts, keeps problem ids, and finishes", async () => {
    const t0 = Date.now();
    const started = await start({ mode: "copy", org: "org_1" });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ started: true, active: true, mode: "copy", org: "org_1", cur: 0 });
    expect(fs.alarmAt()).toBeGreaterThanOrEqual(t0);

    batch
      .mockResolvedValueOnce(page({ scanned: 100, copied: 100, nextAfter: 140 }))
      .mockResolvedValueOnce(
        page({ scanned: 30, copied: 29, putFailed: 1, problems: ["chk_x"], nextAfter: 190, done: true }),
      );
    await fire();

    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[0][1]).toEqual({ mode: "copy", org: "org_1", after: 0, repair: false });
    expect(batch.mock.calls[1][1]).toMatchObject({ after: 140 });

    const s = fs.saved()!;
    expect(s).toMatchObject({
      active: false,
      stoppedReason: "finished",
      cur: 190,
      batches: 2,
      scanned: 130,
      copied: 129,
      putFailed: 1,
      samples: ["chk_x"],
      errors: 0,
    });
    expect(s.finishedAt).not.toBeNull();
    expect(fs.alarmAt()).toBeNull(); // finished: not re-armed
    expect((await call("/status")).body).toMatchObject({ active: false, stoppedReason: "finished", alarmSet: false });
  });

  it("runs at most four pages per alarm, then re-arms after a pause", async () => {
    await start({ mode: "verify" });
    batch.mockImplementation(async (_env, o) => page({ scanned: 100, ok: 100, nextAfter: o.after + 100 }));
    const t0 = Date.now();
    await fire();
    expect(batch).toHaveBeenCalledTimes(4);
    expect(fs.saved()).toMatchObject({ active: true, cur: 400, batches: 4, ok: 400 });
    const delay = fs.alarmAt()! - t0;
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThan(5_000);

    await fire();
    expect(batch.mock.calls[4][1]).toMatchObject({ after: 400 });
  });

  it("keeps only the first twenty problem ids", async () => {
    await start({ mode: "verify" });
    const ids = Array.from({ length: 30 }, (_, i) => `chk_${i}`);
    batch.mockResolvedValueOnce(page({ scanned: 30, missing: 30, problems: ids, nextAfter: 30, done: true }));
    await fire();
    expect(fs.saved()!.samples).toEqual(ids.slice(0, 20));
    expect(fs.saved()!.missing).toBe(30);
  });

  it("refuses a second start while one is active, unless forced", async () => {
    const first = await start({ mode: "copy" });
    const again = await start({ mode: "verify" });
    expect(again.status).toBe(409);
    expect(fs.saved()!.runId).toBe(first.body.runId);

    const forced = await start({ mode: "verify", start: 500, force: true });
    expect(forced.status).toBe(200);
    expect(fs.saved()).toMatchObject({ mode: "verify", cur: 500, active: true });
    expect(fs.saved()!.runId).not.toBe(first.body.runId);
  });

  it("a stop that lands while a page is in flight is not overwritten by that page", async () => {
    await start({ mode: "copy" });
    batch.mockImplementationOnce(async () => {
      await call("/stop", { method: "POST" });
      return page({ scanned: 100, copied: 100, nextAfter: 100 });
    });
    await fire();

    expect(batch).toHaveBeenCalledTimes(1);
    expect(fs.saved()).toMatchObject({ active: false, stoppedReason: "stopped by admin", cur: 0, copied: 0 });
    expect(fs.alarmAt()).toBeNull();
  });

  it("a forced restart that lands while a page is in flight keeps the new run's state", async () => {
    await start({ mode: "copy" });
    let newRunId: unknown;
    batch.mockImplementationOnce(async () => {
      newRunId = (await start({ mode: "verify", start: 7, force: true })).body.runId;
      return page({ scanned: 100, copied: 100, nextAfter: 100 });
    });
    await fire();

    expect(fs.saved()).toMatchObject({ runId: newRunId, mode: "verify", cur: 7, copied: 0, active: true });
    expect(fs.alarmAt()).not.toBeNull(); // the new run's alarm, untouched
  });

  it("retries a failed page from the same cursor after a back-off, then carries on", async () => {
    await start({ mode: "copy" });
    batch.mockResolvedValueOnce(page({ scanned: 100, copied: 100, nextAfter: 100 }));
    batch.mockRejectedValueOnce(new Error("D1_ERROR: overloaded (test)"));
    const t0 = Date.now();
    await fire();

    expect(fs.saved()).toMatchObject({ active: true, cur: 100, errors: 1, consecutiveErrors: 1 });
    expect(fs.saved()!.lastError).toContain("overloaded");
    const delay = fs.alarmAt()! - t0;
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(5_000);

    batch.mockResolvedValueOnce(page({ scanned: 5, copied: 5, nextAfter: 105, done: true }));
    await fire();
    expect(batch.mock.calls[2][1]).toMatchObject({ after: 100 }); // same page again
    expect(fs.saved()).toMatchObject({ active: false, stoppedReason: "finished", cur: 105, consecutiveErrors: 0, errors: 1 });
  });

  it("backs off exponentially to a ceiling and stops after fifty failures in a row", async () => {
    await start({ mode: "copy" });
    batch.mockRejectedValue(new Error("down (test)"));
    const delays: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = Date.now();
      await fire();
      if (fs.alarmAt() !== null) delays.push(fs.alarmAt()! - t0);
    }
    expect(delays.slice(0, 4).map((d) => Math.round(d / 1000))).toEqual([1, 2, 4, 8]);
    expect(Math.max(...delays)).toBeLessThan(61_000);
    expect(delays.length).toBe(49); // the fiftieth failure stops the run instead
    expect(fs.saved()).toMatchObject({
      active: false,
      errors: 50,
      stoppedReason: "stopped after 50 consecutive errors",
    });
    expect(fs.alarmAt()).toBeNull();
  });

  it("resumes from durable state after a restart", async () => {
    await start({ mode: "verify", org: "org_2" });
    batch.mockImplementation(async (_env, o) => page({ scanned: 100, ok: 100, nextAfter: o.after + 100 }));
    await fire();
    expect(fs.saved()).toMatchObject({ cur: 400 });

    const revived = new ChunkMoverDO(fs.state, env);
    fs.clearFired();
    await revived.alarm();
    expect(batch.mock.calls[4][1]).toEqual({ mode: "verify", org: "org_2", after: 400, repair: false });
    expect(fs.saved()).toMatchObject({ cur: 800, ok: 800 });
  });

  it("an alarm with no active run does nothing", async () => {
    await mover.alarm();
    await start({ mode: "copy" });
    await call("/stop", { method: "POST" });
    await fire();
    expect(batch).not.toHaveBeenCalled();
  });

  // ── Orphan sweep (engram#557) ─────────────────────────────────────────────

  it("orphans: pages by key, spends one delete budget across pages, and finishes", async () => {
    const started = await start({ mode: "orphans", delete: true, maxDeletes: 5 });
    expect(started.body).toMatchObject({ mode: "orphans", deleteOrphans: true, maxDeletes: 5, listAfter: null, active: true });

    sweep
      .mockResolvedValueOnce(
        sweepPage({ scanned: 1000, live: 997, orphans: 3, orphansRemoved: 3, problems: ["c1/chk_a", "c1/chk_b", "c2/chk_c"], nextAfterKey: "c2/chk_z" }),
      )
      .mockResolvedValueOnce(
        sweepPage({ scanned: 400, live: 397, young: 1, unrecognized: 1, orphans: 1, orphansRemoved: 1, problems: ["odd", "c9/chk_q"], nextAfterKey: "c9/chk_z", done: true }),
      );
    await fire();

    expect(batch).not.toHaveBeenCalled();
    expect(sweep.mock.calls[0][1]).toEqual({ after: null, deleteOrphans: true, deleteBudget: 5 });
    expect(sweep.mock.calls[1][1]).toEqual({ after: "c2/chk_z", deleteOrphans: true, deleteBudget: 2 });
    expect(fs.saved()).toMatchObject({
      active: false,
      stoppedReason: "finished",
      listAfter: "c9/chk_z",
      batches: 2,
      scanned: 1400,
      live: 1394,
      young: 1,
      unrecognized: 1,
      orphans: 4,
      orphansRemoved: 4,
      samples: ["c1/chk_a", "c1/chk_b", "c2/chk_c", "odd", "c9/chk_q"],
    });
    expect(fs.alarmAt()).toBeNull();
  });

  it("orphans report only: asks the sweep to delete nothing", async () => {
    await start({ mode: "orphans" });
    sweep.mockResolvedValueOnce(sweepPage({ scanned: 10, live: 8, orphans: 2, problems: ["a/chk_1", "a/chk_2"], nextAfterKey: "z", done: true }));
    await fire();
    expect(sweep.mock.calls[0][1]).toEqual({ after: null, deleteOrphans: false, deleteBudget: 0 });
    expect(fs.saved()).toMatchObject({ orphans: 2, orphansRemoved: 0, stoppedReason: "finished" });
  });

  it("orphans: a page over the delete cap stops the run where it stood", async () => {
    await start({ mode: "orphans", delete: true, maxDeletes: 3 });
    sweep
      .mockResolvedValueOnce(sweepPage({ scanned: 1000, orphans: 2, orphansRemoved: 2, nextAfterKey: "a/chk_9" }))
      .mockResolvedValueOnce(sweepPage({ scanned: 1000, orphans: 4, capped: true, nextAfterKey: "a/chk_9" }));
    await fire();

    expect(sweep).toHaveBeenCalledTimes(2);
    expect(sweep.mock.calls[1][1]).toMatchObject({ after: "a/chk_9", deleteBudget: 1 });
    const s = fs.saved()!;
    expect(s).toMatchObject({ active: false, listAfter: "a/chk_9", orphans: 6, orphansRemoved: 2 });
    expect(s.stoppedReason).toMatch(/^delete cap: the page after key a\/chk_9 has 4 orphans and 1 of maxDeletes 3 are left; nothing on that page was deleted$/);
    expect(s.finishedAt).not.toBeNull();
    expect(fs.alarmAt()).toBeNull();
  });

  it("orphans: a stop that lands mid-page wins, and what that page removed is logged rather than lost", async () => {
    await start({ mode: "orphans", delete: true, maxDeletes: 10 });
    sweep.mockImplementationOnce(async () => {
      await call("/stop", { method: "POST" });
      return sweepPage({ scanned: 1000, orphans: 2, orphansRemoved: 2, nextAfterKey: "k/chk_2" });
    });
    await fire();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(fs.saved()).toMatchObject({ active: false, stoppedReason: "stopped by admin", listAfter: null, orphansRemoved: 0 });
    expect(fs.alarmAt()).toBeNull();
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/that page removed 2 orphaned objects, which are not in the run's counts/);
  });

  it("orphans: a failed page is retried from the same key", async () => {
    await start({ mode: "orphans" });
    sweep.mockResolvedValueOnce(sweepPage({ scanned: 1000, live: 1000, nextAfterKey: "m/chk_5" }));
    sweep.mockRejectedValueOnce(new Error("list failed (test)"));
    await fire();
    expect(fs.saved()).toMatchObject({ active: true, listAfter: "m/chk_5", errors: 1, consecutiveErrors: 1 });
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain("page after key m/chk_5 failed");

    sweep.mockResolvedValueOnce(sweepPage({ scanned: 3, live: 3, nextAfterKey: "z/chk_1", done: true }));
    await fire();
    expect(sweep.mock.calls[2][1]).toMatchObject({ after: "m/chk_5" });
    expect(fs.saved()).toMatchObject({ active: false, stoppedReason: "finished", listAfter: "z/chk_1", live: 1003 });
  });

  it("a run persisted before the orphan counts existed keeps counting after the upgrade, without NaN", async () => {
    // What a pre-#557 deploy stored for a run that is still going.
    const before = {
      scanned: 1000, copied: 1000, putFailed: 0, ok: 0, missing: 0, mismatched: 0, repaired: 0,
      raced: 0, orphansRemoved: 0, clearedOk: 0, lost: 0,
      runId: "run-before-557", mode: "copy", org: "org_1", repair: false, cur: 5000, active: true,
      startedAt: "2026-11-06T15:26:30.607Z", finishedAt: null, stoppedReason: null,
      batches: 10, errors: 0, consecutiveErrors: 0, lastError: null, samples: [],
    };
    await fs.state.storage.put("s", before);
    const upgraded = new ChunkMoverDO(fs.state, env);

    batch.mockResolvedValueOnce(page({ scanned: 100, copied: 100, nextAfter: 5100, done: true }));
    fs.clearFired();
    await upgraded.alarm();

    expect(batch.mock.calls[0][1]).toEqual({ mode: "copy", org: "org_1", after: 5000, repair: false });
    const s = fs.saved()!;
    expect(s).toMatchObject({ runId: "run-before-557", scanned: 1100, copied: 1100, cur: 5100, stoppedReason: "finished" });
    for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) {
      expect(Number.isFinite(s[k]), k).toBe(true);
    }
    const summary = vi.mocked(console.log).mock.calls.map((c) => String(c[0])).join("\n");
    expect(summary).toContain("scanned=1100");
    expect(summary).not.toContain("NaN");
  });
});
