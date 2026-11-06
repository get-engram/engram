import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Miniflare } from "miniflare";
import {
  deleteConversationById,
  getR2MessageIdsByConversation,
  getR2PointerPage,
  getR2RevisionIdsByConversation,
} from "@getengram/db";
import { moveConversation } from "../routes/merge-orgs.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#559: a statement scoped to one conversation must seek an index that
 * starts with the conversation, never the organization.
 *
 * Given `conversation_id = ? AND organization_id = ?` and no planner
 * statistics, SQLite costs an equality on the first column of either index
 * the same and picks the single-column org index — so deleting one
 * conversation walked every message, revision and tag the organization
 * owns. EXPLAIN QUERY PLAN against production, 2026-11-06; several seconds
 * per delete on the largest accounts, during which D1 (one statement at a
 * time) answered nothing else. Same failure as #477.
 *
 * The fix is INDEXED BY. These tests run EXPLAIN QUERY PLAN over the exact
 * SQL each helper issues — captured, not copied — against the real
 * migrations, so a dropped hint, a renamed index or a new conversation-scoped
 * statement that seeks the org index fails here rather than on the largest
 * account.
 */

/** Tables whose org index must never serve a conversation-scoped statement. */
const SCOPED_TABLES = ["messages", "message_revisions", "conversation_tags", "conversation_chunks"];

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

/** Plan steps that read one of the scoped tables by the org alone, or all of it. */
function orgWalks(plan: string[]): string[] {
  return plan.filter((line) =>
    SCOPED_TABLES.some(
      (t) =>
        new RegExp(`^SCAN ${t}\\b`).test(line) ||
        new RegExp(`^SEARCH ${t} USING (COVERING )?INDEX \\w+ \\(organization_id=\\?\\)$`).test(line),
    ),
  );
}

const conversationScoped = (sql: string) =>
  /\bconversation_id = \?/.test(sql) &&
  SCOPED_TABLES.some((t) => new RegExp(`\\b(FROM|UPDATE) ${t}\\b`).test(sql));

describe("conversation-scoped statements seek the conversation (engram#559)", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "conversation-scope-plans" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  async function expectConversationSeeks(sql: string[], expected: Record<string, RegExp>) {
    const scoped = sql.filter(conversationScoped);
    expect(scoped.length).toBeGreaterThan(0);
    for (const s of scoped) {
      const plan = await planOf(db, s);
      expect({ sql: s, walks: orgWalks(plan) }).toEqual({ sql: s, walks: [] });
    }
    for (const [needle, index] of Object.entries(expected)) {
      const s = scoped.find((q) => q.includes(needle));
      expect(s, `no statement containing ${needle}`).toBeDefined();
      expect((await planOf(db, s!)).join(" | ")).toMatch(index);
    }
  }

  it("conversation delete: the R2 id reads and every DELETE in the batch", async () => {
    const rec = recording(db);
    await getR2MessageIdsByConversation(rec.db, "conv_x", "org_x");
    await getR2RevisionIdsByConversation(rec.db, "conv_x", "org_x");
    await deleteConversationById(rec.db, "conv_x", "org_x");
    await expectConversationSeeks(rec.sql, {
      "SELECT id FROM messages": /SEARCH messages USING (COVERING )?INDEX idx_messages_conv_seq \(conversation_id=\?\)/,
      "SELECT id FROM message_revisions": /SEARCH message_revisions USING (COVERING )?INDEX idx_message_revisions_conv \(conversation_id=\?\)/,
      "DELETE FROM messages": /SEARCH messages USING (COVERING )?INDEX idx_messages_conv_seq \(conversation_id=\?\)/,
      "DELETE FROM conversation_tags": /SEARCH conversation_tags USING (COVERING )?INDEX sqlite_autoindex_conversation_tags_1 \(conversation_id=\?\)/,
      "DELETE FROM conversation_chunks": /SEARCH conversation_chunks USING (COVERING )?INDEX idx_chunks_org_conv \(organization_id=\? AND conversation_id=\?\)/,
    });
  });

  it("content-integrity page limited to one conversation", async () => {
    const rec = recording(db);
    await getR2PointerPage(rec.db, "org_x", null, 10, "conv_x");
    await getR2PointerPage(rec.db, "org_x", "msg_x", 10, "conv_x");
    await expectConversationSeeks(rec.sql, {
      "FROM messages": /SEARCH messages USING (COVERING )?INDEX idx_messages_conv_seq \(conversation_id=\?\)/,
    });
  });

  it("merge: moving a conversation's rows to another organization", async () => {
    const rec = recording(db);
    const env = { DB: rec.db } as unknown as Env;
    // No chunk rows, so the move skips R2, FTS and Vectorize and issues only
    // the chunk read and the row updates.
    await moveConversation(env, "conv_x", "org_from", "org_to");
    await expectConversationSeeks(rec.sql, {
      "UPDATE messages": /SEARCH messages USING (COVERING )?INDEX idx_messages_conv_seq \(conversation_id=\?\)/,
    });
  });
});
