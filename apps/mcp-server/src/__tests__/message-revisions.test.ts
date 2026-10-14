import { describe, it, expect, vi } from "vitest";
import { updateMessage } from "../services/conversation.js";
import type { Env } from "../types.js";

/**
 * Editing a message used to overwrite it in place — same row, same R2 key —
 * destroying the previous wording in both stores with no way back. That
 * contradicted the product's central claim: that Engram keeps what was
 * actually said, so it can be told apart from a later interpretation of it.
 *
 * These pin that an edit ARCHIVES the old body before replacing it, and that
 * the archive is written under its own key so the overwrite cannot clobber it.
 */

const MSG = {
  id: "msg_1",
  conversation_id: "conv_1",
  organization_id: "org_1",
  role: "user",
  content: "the ORIGINAL wording",
  content_encoding: null,
  tool_call_id: null,
  tool_name: null,
  sequence: 1,
  metadata: "{}",
  created_at: "2026-10-01 00:00:00",
};

function stubEnv(opts: { maxRev?: number | null } = {}) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const r2 = new Map<string, string>();
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        first: async () => {
          if (/FROM conversations WHERE id/i.test(sql)) return { id: "conv_1", visibility: null, seat_id: null };
          if (/MAX\(revision\)/i.test(sql)) return { max_rev: opts.maxRev ?? null };
          if (/FROM messages WHERE id/i.test(sql)) return MSG;
          return null;
        },
        run: async () => {
          writes.push({ sql, args });
          return { success: true, meta: { changes: 1 } };
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;

  const env = {
    DB: db,
    CONTENT: {
      put: async (k: string, v: string) => void r2.set(k, v),
      get: async (k: string) =>
        r2.has(k) ? { text: async () => r2.get(k)! } : null,
      delete: async () => {},
    },
    AI: {},
    VECTORIZE: {},
  } as unknown as Env;
  return { env, writes, r2 };
}

const revisionInsert = (w: Array<{ sql: string; args: unknown[] }>) =>
  w.find((x) => /INSERT INTO message_revisions/i.test(x.sql));

describe("editing a message preserves the previous body", () => {
  it("archives the old wording before the overwrite", async () => {
    const { env, writes, r2 } = stubEnv();
    const out = await updateMessage(env, "org_1", "conv_1", "msg_1", "the NEW wording");

    expect(out?.content).toBe("the NEW wording");

    const ins = revisionInsert(writes);
    expect(ins, "an edit must write a message_revisions row").toBeTruthy();
    // args: id, message_id, conversation_id, organization_id, revision, content, encoding
    const [revId, msgId, convId, orgId, revNo] = ins!.args as string[];
    expect(revId).toMatch(/^rev_/);
    expect(msgId).toBe("msg_1");
    expect(convId).toBe("conv_1");
    expect(orgId).toBe("org_1");
    expect(revNo).toBe(1);

    // The archived body is the ORIGINAL text, under its OWN key — if it
    // shared the message's key the overwrite would destroy it again.
    const archived = r2.get(`content/${revId}`) ?? r2.get(String(revId));
    const stored = [...r2.entries()];
    expect(
      stored.some(([k, v]) => k.includes(String(revId)) && v.includes("ORIGINAL")),
      `archived body not found under its own key; keys=${stored.map(([k]) => k).join(",")}`,
    ).toBe(true);
    expect(archived === undefined || archived.includes("ORIGINAL")).toBe(true);
    // and the message's own key now holds the new text, not the old
    expect(
      stored.some(([k, v]) => k.includes("msg_1") && v.includes("NEW")),
    ).toBe(true);
  });

  it("numbers revisions upward so the chain is ordered", async () => {
    const { env, writes } = stubEnv({ maxRev: 4 });
    await updateMessage(env, "org_1", "conv_1", "msg_1", "fifth wording");
    expect((revisionInsert(writes)!.args as unknown[])[4]).toBe(5);
  });

  it("refuses to edit a message in another org, and archives nothing", async () => {
    const { env, writes } = stubEnv();
    const db = env.DB as unknown as { prepare: (s: string) => unknown };
    const orig = db.prepare.bind(db);
    // conversation lookup is org-scoped: pretend it finds nothing
    (env as unknown as { DB: { prepare: (s: string) => unknown } }).DB = {
      prepare: (sql: string) =>
        /FROM conversations WHERE id/i.test(sql)
          ? { bind: () => ({ first: async () => null, run: async () => ({}), all: async () => ({ results: [] }) }) }
          : orig(sql),
      batch: async () => [],
    } as unknown as D1Database;

    const out = await updateMessage(env, "org_other", "conv_1", "msg_1", "hijack");
    expect(out).toBeNull();
    expect(revisionInsert(writes)).toBeUndefined();
  });
});
