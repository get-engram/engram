import { describe, it, expect } from "vitest";
import { pruneExpiredOAuthTokens } from "../cron/prune-oauth-tokens.js";
import { enforceAuditRetention, AUDIT_RETENTION_DAYS } from "../cron/audit-retention.js";
import type { Env } from "../types.js";

/**
 * These tests exist because the previous ones PASSED while the jobs deleted
 * nothing in production for two nights.
 *
 * The old stub accepted any number of bound parameters, so an IN-list of 500
 * looked fine here and threw `D1_ERROR: too many SQL variables` against the
 * real database — every night, silently, because the scheduled runner
 * isolates per-job failures. The stub below enforces D1's real limits, so a
 * regression fails here instead of in production.
 */
const D1_MAX_BOUND_PARAMS = 100;

/** Stub D1 that enforces the bound-parameter cap and serves rows per DELETE. */
function stubDb(rowsPerTable: Record<string, number>) {
  const log: Array<{ sql: string; args: unknown[] }> = [];
  const remaining = { ...rowsPerTable };
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        run: async () => {
          if (args.length > D1_MAX_BOUND_PARAMS) {
            // The exact failure the real database produced.
            throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
          }
          log.push({ sql, args });
          const table = /DELETE FROM (\w+)/.exec(sql)?.[1];
          const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 0);
          const n = Math.min(remaining[table ?? ""] ?? 0, limit);
          if (table) remaining[table] = (remaining[table] ?? 0) - n;
          return { success: true, meta: { changes: n } };
        },
        all: async () => {
          if (args.length > D1_MAX_BOUND_PARAMS) {
            throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
          }
          log.push({ sql, args });
          return { results: [] };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, log, env: { DB: db } as unknown as Env };
}

const binds = (log: Array<{ args: unknown[] }>) => Math.max(0, ...log.map((l) => l.args.length));

describe("pruneExpiredOAuthTokens", () => {
  it("drains both token tables without ever exceeding D1's parameter cap", async () => {
    const { env, log } = stubDb({ oauth_access_tokens: 1200, oauth_refresh_tokens: 3 });
    const n = await pruneExpiredOAuthTokens(env);
    expect(n).toBe(1203);
    // 1200 access -> 500 + 500 + 200 (stops: 200 < BATCH); refresh -> 3
    expect(log.map((l) => /DELETE FROM (\w+)/.exec(l.sql)![1])).toEqual([
      "oauth_access_tokens",
      "oauth_access_tokens",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
    ]);
    expect(binds(log)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    expect(binds(log)).toBe(0); // the LIMIT is in the SQL; nothing is bound
  });

  it("only ever deletes by expiry — a live token is never in range", async () => {
    const { env, log } = stubDb({ oauth_access_tokens: 1 });
    await pruneExpiredOAuthTokens(env);
    for (const s of log) {
      expect(s.sql).toMatch(/WHERE expires_at < datetime\('now'\)/);
      expect(s.sql).toMatch(/DELETE FROM oauth_(access|refresh)_tokens WHERE token_hash IN \(\s*SELECT/);
    }
  });

  it("is a no-op when nothing is expired", async () => {
    const { env } = stubDb({});
    expect(await pruneExpiredOAuthTokens(env)).toBe(0);
  });

  it("stays bounded on a huge backlog instead of one unbounded delete", async () => {
    const { env, log } = stubDb({ oauth_access_tokens: 10_000_000 });
    const n = await pruneExpiredOAuthTokens(env);
    expect(n).toBe(25_000); // 50 batches x 500, per table
    expect(log.length).toBe(51); // 50 access + 1 refresh probe
  });
});

describe("enforceAuditRetention", () => {
  it("uses the stated floor, binds exactly one parameter, and never exceeds the cap", async () => {
    const { env, log } = stubDb({ audit_log: 1 });
    await enforceAuditRetention(env);
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
    expect(log[0].args).toEqual([`-${AUDIT_RETENTION_DAYS} days`]);
    expect(binds(log)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMS);
    expect(log[0].sql).toMatch(/created_at < datetime\('now', \?\)/);
  });

  it("caps a run above daily inflow so retention can actually catch up", async () => {
    // 15.4k rows/day inflow measured 2026-10-09; a cap below that never converges.
    const { env } = stubDb({ audit_log: 1_000_000 });
    const n = await enforceAuditRetention(env);
    expect(n).toBeGreaterThan(15_400);
    expect(n).toBe(30_000); // 60 batches x 500 — bounded, not unbounded
  });

  it("stops as soon as a batch comes back short", async () => {
    const { env, log } = stubDb({ audit_log: 750 });
    expect(await enforceAuditRetention(env)).toBe(750);
    expect(log.length).toBe(2);
  });
});
