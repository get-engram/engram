import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Miniflare } from "miniflare";
import { buildDailyReport } from "../services/daily-report.js";
import { sendWeeklyDigests } from "../cron/weekly-digest.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * The daily report and the weekly digest count the messages of a recent
 * window: the last day, the last 7 days. They must read only that window,
 * through idx_messages_created, never every message the service holds.
 *
 * A plan that is right without planner statistics can be wrong with them,
 * and whether D1 has statistics for a table is not up to this code (ANALYZE
 * and PRAGMA optimize write them). The report's `COUNT(DISTINCT
 * organization_id) … WHERE created_at >= …` walked idx_messages_org, every
 * message, and failed the report of 2026-11-11 (engram#740, pinned by
 * engram#741; daily-report-plans.d1.test.ts checks every report statement
 * without statistics). The digest's old join of organizations to the week's
 * messages sought idx_messages_created without statistics. With statistics
 * that say each org stores many messages, it read each org's messages
 * through idx_messages_org, which is again every message (engram#743). Both
 * are the trap of engram#559: D1 runs one statement at a time, so a
 * statement that walks the table makes every other query wait.
 *
 * These run EXPLAIN QUERY PLAN over the SQL each job issues (captured, not
 * copied) against the real migrations, once without planner statistics and
 * once with illustrative ones, then check the numbers the jobs produce on
 * real SQLite.
 */

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

const readsMessages = (sql: string) => /\b(?:FROM|JOIN)\s+messages\b/i.test(sql);

/** The names a statement reads the messages table by: its own, and any alias. */
function messagesNames(sql: string): Set<string> {
  const names = new Set(["messages"]);
  for (const [, word] of sql.matchAll(/\b(?:FROM|JOIN)\s+messages\s+(?:AS\s+)?(\w+)/gi)) {
    if (!/^(INDEXED|NOT|WHERE|ON|USING|JOIN|INNER|LEFT|CROSS|GROUP|ORDER|LIMIT)$/i.test(word)) names.add(word);
  }
  return names;
}

/** The plan steps that read messages. */
function messageSteps(sql: string, plan: string[]): string[] {
  const names = messagesNames(sql);
  return plan.filter((line) => {
    const step = /^(?:SCAN|SEARCH) (\w+)/.exec(line);
    return step !== null && names.has(step[1]);
  });
}

/** The one way to read a window of messages: a range seek on created_at. */
const WINDOW_SEEK = /^SEARCH \w+ USING (COVERING )?INDEX idx_messages_created \(created_at>\?\)$/;

/**
 * Planner statistics for a service with many orgs that each store many
 * messages, about one message per second. Illustrative, not measured; what
 * matters is their shape. Written into sqlite_stat1 the way ANALYZE would.
 */
const BUSY_STATS: Array<[table: string, index: string | null, stat: string]> = [
  ["messages", null, "10000000"],
  ["messages", "idx_messages_org", "10000000 1000"],
  ["messages", "idx_messages_created", "10000000 2"],
  ["messages", "idx_messages_conv_seq", "10000000 100 1"],
  ["organizations", null, "10000"],
  ["organizations", "sqlite_autoindex_organizations_1", "10000 1"],
];

async function withStats(db: D1Database): Promise<void> {
  await db.prepare("ANALYZE").run(); // creates sqlite_stat1
  await db.batch([
    db.prepare("DELETE FROM sqlite_stat1"),
    ...BUSY_STATS.map(([table, index, stat]) =>
      db.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)").bind(table, index, stat),
    ),
  ]);
  await db.prepare("ANALYZE sqlite_schema").run(); // the planner reloads them
}

const APP_URL = "https://app.example.test";

function jobEnv(db: D1Database): Env {
  return {
    DB: db,
    APP_URL,
    INTERNAL_CRON_SECRET: "internal-window-test",
    UNSUBSCRIBE_HMAC_KEY: "unsubscribe-window-test",
  } as unknown as Env;
}

describe("the report and the digest read only their window of messages", () => {
  let mf: Miniflare;
  let db: D1Database;
  let planners: Array<[name: string, db: D1Database]>;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "message-window-plans", BUSY: "message-window-plans-busy" },
    });
    db = await mf.getD1Database("DB");
    const busy = await mf.getD1Database("BUSY");
    await applyAllMigrations(db);
    await applyAllMigrations(busy);
    await withStats(busy);
    planners = [
      ["without statistics", db],
      ["with statistics for many orgs that each store many messages", busy],
    ];
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  let posted: Array<{ to: string; saved: number }>;

  beforeEach(async () => {
    await db.batch([
      db.prepare("DELETE FROM messages"),
      db.prepare("DELETE FROM conversations"),
      db.prepare("DELETE FROM organizations"),
    ]);
    posted = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { to: string; saved: number };
      posted.push({ to: body.to, saved: body.saved });
      return new Response("{}", { status: 200 });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Each statement that reads messages reads it once, by a seek on the window. */
  async function expectWindowSeeks(sql: string[], count: number) {
    const reads = sql.filter(readsMessages);
    expect(reads.length).toBe(count);
    for (const [planner, plannerDb] of planners) {
      for (const s of reads) {
        const plan = await planOf(plannerDb, s);
        expect({ planner, sql: s, plan, steps: messageSteps(s, plan) }).toEqual({
          planner,
          sql: s,
          plan,
          steps: [expect.stringMatching(WINDOW_SEEK)],
        });
      }
    }
  }

  it("daily report: both of its message counts seek the last day in idx_messages_created", async () => {
    const rec = recording(db);
    await buildDailyReport(jobEnv(rec.db));
    await expectWindowSeeks(rec.sql, 2);
  });

  it("weekly digest: the active-org query seeks the last 7 days in idx_messages_created", async () => {
    const rec = recording(db);
    await sendWeeklyDigests(jobEnv(rec.db));
    await expectWindowSeeks(rec.sql, 1);
  });

  let seq = 0;
  async function org(id: string, opts: { email?: string | null; deleted?: boolean; optedOut?: boolean } = {}) {
    const email = opts.email === undefined ? `${id}@example.test` : opts.email;
    await db.batch([
      db
        .prepare(
          `INSERT INTO organizations (id, name, email, digest_opt_out, deleted_at)
           VALUES (?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)`,
        )
        .bind(id, `Org ${id}`, email, opts.optedOut ? 1 : 0, opts.deleted ? 1 : 0),
      db.prepare("INSERT INTO conversations (id, organization_id) VALUES (?, ?)").bind(`conv_${id}`, id),
    ]);
  }
  /** `n` messages stored by `orgId`, `hoursAgo` hours ago. */
  async function stored(orgId: string, hoursAgo: number, n = 1) {
    const stmts = [];
    for (let i = 0; i < n; i++) {
      seq += 1;
      stmts.push(
        db
          .prepare(
            `INSERT INTO messages (id, conversation_id, organization_id, role, content, sequence, created_at)
             VALUES (?, ?, ?, 'user', 'x', ?, datetime('now', ?))`,
          )
          .bind(`msg_w${seq}`, `conv_${orgId}`, orgId, seq, `-${hoursAgo} hours`),
      );
    }
    await db.batch(stmts);
  }

  it("daily report: counts the last day's messages and the orgs that stored them", async () => {
    await org("org_a");
    await org("org_b");
    await org("org_c");
    await stored("org_a", 1, 3);
    await stored("org_a", 23);
    await stored("org_b", 12, 2);
    await stored("org_b", 25); // before the last day
    await stored("org_c", 30, 4); // nothing in the last day

    const report = await buildDailyReport(jobEnv(db));
    expect(report.last_24h.messages_stored).toBe(6);
    expect(report.last_24h.active_orgs).toBe(2);
  });

  it("weekly digest: one per org that stored in the last 7 days, with what it stored then", async () => {
    await org("org_week");
    await org("org_edge");
    await org("org_old");
    await org("org_gone", { deleted: true });
    await org("org_out", { optedOut: true });
    await org("org_nomail", { email: null });
    await stored("org_week", 2, 3);
    await stored("org_week", 24 * 6);
    await stored("org_week", 24 * 9, 5); // before the week: not counted
    await stored("org_edge", 24 * 7 - 1);
    await stored("org_old", 24 * 8, 2);
    await stored("org_gone", 1);
    await stored("org_out", 1);
    await stored("org_nomail", 1);

    expect(await sendWeeklyDigests(jobEnv(db))).toBe(2);
    expect(posted.sort((a, b) => a.to.localeCompare(b.to))).toEqual([
      { to: "org_edge@example.test", saved: 1 },
      { to: "org_week@example.test", saved: 4 },
    ]);
  });
});
