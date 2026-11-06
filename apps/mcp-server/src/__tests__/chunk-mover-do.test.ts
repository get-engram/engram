import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock(import("../services/chunk-mover.js"), async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, runChunkMoverBatch: vi.fn() };
});

import { ChunkMoverDO, parseStart, type ChunkMoverState } from "../services/chunk-mover-do.js";
import { emptyCounts, runChunkMoverBatch, type ChunkMoverBatch } from "../services/chunk-mover.js";
import type { Env } from "../types.js";

/**
 * engram#384: the Durable Object that drives the chunk copy/verify job.
 * The page logic is tested against real SQLite and R2 in
 * chunk-text-r2.d1.test.ts; this covers the driver — validation, the
 * cursor, counts, pacing, back-off, and that a stop or a forced restart
 * arriving while a page is in flight is never overwritten by that page.
 */

const batch = vi.mocked(runChunkMoverBatch);

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
      force: false,
    });
    expect(parseStart({ mode: "copy" })).toEqual({ mode: "copy", org: null, start: 0, repair: false, force: false });
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
});
