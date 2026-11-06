import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  ACTIVATION_MILESTONES,
  stampActivationMilestones,
  type MilestoneStamps,
} from "../services/activation-milestones.js";
import { enforceAuditRetention, AUDIT_RETENTION_DAYS } from "../cron/audit-retention.js";
import { loadSlowMetrics, resetAdminMetricsCacheForTests } from "../services/admin-metrics.js";
import { sendRecallNudges } from "../cron/recall-nudge.js";
import { applyMigration } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#555, against real SQLite. audit_log keeps 90 days, and the admin
 * activation funnel and the recall nudge ask "ever" questions of it. These
 * prove the milestones are stamped onto organizations before retention
 * deletes the rows that proved them, that the funnel reads the same numbers
 * afterwards, that the recall nudge doesn't email someone whose recall merely
 * aged out, and that stamping stays a few rows per org however long an org's
 * history is. The mock D1 can't run correlated UPDATEs, so this is the only
 * place those statements execute before production.
 */

// 0001's organizations table, verbatim, then the later columns these
// queries read, as production has them.
const ORGANIZATIONS_0001 = `CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;
const LATER_ORG_COLUMNS = [
  "email TEXT",
  "deleted_at TEXT",
  "referral_source TEXT",
  "messages_stored_total INTEGER NOT NULL DEFAULT 0",
  "digest_opt_out INTEGER NOT NULL DEFAULT 0",
  "recall_nudged_at TEXT",
];

const NONE: MilestoneStamps = {
  first_activity: 0,
  first_search: 0,
  first_recall: 0,
  second_session: 0,
  returned_7d: 0,
};

describe("activation milestones vs audit_log retention, against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let seq = 0;
  const env = () => ({ DB: db }) as unknown as Env;

  // Timestamps are `days` back at a fixed minute of that day, so a row's
  // date never depends on when the suite runs.
  const AT = "datetime('now', 'start of day', ?, ?)";
  const ago = (days: number, minute: number) => [`-${days} days`, `+${minute} minutes`];

  async function org(
    id: string,
    days: number,
    o: { email?: string; stored?: number; referral?: string; deleted?: boolean } = {},
  ): Promise<void> {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, email, messages_stored_total, referral_source, deleted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ${AT})`,
      )
      .bind(id, id, o.email ?? null, o.stored ?? 0, o.referral ?? null, o.deleted ? "2026-01-01 00:00:00" : null, ...ago(days, 540))
      .run();
  }

  /** One audit row; callers insert each org's rows in time order, as production does. */
  async function audit(orgId: string, action: string, days: number, minute: number, results?: number): Promise<string> {
    const id = `al_${++seq}`;
    await db
      .prepare(`INSERT INTO audit_log (id, organization_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ${AT})`)
      .bind(id, orgId, action, JSON.stringify(results === undefined ? {} : { results }), ...ago(days, minute))
      .run();
    return id;
  }

  async function createdAt(auditId: string): Promise<string> {
    const r = await db.prepare("SELECT created_at FROM audit_log WHERE id = ?").bind(auditId).first<{ created_at: string }>();
    if (!r) throw new Error(`no audit row ${auditId}`);
    return r.created_at;
  }

  async function stampsOf(orgId: string) {
    return db
      .prepare(
        `SELECT first_activity_at, first_search_at, first_recall_at, second_session_at, returned_7d_at
           FROM organizations WHERE id = ?`,
      )
      .bind(orgId)
      .first<Record<string, string | null>>();
  }

  async function funnel() {
    resetAdminMetricsCacheForTests();
    return (await loadSlowMetrics(db)).activation;
  }

  /**
   * Most of this history is past the 90-day floor, chosen so each milestone
   * would be lost for at least one org if only audit_log remembered it.
   */
  async function seedFleet() {
    const ids: Record<string, string> = {};
    // Signed up 120 days ago and did everything; only a fruitless search 5 days ago is recent.
    await org("org_full", 120, { email: "full@example.test", stored: 40 });
    ids.fullCreate = await audit("org_full", "create_conversation", 120, 600);
    ids.fullSearch = await audit("org_full", "search", 120, 605, 0);
    ids.fullRecall = await audit("org_full", "search", 119, 540, 2);
    ids.fullReturn = await audit("org_full", "list_conversations", 110, 600);
    await audit("org_full", "search", 5, 600, 0);
    // One day of searching that never found anything, 100 days ago.
    await org("org_searcher", 100, { email: "searcher@example.test", stored: 3 });
    ids.searcherSearch = await audit("org_searcher", "search", 100, 600, 0);
    await audit("org_searcher", "search", 100, 660, 0);
    // Saved, came back 9 days later and recalled, then nothing for four months.
    await org("org_lapsed", 130, { email: "lapsed@example.test", stored: 10 });
    ids.lapsedStore = await audit("org_lapsed", "append_messages", 130, 600);
    ids.lapsedRecall = await audit("org_lapsed", "search", 121, 600, 1);
    // Signed up, never used it.
    await org("org_idle", 95);
    // Two days old and already recalled, so nothing has been stamped for it yet.
    await org("org_new", 2, { stored: 2 });
    ids.newSearch = await audit("org_new", "search", 2, 600, 3);
    ids.newNext = await audit("org_new", "append_messages", 1, 600);
    // Outside the funnel either way.
    await org("org_internal", 120, { referral: "internal" });
    await audit("org_internal", "search", 120, 600, 1);
    await org("org_deleted", 120, { deleted: true });
    await audit("org_deleted", "search", 120, 600, 1);
    return ids;
  }

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "activation-milestones-test" },
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    await db.prepare(ORGANIZATIONS_0001).run();
    for (const col of LATER_ORG_COLUMNS) await db.prepare(`ALTER TABLE organizations ADD COLUMN ${col}`).run();
    await applyMigration(db, "0008_audit_log.sql");
    await db.prepare("CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)").run(); // 0039's
    await db.prepare("CREATE TABLE conversation_chunks (id TEXT PRIMARY KEY)").run(); // the funnel's batch counts it
    await applyMigration(db, "_activation_milestones.sql");
  }, 60_000);

  afterAll(async () => {
    await mf.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await db.prepare("DELETE FROM audit_log").run();
    await db.prepare("DELETE FROM organizations").run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stamps each milestone with the created_at of the row that first proved it", async () => {
    const ids = await seedFleet();

    expect(await stampActivationMilestones(db)).toEqual({
      first_activity: 6,
      first_search: 6,
      first_recall: 5,
      second_session: 3,
      returned_7d: 2,
    });

    expect(await stampsOf("org_full")).toEqual({
      first_activity_at: await createdAt(ids.fullCreate),
      first_search_at: await createdAt(ids.fullSearch), // a search that found nothing is still a search
      first_recall_at: await createdAt(ids.fullRecall),
      second_session_at: await createdAt(ids.fullRecall), // first row on a later date
      returned_7d_at: await createdAt(ids.fullReturn),
    });
    expect(await stampsOf("org_searcher")).toEqual({
      first_activity_at: await createdAt(ids.searcherSearch),
      first_search_at: await createdAt(ids.searcherSearch),
      first_recall_at: null,
      second_session_at: null, // two searches, one day
      returned_7d_at: null,
    });
    expect(await stampsOf("org_lapsed")).toEqual({
      first_activity_at: await createdAt(ids.lapsedStore),
      first_search_at: await createdAt(ids.lapsedRecall),
      first_recall_at: await createdAt(ids.lapsedRecall),
      second_session_at: await createdAt(ids.lapsedRecall),
      returned_7d_at: await createdAt(ids.lapsedRecall),
    });
    expect(await stampsOf("org_new")).toEqual({
      first_activity_at: await createdAt(ids.newSearch),
      first_search_at: await createdAt(ids.newSearch),
      first_recall_at: await createdAt(ids.newSearch),
      second_session_at: await createdAt(ids.newNext),
      returned_7d_at: null, // not a week old yet
    });
    expect(await stampsOf("org_idle")).toEqual({
      first_activity_at: null,
      first_search_at: null,
      first_recall_at: null,
      second_session_at: null,
      returned_7d_at: null,
    });
  });

  it("is a no-op on a re-run and never moves a stamp, even once the evidence is gone", async () => {
    await seedFleet();
    await stampActivationMilestones(db);
    const before = await stampsOf("org_full");

    expect(await stampActivationMilestones(db)).toEqual(NONE);

    await db.prepare("DELETE FROM audit_log WHERE organization_id = 'org_full'").run();
    await audit("org_full", "search", 0, 1, 5);
    expect(await stampActivationMilestones(db)).toEqual(NONE);
    expect(await stampsOf("org_full")).toEqual(before);
  });

  it("lets retention delete past the floor while the funnel keeps its numbers", async () => {
    await seedFleet();
    const before = await funnel();
    expect(before).toEqual({
      connected: 5,
      first_memory_saved: 4,
      first_search: 4,
      first_successful_recall: 3,
      second_session: 3,
      returned_after_7_days: 2,
    });

    expect(await enforceAuditRetention(env())).toBe(10);
    const old = await db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE created_at < datetime('now', ?)")
      .bind(`-${AUDIT_RETENTION_DAYS} days`)
      .first<{ n: number }>();
    expect(old?.n).toBe(0);
    expect(await funnel()).toEqual(before);

    // The stamps are what carried it: the same surviving rows, unstamped,
    // forget two searchers, two recalls, two second sessions and a return.
    await db
      .prepare(
        `UPDATE organizations SET first_activity_at = NULL, first_search_at = NULL,
           first_recall_at = NULL, second_session_at = NULL, returned_7d_at = NULL`,
      )
      .run();
    expect(await funnel()).toEqual({
      ...before,
      first_search: 2,
      first_successful_recall: 1,
      second_session: 1,
      returned_after_7_days: 1,
    });
  });

  it("does not send the recall nudge to someone whose recall aged out of audit_log", async () => {
    await seedFleet();
    await enforceAuditRetention(env());

    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push((JSON.parse(String(init.body)) as { to: string }).to);
        return new Response("{}", { status: 200 });
      }),
    );
    const nudgeEnv = {
      DB: db,
      APP_URL: "https://app.example.test",
      ADMIN_SECRET: "test-only-not-a-secret",
    } as unknown as Env;

    // org_full and org_lapsed recalled months ago; only org_searcher never has.
    expect(await sendRecallNudges(nudgeEnv)).toBe(1);
    expect(sent).toEqual(["searcher@example.test"]);

    // Without the stamp, both would be told to try recall for the first time.
    await db.prepare("UPDATE organizations SET first_recall_at = NULL").run();
    sent.length = 0;
    await sendRecallNudges(nudgeEnv);
    expect(sent.sort()).toEqual(["full@example.test", "lapsed@example.test"]);
  });

  it("reads a few rows per org however much history the org has", async () => {
    await org("org_heavy", 30, { stored: 5000 });
    // 3,000 searches over 30 days, then 1,000 saves: the shape that makes a
    // per-org MIN over search rows, or a sort, cost thousands of reads.
    await db
      .prepare(
        `INSERT INTO audit_log (id, organization_id, action, metadata, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000)
         SELECT 'h' || i, 'org_heavy', 'search', '{"results":1}',
                datetime('now', 'start of day', '-30 days', '+' || (i * 14) || ' minutes')
           FROM n`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO audit_log (id, organization_id, action, metadata, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000)
         SELECT 's' || i, 'org_heavy', 'append_messages', '{}',
                datetime('now', 'start of day', '-1 days', '+' || i || ' minutes')
           FROM n`,
      )
      .run();
    await org("org_light", 3);
    await audit("org_light", "search", 3, 600, 0);

    const reads: number[] = [];
    const metered = {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          run: async () => {
            const r = await stmt.run();
            reads.push(r.meta.rows_read);
            return r;
          },
        };
      },
    } as unknown as D1Database;

    const stamped = await stampActivationMilestones(metered);
    expect(stamped.first_search).toBe(2);
    expect(stamped.first_recall).toBe(1);
    expect(reads).toHaveLength(ACTIVATION_MILESTONES.length);
    for (const n of reads) expect(n).toBeLessThan(25);
  });
});
