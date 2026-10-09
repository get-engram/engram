import { describe, it, expect } from "vitest";
import { pruneExpiredOAuthTokens } from "../cron/prune-oauth-tokens.js";
import { enforceAuditRetention, AUDIT_RETENTION_DAYS } from "../cron/audit-retention.js";
import type { Env } from "../types.js";

/**
 * Stub D1 that serves `pages` rows per SELECT page until exhausted, and
 * records every statement + its bindings, so the tests can pin the batching
 * shape without a real database.
 */
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
        all: async () => {
          const table = /FROM (\w+)/.exec(sql)![1];
          const limit = Number(args[args.length - 1]);
          const n = Math.min(remaining[table] ?? 0, limit);
          remaining[table] = (remaining[table] ?? 0) - n;
          log.push({ sql, args });
          const key = /SELECT (\w+)/.exec(sql)![1];
          return { results: Array.from({ length: n }, (_, i) => ({ [key]: `${table}_${i}` })) };
        },
        run: async () => {
          log.push({ sql, args });
          return { success: true, meta: { changes: args.length } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, log, env: { DB: db } as unknown as Env };
}

describe("pruneExpiredOAuthTokens", () => {
  it("deletes expired rows from BOTH token tables in bounded batches", async () => {
    const { env, log } = stubDb({ oauth_access_tokens: 1200, oauth_refresh_tokens: 3 });
    const n = await pruneExpiredOAuthTokens(env);
    expect(n).toBe(1203);
    const deletes = log.filter((l) => l.sql.startsWith("DELETE"));
    // 1200 access rows → 500 + 500 + 200; refresh → one batch of 3
    expect(deletes.map((d) => d.args.length)).toEqual([500, 500, 200, 3]);
    expect(deletes[0].sql).toMatch(/^DELETE FROM oauth_access_tokens WHERE token_hash IN \(/);
    expect(deletes[3].sql).toMatch(/^DELETE FROM oauth_refresh_tokens WHERE token_hash IN \(/);
  });

  it("only ever selects by expiry — never touches a live token", async () => {
    const { env, log } = stubDb({ oauth_access_tokens: 1 });
    await pruneExpiredOAuthTokens(env);
    for (const s of log.filter((l) => l.sql.startsWith("SELECT"))) {
      expect(s.sql).toMatch(/WHERE expires_at < datetime\('now'\)/);
    }
  });

  it("is a no-op when nothing is expired", async () => {
    const { env, log } = stubDb({});
    expect(await pruneExpiredOAuthTokens(env)).toBe(0);
    expect(log.some((l) => l.sql.startsWith("DELETE"))).toBe(false);
  });
});

describe("enforceAuditRetention", () => {
  it("uses the stated floor and nothing shorter", async () => {
    const { env, log } = stubDb({ audit_log: 1 });
    await enforceAuditRetention(env);
    const sel = log.find((l) => l.sql.startsWith("SELECT"))!;
    expect(AUDIT_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
    expect(sel.args[0]).toBe(`-${AUDIT_RETENTION_DAYS} days`);
    expect(sel.sql).toMatch(/created_at < datetime\('now', \?\)/);
  });

  it("caps a run above daily inflow so retention can actually catch up", async () => {
    // 15.4k rows/day inflow measured 2026-10-09; a cap below that never converges.
    const { env } = stubDb({ audit_log: 1_000_000 });
    const n = await enforceAuditRetention(env);
    expect(n).toBeGreaterThan(15_400);
    expect(n).toBe(30_000); // 60 batches × 500 — bounded, not unbounded
  });

  it("deletes by id in batches and stops when the page runs dry", async () => {
    const { env, log } = stubDb({ audit_log: 750 });
    expect(await enforceAuditRetention(env)).toBe(750);
    const deletes = log.filter((l) => l.sql.startsWith("DELETE FROM audit_log WHERE id IN"));
    expect(deletes.map((d) => d.args.length)).toEqual([500, 250]);
  });
});
