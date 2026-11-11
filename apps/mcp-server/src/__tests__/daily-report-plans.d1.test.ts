import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { buildDailyReport } from "../services/daily-report.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#740: no statement in the daily report may read a large table end to
 * end.
 *
 * The report's "active orgs, last 24 h" count planned as
 * `SCAN messages USING INDEX idx_messages_org`: with no planner statistics,
 * SQLite gets the DISTINCT for free from the org index and checks created_at
 * on every row. On production (2026-11-11) that was 3.88M rows and 7.6 s per
 * run. D1 runs one statement at a time, so the scan held every user's query
 * behind it, tripped D1's 10-second resource limit and failed the report.
 * Same planner trap as #559, and the same fix: INDEXED BY.
 *
 * These tests run EXPLAIN QUERY PLAN over the exact SQL buildDailyReport
 * issues (captured, not copied) against the real migrations. A dropped hint,
 * a renamed index or a new report statement that walks a large table fails
 * here instead of at 13:00 UTC.
 */

/** Tables too large for any report statement to read end to end. */
const LARGE_TABLES = ["messages", "message_revisions", "conversation_chunks", "audit_log"];

function recording(db: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, sql };
}

/** One line per plan step, as production's EXPLAIN QUERY PLAN prints them. */
async function planOf(db: D1Database, sql: string): Promise<string[]> {
  const params = (sql.match(/\?/g) ?? []).map(() => "x");
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

/** Plan steps that walk a whole large table or a whole index of one. */
function fullReads(plan: string[]): string[] {
  return plan.filter((line) => LARGE_TABLES.some((t) => new RegExp(`^SCAN ${t}\\b`).test(line)));
}

describe("daily report statements never walk a large table (engram#740)", () => {
  let mf: Miniflare;
  let db: D1Database;
  let sql: string[];

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "daily-report-plans" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
    const rec = recording(db);
    // No STRIPE_SECRET_KEY: revenue reports unavailable without a network call.
    await buildDailyReport({ DB: rec.db } as unknown as Env);
    sql = rec.sql;
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("captures the report's statements", () => {
    expect(sql.length).toBeGreaterThan(5);
    expect(sql.some((s) => /\bFROM messages\b/.test(s))).toBe(true);
  });

  it("no statement reads a large table end to end", async () => {
    for (const s of sql) {
      expect({ sql: s, fullReads: fullReads(await planOf(db, s)) }).toEqual({ sql: s, fullReads: [] });
    }
  });

  it("active orgs (24 h) is a range read on idx_messages_created", async () => {
    const s = sql.find((q) => q.includes("COUNT(DISTINCT organization_id)"));
    expect(s, "no active-orgs statement").toBeDefined();
    expect((await planOf(db, s!)).join(" | ")).toMatch(
      /SEARCH messages USING (COVERING )?INDEX idx_messages_created \(created_at>\?\)/,
    );
  });

  it("without the hint, the same statement walks every message (the trap this guards)", async () => {
    const s = sql.find((q) => q.includes("COUNT(DISTINCT organization_id)"))!;
    const unhinted = s.replace(/ INDEXED BY \w+/, "");
    expect(unhinted).not.toBe(s);
    expect(fullReads(await planOf(db, unhinted))).toEqual([expect.stringMatching(/^SCAN messages\b/)]);
  });
});
