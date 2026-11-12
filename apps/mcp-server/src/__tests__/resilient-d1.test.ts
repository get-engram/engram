import { describe, it, expect, vi } from "vitest";
import {
  withD1Retry,
  isQueueRejection,
  isTransientD1Error,
  isMutation,
  type RetryOptions,
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

// ── engram#742: a slow statement is not run again ──

const RESOURCES =
  "D1_ERROR: D1 DB is overloaded. Too many resources consumed within a 10 second window.";
const QUEUE_FULL = "D1_ERROR: D1 DB is overloaded. Too many requests queued.";

/** flakyStmt whose every try takes `ms` on `clock`. */
function timedStmt(failures: number, message: string, ms: number, clock: { t: number }) {
  const flaky = flakyStmt(failures, message);
  const taking =
    <T>(f: () => Promise<T>) =>
    async () => {
      clock.t += ms;
      return f();
    };
  return {
    calls: flaky.calls,
    stmt: {
      ...flaky.stmt,
      first: taking(flaky.stmt.first),
      run: taking(flaky.stmt.run),
      all: taking(flaky.stmt.all),
    },
  };
}

/** Retry options on `clock`: sleeping moves it, as it would in a Worker. */
function on(clock: { t: number }, extra: RetryOptions = {}): RetryOptions {
  return {
    sleep: async (ms) => {
      clock.t += ms;
    },
    random: () => 0.5,
    now: () => clock.t,
    ...extra,
  };
}

/** A database whose batch() fails `failures` times with `message`, then succeeds. */
function batchDb(failures: number, message: string) {
  let calls = 0;
  const db = {
    prepare: vi.fn(),
    batch: vi.fn(async () => {
      calls++;
      if (calls <= failures) throw new Error(message);
      return [];
    }),
  } as unknown as D1Database;
  return { db, calls: () => calls };
}

describe("a slow statement is not run again (#742)", () => {
  it("does not take 'Too many resources consumed' to mean D1 never ran the statement", () => {
    expect(isQueueRejection(new Error(RESOURCES))).toBe(false);
    // Still back-pressure: the error handler answers 503 with Retry-After.
    expect(isTransientD1Error(new Error(RESOURCES))).toBe(true);
  });

  it("still takes a timed-out or full queue to mean the statement never ran", () => {
    for (const m of [OVERLOAD, QUEUE_FULL, "D1_ERROR: Requests queued for too long"]) {
      expect(isQueueRejection(new Error(m)), m).toBe(true);
    }
  });

  it("runs a read that took 2 s and failed with it once, not six times", async () => {
    const clock = { t: 0 };
    const { stmt, calls } = timedStmt(99, RESOURCES, 2000, clock);
    const db = withD1Retry(dbWith(stmt), on(clock));
    await expect(
      db.prepare("SELECT COUNT(DISTINCT organization_id) AS n FROM messages").first(),
    ).rejects.toThrow(/Too many resources consumed/);
    expect(calls.first).toBe(1);
  });

  it("never retries a write that failed with it, however quickly", async () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE organizations SET messages_stored_total = messages_stored_total + ? RETURNING x",
    ]) {
      const clock = { t: 0 };
      const { stmt, calls } = timedStmt(1, RESOURCES, 5, clock);
      const db = withD1Retry(dbWith(stmt), on(clock));
      await expect(db.prepare(sql).bind(1).run()).rejects.toThrow(/Too many resources/);
      await expect(db.prepare(sql).bind(1).first()).rejects.toThrow(/Too many resources/);
      expect(calls.run, sql).toBe(1);
      expect(calls.first, sql).toBe(1);
    }
  });

  it("never retries a batch that failed with it, and still retries one the queue turned away", async () => {
    const resources = batchDb(1, RESOURCES);
    await expect(withD1Retry(resources.db, fast).batch([])).rejects.toThrow(/Too many resources/);
    expect(resources.calls()).toBe(1);

    const full = batchDb(1, QUEUE_FULL);
    await expect(withD1Retry(full.db, fast).batch([])).resolves.toEqual([]);
    expect(full.calls()).toBe(2);
  });

  it("retries a read that failed quickly with it: another statement was the load", async () => {
    const clock = { t: 0 };
    const { stmt, calls } = timedStmt(2, RESOURCES, 20, clock);
    const db = withD1Retry(dbWith(stmt), on(clock));
    await expect(db.prepare("SELECT 1").first()).resolves.toEqual({ ok: 1 });
    expect(calls.first).toBe(3);
  });

  it("draws the line at a second: a 999 ms try is retried, a 1000 ms one isn't", async () => {
    for (const [ms, tries] of [
      [999, 2],
      [1000, 1],
    ] as const) {
      const clock = { t: 0 };
      const { stmt, calls } = timedStmt(1, RESOURCES, ms, clock);
      const db = withD1Retry(dbWith(stmt), on(clock));
      const read = db.prepare("SELECT 1").first();
      if (tries === 2) await expect(read).resolves.toEqual({ ok: 1 });
      else await expect(read).rejects.toThrow(/Too many resources/);
      expect(calls.first, `${ms} ms`).toBe(tries);
    }
  });

  it("applies to every transient error that may have run, not only that one", async () => {
    const clock = { t: 0 };
    const { stmt, calls } = timedStmt(99, "D1_ERROR: Network connection lost.", 1500, clock);
    const db = withD1Retry(dbWith(stmt), on(clock));
    await expect(db.prepare("SELECT 1").all()).rejects.toThrow(/Network connection lost/);
    expect(calls.all).toBe(1);
  });

  it("retries a slow queue rejection: D1 never ran it, so the time went on waiting", async () => {
    const clock = { t: 0 };
    const { stmt, calls } = timedStmt(1, OVERLOAD, 1500, clock);
    const db = withD1Retry(dbWith(stmt), on(clock));
    await expect(db.prepare("INSERT INTO t VALUES (1)").run()).resolves.toEqual({ success: true });
    await expect(db.prepare("SELECT 1").first()).resolves.toEqual({ ok: 1 });
    expect(calls.run).toBe(2);
    expect(calls.first).toBe(2);
  });

  it("counts the time tries took against the budget, not only the sleeps", async () => {
    // 1200 + 50 + 1200 + 100 + 1200 is past 3000 before the third sleep. The
    // sleeps alone (50, 100, 200, 400, 800) would have allowed all five retries.
    const clock = { t: 0 };
    const { stmt, calls } = timedStmt(99, OVERLOAD, 1200, clock);
    const db = withD1Retry(dbWith(stmt), on(clock));
    await expect(db.prepare("SELECT 1").first()).rejects.toThrow(/queued for too long/);
    expect(calls.first).toBe(3);
  });

  it("takes the threshold and the budget from the options", async () => {
    const clock = { t: 0 };
    const slow = timedStmt(1, RESOURCES, 300, clock);
    const strict = withD1Retry(dbWith(slow.stmt), on(clock, { slowTryMs: 300 }));
    await expect(strict.prepare("SELECT 1").first()).rejects.toThrow(/Too many resources/);
    expect(slow.calls.first).toBe(1);

    const queued = timedStmt(99, OVERLOAD, 1200, clock);
    const roomy = withD1Retry(dbWith(queued.stmt), on(clock, { totalBudgetMs: 60_000 }));
    await expect(roomy.prepare("SELECT 1").first()).rejects.toThrow(/queued for too long/);
    expect(queued.calls.first).toBe(6); // the first try and maxRetries' five
  });
});
