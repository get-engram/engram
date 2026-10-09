import { describe, it, expect, vi } from "vitest";
import {
  withD1Retry,
  isQueueRejection,
  isTransientD1Error,
  isMutation,
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
    await expect(dbA.prepare("INSERT INTO t VALUES (1)").run()).resolves.toEqual({
      success: true,
    });
    expect(rejected.calls.run).toBe(2);

    // SQLITE_BUSY on a write may have applied — must NOT be retried, or the
    // insert double-applies.
    const maybeApplied = flakyStmt(1, BUSY);
    const dbB = withD1Retry(dbWith(maybeApplied.stmt), fast);
    await expect(dbB.prepare("INSERT INTO t VALUES (1)").run()).rejects.toThrow(
      /SQLITE_BUSY/,
    );
    expect(maybeApplied.calls.run).toBe(1);
  });

  it("still retries a READ on SQLITE_BUSY", async () => {
    const { stmt, calls } = flakyStmt(1, BUSY);
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("SELECT 1").all()).resolves.toEqual({ results: [] });
    expect(calls.all).toBe(2);
  });

  // ── Regressions for the adversarial review (Oct 2026) ──

  it("treats UPDATE…RETURNING read via .first() as a WRITE", async () => {
    // The defect this file exists to prevent. These are verbatim the shapes
    // used by atomicIncrementStorage / atomicIncrementMessages — writes that
    // finish with .first() because they RETURNING. Classifying by method name
    // retried them on SQLITE_BUSY and double-applied the billing counter.
    const sqls = [
      "UPDATE organizations SET messages_stored_total = messages_stored_total + ? WHERE id = ? RETURNING messages_stored_total",
      "UPDATE usage SET messages_stored = messages_stored + ? WHERE id = ? RETURNING messages_stored",
      "INSERT INTO usage (id) VALUES (?) ON CONFLICT DO UPDATE SET updated_at = datetime('now') RETURNING *",
    ];
    for (const sql of sqls) {
      const { stmt, calls } = flakyStmt(1, BUSY);
      const db = withD1Retry(dbWith(stmt), fast);
      await expect(db.prepare(sql).bind(50, "org_x").first()).rejects.toThrow(
        /SQLITE_BUSY/,
      );
      expect(calls.first, sql).toBe(1); // NOT retried — may have committed
    }
  });

  it("still retries those writes on a true queue rejection", async () => {
    const { stmt, calls } = flakyStmt(1, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), fast);
    await db
      .prepare("UPDATE organizations SET messages_stored_total = messages_stored_total + ? RETURNING x")
      .bind(50)
      .first();
    expect(calls.first).toBe(2); // provably never ran — safe
  });

  it("does NOT treat a storage-layer reset as provably-not-applied", async () => {
    // "storage operation exceeded timeout" can fire after a commit — it is a
    // storage reset, not a pre-execution rejection.
    const msg = "D1_ERROR: D1 storage operation exceeded timeout [7429]";
    expect(isQueueRejection(new Error(msg))).toBe(false);
    expect(isTransientD1Error(new Error(msg))).toBe(true);

    const { stmt, calls } = flakyStmt(1, msg);
    const db = withD1Retry(dbWith(stmt), fast);
    await expect(db.prepare("INSERT INTO t VALUES (1)").run()).rejects.toThrow();
    expect(calls.run).toBe(1);
  });

  it("classifies SQL conservatively", () => {
    for (const q of ["SELECT 1", "  select x from y", "PRAGMA table_info(t)", "WITH a AS (SELECT 1) SELECT * FROM a"]) {
      expect(isMutation(q), q).toBe(false);
    }
    for (const q of [
      "UPDATE t SET x = 1",
      "insert into t values (1)",
      "DELETE FROM t",
      "WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a",
      "-- comment\nUPDATE t SET x = 1",
      "/* block */ DELETE FROM t",
      "REPLACE INTO t VALUES (1)",
    ]) {
      expect(isMutation(q), q).toBe(true);
    }
  });

  it("keeps the 503 predicate at least as broad as the one it replaced", () => {
    // A bare "overloaded" used to map to 503 + Retry-After; narrowing it would
    // silently turn back-pressure into a 500 with no retry hint.
    for (const m of [
      "overloaded",
      "SQLITE_BUSY",
      "Network connection lost",
      "timed out",
      "connection reset",
      "storage is unavailable",
    ]) {
      expect(isTransientD1Error(new Error(m)), m).toBe(true);
    }
  });

  it("wraps statements made through withSession()", async () => {
    const { stmt, calls } = flakyStmt(1, OVERLOAD);
    const base = dbWith(stmt) as unknown as Record<string, unknown>;
    base.withSession = () => ({ prepare: () => stmt });
    const db = withD1Retry(base as unknown as D1Database, fast);
    const session = (db as unknown as { withSession: () => { prepare: (q: string) => D1PreparedStatement } }).withSession();
    await session.prepare("SELECT 1").first();
    expect(calls.first).toBe(2); // retried — not escaping the wrapper
  });

  it("stops retrying once the total time budget is spent", async () => {
    const { stmt, calls } = flakyStmt(99, OVERLOAD);
    const db = withD1Retry(dbWith(stmt), {
      maxRetries: 20,
      baseDelayMs: 100,
      totalBudgetMs: 250,
      random: () => 1,
      sleep: async () => {},
    });
    await expect(db.prepare("SELECT 1").first()).rejects.toThrow(/overloaded/);
    // 100 + 200 would exceed 250, so it gives up after the first sleep.
    expect(calls.first).toBe(2);
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
