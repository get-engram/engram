import { describe, it, expect, vi } from "vitest";
import {
  withD1Retry,
  isQueueRejection,
  isTransientD1Error,
} from "../services/resilient-d1.js";

const OVERLOAD = "D1_ERROR: D1 DB is overloaded. Requests queued for too long.";
const BUSY = "D1_ERROR: SQLITE_BUSY: database is locked";

/** Statement whose terminal methods fail `failures` times, then succeed. */
function flakyStmt(failures: number, message: string) {
  const calls = { first: 0, run: 0, all: 0 };
  const make = (kind: keyof typeof calls, result: unknown) =>
    vi.fn(async () => {
      calls[kind]++;
      if (calls[kind] <= failures) throw new Error(message);
      return result;
    });
  return {
    calls,
    stmt: {
      bind: vi.fn(function (this: unknown) {
        return this;
      }),
      first: make("first", { ok: 1 }),
      run: make("run", { success: true }),
      all: make("all", { results: [] }),
      raw: vi.fn(async () => []),
    },
  };
}

function dbWith(stmt: unknown) {
  return {
    prepare: vi.fn(() => stmt),
    batch: vi.fn(async () => []),
    exec: vi.fn(async () => ({ count: 0, duration: 0 })),
  } as unknown as D1Database;
}

// Deterministic: no real sleeping, jitter pinned.
const fast = { sleep: async () => {}, random: () => 0.5, maxRetries: 3 };

describe("error classification", () => {
  it("treats a queue rejection as provably-not-applied", () => {
    expect(isQueueRejection(new Error(OVERLOAD))).toBe(true);
    expect(isQueueRejection(new Error("storage operation exceeded timeout [7429]"))).toBe(true);
    // Busy/locked means it MAY have run — not a queue rejection.
    expect(isQueueRejection(new Error(BUSY))).toBe(false);
  });

  it("counts both classes as transient for the 503 mapping", () => {
    expect(isTransientD1Error(new Error(OVERLOAD))).toBe(true);
    expect(isTransientD1Error(new Error(BUSY))).toBe(true);
    expect(isTransientD1Error(new Error("no such column: o.tier"))).toBe(false);
  });
});

describe("withD1Retry", () => {
  it("retries a read through overload and returns the eventual result", async () => {
    const { stmt, calls } = flakyStmt(2, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("SELECT 1").first()).resolves.toEqual({ ok: 1 });
    expect(calls.first).toBe(3);
  });

  it("retries a write ONLY when D1 never ran it", async () => {
    const rejected = flakyStmt(1, OVERLOAD);
    const dbA = withD1Retry(dbWith(rejected.stmt), fast);
    await expect(dbA.prepare("INSERT").run()).resolves.toEqual({ success: true });
    expect(rejected.calls.run).toBe(2);

    // SQLITE_BUSY on a write may have applied — must NOT be retried, or the
    // insert double-applies.
    const maybeApplied = flakyStmt(1, BUSY);
    const dbB = withD1Retry(dbWith(maybeApplied.stmt), fast);
    await expect(dbB.prepare("INSERT").run()).rejects.toThrow(/SQLITE_BUSY/);
    expect(maybeApplied.calls.run).toBe(1);
  });

  it("still retries a READ on SQLITE_BUSY", async () => {
    const { stmt, calls } = flakyStmt(1, BUSY);
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("SELECT 1").all()).resolves.toEqual({ results: [] });
    expect(calls.all).toBe(2);
  });

  it("never retries a non-transient error", async () => {
    const { stmt, calls } = flakyStmt(1, "no such column: o.tier");
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("SELECT x").first()).rejects.toThrow(/no such column/);
    expect(calls.first).toBe(1);
  });

  it("gives up after maxRetries and rethrows the original error", async () => {
    const { stmt, calls } = flakyStmt(99, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), { ...fast, maxRetries: 2 });
    await expect(db.prepare("SELECT 1").first()).rejects.toThrow(/overloaded/);
    expect(calls.first).toBe(3); // initial + 2 retries
  });

  it("keeps bind() chainable and still retrying", async () => {
    const { stmt, calls } = flakyStmt(1, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("SELECT ?").bind(1).first()).resolves.toEqual({ ok: 1 });
    expect(calls.first).toBe(2);
  });

  it("backs off exponentially with full jitter", async () => {
    const delays: number[] = [];
    const { stmt } = flakyStmt(3, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), {
      maxRetries: 3,
      baseDelayMs: 50,
      // Probe the ceiling. Real Math.random() is [0,1), so production delays
      // land strictly below these — this pins the doubling, not the value.
      random: () => 1,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await db.prepare("SELECT 1").first();
    expect(delays).toEqual([50, 100, 200]);
  });

  it("scatters colliding retries instead of reconverging", async () => {
    // The incident was N concurrent queries colliding; identical backoff would
    // just collide again. Different random() must give different delays.
    const seen = new Set<number>();
    for (const r of [0.1, 0.5, 0.9]) {
      const delays: number[] = [];
      const { stmt } = flakyStmt(1, OVERLOAD);
      const db = withD1Retry(dbWith(stmt), {
        baseDelayMs: 100,
        random: () => r,
        sleep: async (ms) => {
          delays.push(ms);
        },
      });
      await db.prepare("SELECT 1").first();
      seen.add(delays[0]);
    }
    expect(seen.size).toBe(3);
  });

  it("does not retry exec() — raw multi-statement SQL can partially apply", async () => {
    const db = dbWith(flakyStmt(0, OVERLOAD).stmt);
    const execMock = vi.fn(async () => {
      throw new Error(OVERLOAD);
    });
    (db as unknown as { exec: unknown }).exec = execMock;
    const wrapped = withD1Retry(db, fast);
    await expect(wrapped.exec("CREATE TABLE t(x)")).rejects.toThrow(/overloaded/);
    expect(execMock).toHaveBeenCalledTimes(1);
  });
});
