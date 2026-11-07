import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import { getMessagePointerPage, insertConversation } from "@getengram/db";
import { scanContentIntegrity } from "../services/content-integrity.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#561: one call of the content-integrity scan reads one page of the
 * organization's messages, wherever the cursor is and however large the
 * organization.
 *
 * The page used to be keyed on message id. No index scoped to the
 * organization gives id order, so every call read all of the organization's
 * R2 pointers and sorted them to return one page: seconds per call on the
 * largest accounts, while D1 (one statement at a time) answered nothing
 * else. It is now a rowid keyset over idx_messages_org, whose entries run in
 * (organization_id, rowid) order.
 *
 * These run the real query and the real scan against real SQLite with the
 * real migrations: the plan (the org index, no sort, the hint in the SQL),
 * the rows one page reads, and whole scans that must check every pointer in
 * scope exactly once and nothing else.
 */

const ORG = "org_big";
const OTHER = "org_other";
/** Messages seeded, across both organizations. */
const SEEDED = 1800;

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

async function planOf(db: D1Database, sql: string): Promise<string> {
  const params = (sql.match(/\?/g) ?? []).map(() => "x");
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail).join(" | ");
}

describe("content-integrity scan pages (engram#561)", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "integrity-scan-paging" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
    for (const org of [ORG, OTHER]) {
      await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(org, org).run();
    }
    for (const [conv, org] of [["conv_big_0", ORG], ["conv_big_1", ORG], ["conv_other", OTHER]]) {
      await insertConversation(db, conv, org, `title ${conv}`, null, [], {});
    }
    // Two organizations' messages interleaved in rowid order, two thirds of
    // them ORG's. Ids are a permutation that does not follow rowid order, so
    // nothing passes by walking ids. The first 450 rows are inline bodies,
    // stored before R2, as an old account's are; after that every 7th is.
    await db
      .prepare(
        `INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SEEDED})
         SELECT printf('msg_%06d', (i * 7919) % 100003),
                CASE WHEN i % 3 = 0 THEN 'conv_other' ELSE 'conv_big_' || (i % 2) END,
                CASE WHEN i % 3 = 0 THEN '${OTHER}' ELSE '${ORG}' END,
                'user',
                CASE WHEN i <= 450 OR i % 7 = 0 THEN 'inline body' ELSE '' END,
                CASE WHEN i <= 450 OR i % 7 = 0 THEN NULL ELSE 'r2:raw' END,
                i
           FROM n`,
      )
      .run();
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("org-wide: seeks idx_messages_org from the cursor, with no sort", async () => {
    const rec = recording(db);
    await getMessagePointerPage(rec.db, ORG, null, 10);
    await getMessagePointerPage(rec.db, ORG, 5, 10);
    expect(rec.sql).toHaveLength(2);
    // Miniflare's planner may find the index unhinted; production's has no
    // statistics to (engram#559), so the hint is asserted as well.
    for (const sql of rec.sql) expect(sql).toContain("FROM messages INDEXED BY idx_messages_org WHERE");
    expect(await planOf(db, rec.sql[0])).toBe("SEARCH messages USING INDEX idx_messages_org (organization_id=?)");
    expect(await planOf(db, rec.sql[1])).toBe(
      "SEARCH messages USING INDEX idx_messages_org (organization_id=? AND rowid>?)",
    );
  });

  it("one conversation: seeks the conversation index, never the organization's", async () => {
    const rec = recording(db);
    await getMessagePointerPage(rec.db, ORG, 5, 10, "conv_big_1");
    expect(rec.sql[0]).toContain("FROM messages INDEXED BY idx_messages_conv_seq WHERE");
    // The rowid sort is over one conversation's rows, which the seek bounds.
    expect(await planOf(db, rec.sql[0])).toBe(
      "SEARCH messages USING INDEX idx_messages_conv_seq (conversation_id=?) | USE TEMP B-TREE FOR ORDER BY",
    );
  });

  it("a page reads the rows it returns and no more, wherever the cursor is", async () => {
    // From the start (300 inline rows lead), mid-way, and near the end. A
    // page that filtered on encoding in SQL would read past the inline run to
    // fill itself; one keyed on id would read the whole organization.
    for (const after of [null, 600, 1650]) {
      const page = await getMessagePointerPage(db, ORG, after, 50);
      expect(page.results, `after ${after}`).toHaveLength(50);
      expect(page.meta.rows_read, `after ${after}`).toBe(50);
    }
    // The last page reads what is left and stops.
    const tail = await getMessagePointerPage(db, ORG, SEEDED - 30, 50);
    expect(tail.results).toHaveLength(20);
    expect(tail.meta.rows_read).toBeLessThanOrEqual(21);
  });

  /** An R2 that has every object but `lost`, recording each HEAD. */
  function scanEnv(lost: Set<string>) {
    const heads: string[] = [];
    const env = {
      DB: db,
      CONTENT: {
        head: async (key: string) => {
          heads.push(key);
          return lost.has(key) ? null : { key };
        },
      },
    } as unknown as Env;
    return { env, heads };
  }

  async function r2Keys(where: string): Promise<string[]> {
    const { results } = await db
      .prepare(`SELECT id FROM messages WHERE ${where} AND content_encoding LIKE 'r2:%' ORDER BY rowid`)
      .all<{ id: string }>();
    return results.map((r) => `content/${r.id}`);
  }

  it("a whole scan checks each of the organization's pointers once, in rowid order, and nothing else", async () => {
    const pointers = await r2Keys(`organization_id = '${ORG}'`);
    const lost = new Set([pointers[0], pointers[400], pointers[pointers.length - 1]]);
    const { env, heads } = scanEnv(lost);

    const missing: string[] = [];
    let after: number | null = null;
    let calls = 0;
    let arrived = "";
    for (;;) {
      const page = await scanContentIntegrity(env, { organizationId: ORG, batch: 37, after });
      missing.push(...page.missing.map((m) => `content/${m.id}`));
      calls++;
      if (page.done) break;
      expect(page.next_after).toBeGreaterThan(after ?? 0);
      after = page.next_after;
      if (calls === 5) {
        // Saved while the scan runs: above the cursor, so it is reached.
        arrived = `content/msg_arrived`;
        await db
          .prepare(
            `INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence)
             VALUES ('msg_arrived', 'conv_big_0', ?, 'user', '', 'r2:raw', 99999),
                    ('msg_elsewhere', 'conv_other', ?, 'user', '', 'r2:raw', 99999)`,
          )
          .bind(ORG, OTHER)
          .run();
      }
    }

    expect(arrived).not.toBe("");
    const expected = await r2Keys(`organization_id = '${ORG}'`);
    expect(expected).toContain(arrived);
    expect(heads).toEqual(expected);
    expect(missing).toEqual([...lost]);
    // 1,200 rows of the organization's at 37 a call, plus the arrival.
    expect(calls).toBe(Math.ceil(1201 / 37));
  });

  it("a scan of one conversation checks that conversation's pointers and stops", async () => {
    const pointers = await r2Keys("conversation_id = 'conv_big_1'");
    const { env, heads } = scanEnv(new Set([pointers[3]]));
    const missing: string[] = [];
    let after: number | null = null;
    for (;;) {
      const page = await scanContentIntegrity(env, { organizationId: ORG, conversationId: "conv_big_1", batch: 50, after });
      missing.push(...page.missing.map((m) => `content/${m.id}`));
      if (page.done) break;
      expect(page.next_after).toBeGreaterThan(after ?? 0);
      after = page.next_after;
    }
    expect(heads).toEqual(pointers);
    expect(missing).toEqual([pointers[3]]);
  });

  it("a conversation of another organization's yields nothing", async () => {
    const { env, heads } = scanEnv(new Set());
    const page = await scanContentIntegrity(env, { organizationId: ORG, conversationId: "conv_other", batch: 50 });
    expect(page).toMatchObject({ scanned: 0, missing: [], next_after: null, done: true });
    expect(heads).toEqual([]);
  });
});
