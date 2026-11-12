import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertConversation } from "@getengram/db";
import { registerAppendMessages } from "../mcp/tools/append-messages.js";
import { registerGetConversation } from "../mcp/tools/get-conversation.js";
import { guardToolErrors } from "../mcp/tool-guard.js";
import { appendMessages } from "../services/conversation.js";
import { recordImportCursorStatement } from "../services/import-cursor.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env, AuthContext } from "../types.js";
import type { Scope } from "../mcp/scopes.js";

/**
 * engram#751, against real SQLite (Miniflare D1) and R2.
 *
 * `engram import` marks the last message of each batch it sends with how far
 * the import has got. The server takes the marker off the message and
 * records it on the conversation in the batch that stores the messages, so a
 * re-run of the import can send only what's missing. These tests hold it to
 * that: recorded exactly when the messages are, never kept on a message,
 * never able to cost the messages it came with, and a batch stored only
 * where the import is, so no import stores a message twice.
 */

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
type Input = { role: "user" | "assistant"; content: string; metadata?: Record<string, unknown> };

const ALL_SCOPES: Scope[] = ["read", "write", "search", "delete"];
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const cursor = (next: number, digest = DIGEST_A) => ({ v: 1 as const, next, digest });

describe("an import's progress marker (engram#751), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let content: R2Bucket;
  let chunks: R2Bucket;
  let seq = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "import-cursor" },
      r2Buckets: { CHUNKS: "chunks", CONTENT: "content" },
    });
    db = await mf.getD1Database("DB");
    chunks = (await mf.getR2Bucket("CHUNKS")) as unknown as R2Bucket;
    content = (await mf.getR2Bucket("CONTENT")) as unknown as R2Bucket;
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  // ── Fixtures ────────────────────────────────────────────────────────────

  function makeEnv(): Env {
    return {
      DB: db,
      CHUNKS: chunks,
      CONTENT: content,
      AI: {
        async run(_model: string, input: { text: string[] }) {
          return { data: input.text.map(() => Array(768).fill(0.01)) };
        },
      },
      VECTORIZE: {
        async upsert() {
          return { mutationId: "m" };
        },
        async deleteByIds() {
          return { mutationId: "m" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async getByIds() {
          return [];
        },
      },
    } as unknown as Env;
  }

  async function newOrg(): Promise<string> {
    const id = `org_ic${++seq}`;
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
    return id;
  }

  async function newConversation(org: string, metadata: Record<string, unknown> = {}): Promise<string> {
    const id = `conv_ic${++seq}`;
    await insertConversation(db, id, org, `title ${id}`, null, [], metadata);
    return id;
  }

  function authFor(org: string): AuthContext {
    return { organizationId: org, apiKeyId: "key_test", scopes: ALL_SCOPES, tier: "pro", seatId: null };
  }

  /** The MCP tools behind the real tool guard, as createMcpServer installs them. */
  function tools(env: Env, auth: AuthContext) {
    const handlers = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
      tool: (name: string, ...rest: unknown[]) => {
        handlers.set(name, rest[rest.length - 1] as ToolHandler);
      },
    } as unknown as McpServer;
    guardToolErrors(server, { error: vi.fn(), warn: vi.fn() });
    registerAppendMessages(server, env, auth);
    registerGetConversation(server, env, auth);
    return (name: string, args: Record<string, unknown>) => handlers.get(name)!(args);
  }

  /** `n` messages, the last one carrying `marker` as its import_cursor. */
  function batch(n: number, marker?: unknown, from = 0): Input[] {
    return Array.from({ length: n }, (_, i) => {
      const m: Input = {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `harbour note ${from + i + 1}`,
      };
      if (i === n - 1 && marker !== undefined) m.metadata = { import_cursor: marker };
      return m;
    });
  }

  async function conversationRow(conv: string) {
    return db
      .prepare("SELECT metadata, message_count FROM conversations WHERE id = ?")
      .bind(conv)
      .first<{ metadata: string; message_count: number }>();
  }

  async function recorded(conv: string): Promise<unknown> {
    const row = await conversationRow(conv);
    return (JSON.parse(row!.metadata) as Record<string, unknown>).import_cursor;
  }

  async function messageMetadata(conv: string): Promise<Array<Record<string, unknown>>> {
    const { results } = await db
      .prepare("SELECT metadata FROM messages WHERE conversation_id = ? ORDER BY sequence")
      .bind(conv)
      .all<{ metadata: string }>();
    return results.map((r) => JSON.parse(r.metadata) as Record<string, unknown>);
  }

  // ── Recorded with the messages, never kept on one ───────────────────────

  it("records the last message's marker on the conversation, and stores no message with it", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const messages = batch(3, cursor(3));
    messages[2].metadata = { ...messages[2].metadata, model: "m-1" };

    const stored = await appendMessages(makeEnv(), org, conv, messages);

    expect(await recorded(conv)).toEqual(cursor(3));
    expect(await messageMetadata(conv)).toEqual([{}, {}, { model: "m-1" }]);
    // Nor does the append's answer carry it.
    expect(stored.map((m) => m.metadata)).toEqual([{}, {}, { model: "m-1" }]);
    expect((await conversationRow(conv))!.message_count).toBe(3);
  });

  it("keeps everything else in the conversation's metadata, numbers exactly as written", async () => {
    const org = await newOrg();
    const conv = await newConversation(org, {
      source: "chatgpt",
      original_create_time: 1700000000.123456,
      nested: { keep: ["a", 1, null, true] },
      text: "café \u{1F600} \"quoted\"",
    });

    await appendMessages(makeEnv(), org, conv, batch(2, cursor(2)));

    expect(JSON.parse((await conversationRow(conv))!.metadata)).toEqual({
      source: "chatgpt",
      original_create_time: 1700000000.123456,
      nested: { keep: ["a", 1, null, true] },
      text: "café \u{1F600} \"quoted\"",
      import_cursor: cursor(2),
    });
  });

  async function contentObjects(): Promise<number> {
    return (await content.list()).objects.length;
  }

  it("stores a batch only where the import is: one sent again, from behind, or skipping ahead is refused whole", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();

    await appendMessages(env, org, conv, batch(5, cursor(5)));
    const objects = await contentObjects();

    for (const stale of [
      batch(5, cursor(5)), // the same batch again
      batch(3, cursor(3, DIGEST_B)), // one from further back
      batch(1, cursor(5, DIGEST_B), 4), // ends at the cursor, starts behind it
      batch(2, cursor(8), 6), // would skip a message
    ]) {
      await expect(appendMessages(env, org, conv, stale)).rejects.toMatchObject({ status: 409 });
    }
    expect(await recorded(conv)).toEqual(cursor(5));
    expect((await conversationRow(conv))!.message_count).toBe(5);
    expect(await messageMetadata(conv)).toHaveLength(5);
    // Refused before anything was stored: not even a message body.
    expect(await contentObjects()).toBe(objects);

    // From where it is, it goes on.
    await appendMessages(env, org, conv, batch(3, cursor(8, DIGEST_B), 5));
    expect(await recorded(conv)).toEqual(cursor(8, DIGEST_B));
    expect((await conversationRow(conv))!.message_count).toBe(8);
  });

  it("before a cursor is recorded, a batch starts at the conversation's message count", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();
    // Messages an import sent before there were cursors.
    await appendMessages(env, org, conv, batch(2));

    await expect(appendMessages(env, org, conv, batch(2, cursor(2)))).rejects.toMatchObject({ status: 409 });
    await expect(appendMessages(env, org, conv, batch(2, cursor(3), 1))).rejects.toMatchObject({ status: 409 });
    await expect(appendMessages(env, org, conv, batch(2, cursor(5), 3))).rejects.toMatchObject({ status: 409 });
    expect((await conversationRow(conv))!.message_count).toBe(2);

    await appendMessages(env, org, conv, batch(2, cursor(4), 2));
    expect(await recorded(conv)).toEqual(cursor(4));
    expect((await conversationRow(conv))!.message_count).toBe(4);
  });

  it("once one is, the cursor and not the count says where the import is: deleting a message doesn't move it", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();
    await appendMessages(env, org, conv, batch(4, cursor(4)));

    // The person deletes one of the imported messages.
    await db.batch([
      db.prepare("DELETE FROM messages WHERE conversation_id = ? AND sequence = 2").bind(conv),
      db
        .prepare("UPDATE conversations SET message_count = message_count - 1, updated_at = datetime('now') WHERE id = ?")
        .bind(conv),
    ]);

    // A re-run that trusted the count would send the fourth message again.
    await expect(appendMessages(env, org, conv, batch(2, cursor(5), 3))).rejects.toMatchObject({ status: 409 });
    await appendMessages(env, org, conv, batch(2, cursor(6), 4));
    expect(await recorded(conv)).toEqual(cursor(6));
    expect((await conversationRow(conv))!.message_count).toBe(5);
  });

  it.each([
    ["another import's batch", () => batch(2, cursor(2))],
    ["a message from anywhere else", () => batch(1)],
  ])("undoes a batch when %s got in after the check: messages, count and cursor", async (_name, racing) => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();
    let raced = false;
    // The other write lands while this append is storing its bodies, after
    // it checked where the import is and before its batch.
    const racingEnv = {
      ...env,
      CONTENT: {
        put: async (...args: Parameters<R2Bucket["put"]>) => {
          if (!raced) {
            raced = true;
            await appendMessages(env, org, conv, racing());
          }
          return content.put(...args);
        },
      },
    } as unknown as Env;

    await expect(appendMessages(racingEnv, org, conv, batch(2, cursor(2)))).rejects.toMatchObject({ status: 409 });
    expect(raced).toBe(true);

    const first = racing();
    expect((await conversationRow(conv))!.message_count).toBe(first.length);
    expect(await messageMetadata(conv)).toHaveLength(first.length);
    expect(await recorded(conv)).toEqual(first.length === 2 ? cursor(2) : undefined);
  });

  it("drops a marker on any message but the last, and one that isn't the CLI's shape", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();

    const early = batch(2);
    early[0].metadata = { import_cursor: cursor(2), keep: 1 };
    await appendMessages(env, org, conv, early);

    await appendMessages(env, org, conv, batch(1, { v: 2, next: 3, digest: DIGEST_A }));
    await appendMessages(env, org, conv, batch(1, { v: 1, next: 4, digest: "not hex" }));
    await appendMessages(env, org, conv, batch(1, "5"));
    // Fewer messages than the batch it ends: no batch can end there.
    await appendMessages(env, org, conv, batch(2, cursor(1)));

    expect(await recorded(conv)).toBeUndefined();
    expect(await messageMetadata(conv)).toEqual([{ keep: 1 }, {}, {}, {}, {}, {}, {}]);
    expect((await conversationRow(conv))!.message_count).toBe(7);
  });

  it("replaces an import_cursor in the conversation's metadata that the CLI didn't write", async () => {
    const env = makeEnv();
    for (const odd of ["5", { next: 9.5 }, { next: "9" }, { other: true }, null, [9]]) {
      const org = await newOrg();
      const conv = await newConversation(org, { import_cursor: odd });
      await appendMessages(env, org, conv, batch(1, cursor(1)));
      expect(await recorded(conv)).toEqual(cursor(1));
    }
  });

  it("records a marker only on a conversation of the account whose append it is", async () => {
    const owner = await newOrg();
    const other = await newOrg();
    const conv = await newConversation(owner);
    await appendMessages(makeEnv(), owner, conv, batch(2));
    // Run alone, as though the batch storing those two messages had just
    // counted them: for any account but the conversation's, it matches nothing.
    const statement = (org: string) => recordImportCursorStatement(db, conv, org, cursor(2), 0);
    expect((await statement(other).run()).meta.changes).toBe(0);
    expect(await recorded(conv)).toBeUndefined();
    expect((await statement(owner).run()).meta.changes).toBe(1);
    expect(await recorded(conv)).toEqual(cursor(2));
  });

  // ── Never costs the messages it came with ───────────────────────────────

  it("stores the messages and leaves the metadata alone where the conversation's metadata isn't a JSON object", async () => {
    const env = makeEnv();
    for (const odd of ["[1,2]", '"text"', "7", "null", "{not json", ""]) {
      const org = await newOrg();
      const conv = await newConversation(org);
      await db.prepare("UPDATE conversations SET metadata = ? WHERE id = ?").bind(odd, conv).run();

      await appendMessages(env, org, conv, batch(2, cursor(2)));

      const row = await conversationRow(conv);
      expect(row!.metadata).toBe(odd);
      expect(row!.message_count).toBe(2);
      expect(await messageMetadata(conv)).toEqual([{}, {}]);
    }
  });

  it("is recorded in the same batch as the messages: if it can't be, no message is stored", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const env = makeEnv();
    await appendMessages(env, org, conv, batch(2, cursor(2)));

    // A failure at the very statement that records the marker.
    await db
      .prepare(
        `CREATE TRIGGER fail_import_cursor BEFORE UPDATE OF metadata ON conversations
         WHEN json_extract(NEW.metadata, '$.import_cursor.next') = 4
         BEGIN SELECT RAISE(ABORT, 'refused for the test'); END`,
      )
      .run();
    try {
      await expect(appendMessages(env, org, conv, batch(2, cursor(4), 2))).rejects.toThrow();
    } finally {
      await db.prepare("DROP TRIGGER fail_import_cursor").run();
    }

    const row = await conversationRow(conv);
    expect(row!.message_count).toBe(2);
    expect(await messageMetadata(conv)).toEqual([{}, {}]);
    expect(await recorded(conv)).toEqual(cursor(2));
  });

  // ── Through the tools the CLI uses ──────────────────────────────────────

  it("an API key's append_messages records it, and get_conversation reads it back", async () => {
    const org = await newOrg();
    const conv = await newConversation(org, { source: "claude" });
    const call = tools(makeEnv(), authFor(org));

    const res = await call("append_messages", { conversation_id: conv, messages: batch(3, cursor(3)) });
    expect(res.isError ?? false).toBe(false);

    // Called directly, the handler gets no schema defaults: pass them.
    const read = await call("get_conversation", { conversation_id: conv, message_limit: 1, message_offset: 0 });
    const body = JSON.parse(read.content[0].text) as {
      conversation: { metadata: Record<string, unknown>; message_count: number };
      messages: Array<{ metadata: Record<string, unknown> }>;
    };
    expect(body.conversation.metadata).toEqual({ source: "claude", import_cursor: cursor(3) });
    expect(body.conversation.message_count).toBe(3);
    expect(body.messages[0].metadata).toEqual({});
  });

  it("an API key's append_messages answers import_moved for a batch that's already stored, and stores nothing", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const call = tools(makeEnv(), authFor(org));
    const sent = batch(3, cursor(3));

    expect((await call("append_messages", { conversation_id: conv, messages: sent })).isError ?? false).toBe(false);
    const again = await call("append_messages", { conversation_id: conv, messages: sent });

    expect(again.isError).toBe(true);
    expect(JSON.parse(again.content[0].text)).toMatchObject({ error: "import_moved" });
    expect((await conversationRow(conv))!.message_count).toBe(3);
  });
});
