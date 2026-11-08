import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIER_LIMITS } from "@getengram/shared";
import { insertConversation, getCurrentPeriod } from "@getengram/db";
import { registerAppendMessages } from "../mcp/tools/append-messages.js";
import { guardToolErrors } from "../mcp/tool-guard.js";
import { v1 } from "../routes/v1.js";
import { memories } from "../routes/memories.js";
import { appendMessages } from "../services/conversation.js";
import {
  estimateIndexingUnits,
  releaseAppendCharges,
  reserveAppend,
} from "../services/tier.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env, AuthContext } from "../types.js";
import type { Scope } from "../mcp/scopes.js";

/**
 * engram#591, against real SQLite (Miniflare D1) and R2.
 *
 * An append is charged against three counters before it is written —
 * lifetime storage, the month's messages, the month's indexing — and an
 * append that stores nothing must give all three back. Before the fix a
 * refused or failed append kept the monthly and indexing charges: a client
 * retrying an append to a deleted conversation drained both budgets without
 * storing a byte. Each test reads the counters before and after through
 * every surface that appends (the MCP tool, REST, the dashboard route).
 *
 * The mock D1 treats `SET x = x - ?` updates as no-ops, so refunds can only
 * be checked here.
 */

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };
type Tier = AuthContext["tier"];
const TIERS: Tier[] = ["free", "pro", "team", "enterprise"];
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

const ALL_SCOPES: Scope[] = ["read", "write", "search", "delete"];
const JSON_HEADERS = { "Content-Type": "application/json" };

function silentLog() {
  return { error: vi.fn(), warn: vi.fn() };
}

describe("an append that stores nothing costs nothing (engram#591), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let content: R2Bucket;
  let chunks: R2Bucket;
  let seq = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "append-charges" },
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

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Fixtures ────────────────────────────────────────────────────────────

  function makeEnv(over: { DB?: D1Database; WRITES_FROZEN?: string } = {}): Env {
    return {
      DB: over.DB ?? db,
      CHUNKS: chunks,
      CONTENT: content,
      WRITES_FROZEN: over.WRITES_FROZEN,
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
    const id = `org_ac${++seq}`;
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
    return id;
  }

  async function newConversation(
    org: string,
    opts: { seatId?: string | null; visibility?: "shared" | "private" } = {},
  ): Promise<string> {
    const id = `conv_ac${++seq}`;
    await insertConversation(db, id, org, `title ${id}`, null, [], {}, opts.seatId ?? null, opts.visibility ?? "shared");
    return id;
  }

  function authFor(org: string, tier: Tier = "free", seatId: string | null = null): AuthContext {
    return { organizationId: org, apiKeyId: "key_test", scopes: ALL_SCOPES, tier, seatId };
  }

  /** The three counters an append charges, for the current period. */
  async function counters(org: string, period = getCurrentPeriod()) {
    const o = await db
      .prepare("SELECT messages_stored_total FROM organizations WHERE id = ?")
      .bind(org)
      .first<{ messages_stored_total: number }>();
    const u = await db
      .prepare("SELECT messages_stored, chunks_indexed FROM usage WHERE organization_id = ? AND period = ?")
      .bind(org, period)
      .first<{ messages_stored: number; chunks_indexed: number }>();
    return {
      storage: o?.messages_stored_total ?? 0,
      messages: u?.messages_stored ?? 0,
      chunks: u?.chunks_indexed ?? 0,
    };
  }

  /** How many usage rows exist for `period`: 0 means nothing was charged to that month. */
  async function usageRows(org: string, period: string): Promise<number> {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM usage WHERE organization_id = ? AND period = ?")
      .bind(org, period)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function storedMessages(conv: string): Promise<number> {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .bind(conv)
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function setUsage(org: string, spent: { messages_stored?: number; chunks_indexed?: number }) {
    await db
      .prepare(
        `INSERT INTO usage (id, organization_id, period, messages_stored, chunks_indexed)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, period) DO UPDATE SET
           messages_stored = excluded.messages_stored, chunks_indexed = excluded.chunks_indexed`,
      )
      .bind(`usg_ac${++seq}`, org, getCurrentPeriod(), spent.messages_stored ?? 0, spent.chunks_indexed ?? 0)
      .run();
  }

  /** The append_messages handler behind the real tool guard, as createMcpServer installs it. */
  function appendTool(env: Env, auth: AuthContext) {
    const tools = new Map<string, ToolHandler>();
    const server = {
      registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
      tool: (name: string, ...rest: unknown[]) => {
        tools.set(name, rest[rest.length - 1] as ToolHandler);
      },
    } as unknown as McpServer;
    const log = silentLog();
    guardToolErrors(server, log);
    registerAppendMessages(server, env, auth);
    const handler = tools.get("append_messages")!;
    return { call: (args: Record<string, unknown>) => handler(args), log };
  }

  function restApp(auth: AuthContext) {
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
    app.route("/api/v1", v1);
    app.route("/api/memories", memories);
    return app;
  }

  function msgs(n: number, word = "lighthouse") {
    return Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${word} note ${i + 1} about the harbour`,
    }));
  }

  // ── A successful append is charged once ─────────────────────────────────

  it("a successful append charges each counter exactly once", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const messages = msgs(3);
    const { call } = appendTool(makeEnv(), authFor(org));

    const res = await call({ conversation_id: conv, messages });
    expect(res.isError ?? false).toBe(false);
    expect(await storedMessages(conv)).toBe(3);
    expect(await counters(org)).toEqual({
      storage: 3,
      messages: 3,
      chunks: estimateIndexingUnits(messages),
    });
  });

  // ── Refused by appendMessages: nothing stored, nothing kept ─────────────

  it("MCP: an append to a conversation that does not exist is refused as conversation_not_found and refunds every charge", async () => {
    const org = await newOrg();
    const { call, log } = appendTool(makeEnv(), authFor(org));

    const res = await call({ conversation_id: "conv_missing", messages: msgs(4) });
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text) as { error: string; message: string };
    expect(body.error).toBe("conversation_not_found");
    expect(body.message.length).toBeGreaterThan(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
    // A deliberate refusal, not a server fault.
    expect(log.error).not.toHaveBeenCalled();
  });

  it("the not-found refusal carries its text in the message as well as the body, so no reader is handed an empty string", async () => {
    const org = await newOrg();
    const err = await appendMessages(makeEnv(), org, "conv_missing", msgs(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HTTPException);
    const http = err as HTTPException;
    expect(http.status).toBe(404);
    expect(http.message).toMatch(/no conversation with that id/i);
    expect(await http.getResponse().json()).toEqual({
      error: "conversation_not_found",
      message: http.message,
    });
  });

  it("MCP: retrying a refused append forever drains nothing", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    await appendTool(makeEnv(), authFor(org)).call({ conversation_id: conv, messages: msgs(2) });
    const before = await counters(org);

    const { call } = appendTool(makeEnv(), authFor(org));
    for (let i = 0; i < 5; i++) {
      const res = await call({ conversation_id: "conv_deleted_meanwhile", messages: msgs(2) });
      expect(res.isError).toBe(true);
    }
    expect(await counters(org)).toEqual(before);
  });

  it("MCP: another tenant's conversation is refused exactly like a missing one", async () => {
    const owner = await newOrg();
    const conv = await newConversation(owner);
    const other = await newOrg();
    const { call } = appendTool(makeEnv(), authFor(other));

    const res = await call({ conversation_id: conv, messages: msgs(1) });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("conversation_not_found");
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(other)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  it("MCP: another seat's private conversation is refused as not-found and refunded; its own seat can write", async () => {
    const org = await newOrg();
    const conv = await newConversation(org, { seatId: "seat_a", visibility: "private" });

    const refused = await appendTool(makeEnv(), authFor(org, "free", "seat_b")).call({
      conversation_id: conv,
      messages: msgs(2),
    });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text).error).toBe("conversation_not_found");
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });

    const ok = await appendTool(makeEnv(), authFor(org, "free", "seat_a")).call({
      conversation_id: conv,
      messages: msgs(2),
    });
    expect(ok.isError ?? false).toBe(false);
    expect(await storedMessages(conv)).toBe(2);
  });

  it("REST: another seat's private conversation is refused with the same 404 and refunded (it was not checked)", async () => {
    const org = await newOrg();
    const conv = await newConversation(org, { seatId: "seat_a", visibility: "private" });

    const res = await restApp(authFor(org, "free", "seat_b")).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ conversation_id: conv, messages: msgs(2) }), headers: JSON_HEADERS },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("conversation_not_found");
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });

    const ok = await restApp(authFor(org, "free", "seat_a")).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ conversation_id: conv, messages: msgs(2) }), headers: JSON_HEADERS },
      makeEnv(),
    );
    expect(ok.status).toBe(200);
    expect(await storedMessages(conv)).toBe(2);
  });

  it("REST: a missing conversation is a 404 that refunds every charge", async () => {
    const org = await newOrg();
    const res = await restApp(authFor(org)).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ conversation_id: "conv_nope", messages: msgs(3) }), headers: JSON_HEADERS },
      makeEnv(),
    );
    expect(res.status).toBe(404);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  it("dashboard: a missing or another seat's private conversation is a 404 that refunds every charge", async () => {
    const org = await newOrg();
    const priv = await newConversation(org, { seatId: "seat_a", visibility: "private" });
    for (const conversation_id of ["conv_nope", priv]) {
      const res = await restApp(authFor(org, "free", "seat_b")).request(
        "/api/memories",
        { method: "POST", body: JSON.stringify({ text: "remember the harbour", conversation_id }), headers: JSON_HEADERS },
        makeEnv(),
      );
      expect(res.status, conversation_id).toBe(404);
    }
    expect(await storedMessages(priv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  it("a maintenance freeze answers writes_paused and refunds every charge, so a retrying client burns nothing", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const { call } = appendTool(makeEnv({ WRITES_FROZEN: "1" }), authFor(org));

    const res = await call({ conversation_id: conv, messages: msgs(3) });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("writes_paused");
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  // ── Refused by a later gate: the earlier gates give back ────────────────

  it("an indexing refusal gives back storage and the month's messages", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const limit = TIER_LIMITS.free.chunks_indexed_per_month;
    await setUsage(org, { chunks_indexed: limit });
    const { call } = appendTool(makeEnv(), authFor(org));

    const res = await call({ conversation_id: conv, messages: msgs(2) });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe("indexing_quota_exceeded");
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: limit });
  });

  const cappedTier = TIERS.find((t) => TIER_LIMITS[t].messages_per_month > 0);

  it.skipIf(!cappedTier)("a monthly-message refusal gives back storage", async () => {
    const tier = cappedTier as Tier;
    const org = await newOrg();
    const conv = await newConversation(org);
    const limit = TIER_LIMITS[tier].messages_per_month;
    await setUsage(org, { messages_stored: limit });

    const res = await restApp(authFor(org, tier)).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ conversation_id: conv, messages: msgs(1) }), headers: JSON_HEADERS },
      makeEnv(),
    );
    expect(res.status).toBe(429);
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: limit, chunks: 0 });
  });

  it("a storage refusal charges nothing and keeps its 402", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const cap = TIER_LIMITS.free.storage_messages;
    await db.prepare("UPDATE organizations SET messages_stored_total = ? WHERE id = ?").bind(cap, org).run();

    const res = await restApp(authFor(org)).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ conversation_id: conv, messages: msgs(1) }), headers: JSON_HEADERS },
      makeEnv(),
    );
    expect(res.status).toBe(402);
    expect(await counters(org)).toEqual({ storage: cap, messages: 0, chunks: 0 });
  });

  // ── A failed write: atomic, then refunded ───────────────────────────────

  it("vault entries commit with their messages: a vault insert that fails stores neither, and refunds", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const vault = (id: string) => [{ id, encrypted_value: "Y2lwaGVy", iv: "aXZpdml2aXZpdml2", secret_type: "api_key" }];

    const first = await appendTool(makeEnv(), authFor(org)).call({
      conversation_id: conv,
      messages: msgs(1),
      vault_entries: vault("vlt_ac_dup"),
    });
    expect(first.isError ?? false).toBe(false);
    const after1 = await counters(org);
    expect(await storedMessages(conv)).toBe(1);

    // The same vault id again: its PRIMARY KEY refuses the insert, so the
    // whole batch — messages included — is rolled back.
    const { call, log } = appendTool(makeEnv(), authFor(org));
    const second = await call({ conversation_id: conv, messages: msgs(2), vault_entries: vault("vlt_ac_dup") });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/internal error/);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(await storedMessages(conv)).toBe(1);
    const conversationCount = await db
      .prepare("SELECT message_count FROM conversations WHERE id = ?")
      .bind(conv)
      .first<{ message_count: number }>();
    expect(conversationCount?.message_count).toBe(1);
    expect(await counters(org)).toEqual(after1);
  });

  it("a D1 failure during the write refunds every charge and reaches the caller as itself", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    // D1 that refuses the append's batch (its message insert), like a lost request.
    const failing = {
      prepare: (sql: string) => db.prepare(sql),
      batch: async (stmts: D1PreparedStatement[]) => {
        throw new Error(`D1 unavailable (test, ${stmts.length} statements)`);
      },
    } as unknown as D1Database;

    const res = await restApp(authFor(org))
      .onError((err, c) => c.json({ error: "internal_error", seen: err.message }, 500))
      .request(
        "/api/v1/messages",
        { method: "POST", body: JSON.stringify({ conversation_id: conv, messages: msgs(2) }), headers: JSON_HEADERS },
        makeEnv({ DB: failing }),
      );
    expect(res.status).toBe(500);
    expect(((await res.json()) as { seen: string }).seen).toMatch(/D1 unavailable/);
    expect(await storedMessages(conv)).toBe(0);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  it("a failure after the commit (indexing) keeps the messages and their charges, and the append succeeds", async () => {
    const org = await newOrg();
    const conv = await newConversation(org);
    const messages = msgs(3);
    // The embedding model is down: indexing fails after the messages committed.
    const env = {
      ...makeEnv(),
      AI: {
        async run() {
          throw new Error("AI unavailable (test)");
        },
      },
    } as unknown as Env;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { call, log } = appendTool(env, authFor(org));
      const res = await call({ conversation_id: conv, messages });
      // Stored, so the caller hears so. An error here would make the client
      // resend messages that already exist, and the refund would undercharge.
      expect(res.isError ?? false).toBe(false);
      expect(JSON.parse(res.content[0].text).appended).toBe(3);
      expect(await storedMessages(conv)).toBe(3);
      expect(await counters(org)).toEqual({
        storage: 3,
        messages: 3,
        chunks: estimateIndexingUnits(messages),
      });
      expect(log.error).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/\[index\] Failed to index/));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a gate that throws mid-reservation gives back the gates before it, then rethrows", async () => {
    const org = await newOrg();
    // D1 that fails the indexing charge, after storage and messages landed.
    const failing = {
      prepare: (sql: string) => {
        if (/SET chunks_indexed = chunks_indexed \+/.test(sql)) throw new Error("D1 overloaded (test)");
        return db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;

    await expect(reserveAppend(failing, org, "free", msgs(2))).rejects.toThrow(/D1 overloaded/);
    expect(await counters(org)).toEqual({ storage: 0, messages: 0, chunks: 0 });
  });

  // ── The refund itself ───────────────────────────────────────────────────

  it("a refund runs once: a second release of the same charges gives back nothing", async () => {
    const org = await newOrg();
    await setUsage(org, { messages_stored: 10, chunks_indexed: 10 });
    await db.prepare("UPDATE organizations SET messages_stored_total = 10 WHERE id = ?").bind(org).run();

    const reserved = await reserveAppend(db, org, "free", msgs(2));
    expect(reserved.allowed).toBe(true);
    if (!reserved.allowed) return;
    const charged = await counters(org);
    expect(charged.storage).toBe(12);

    await releaseAppendCharges(db, org, reserved.charges);
    await releaseAppendCharges(db, org, reserved.charges);
    expect(await counters(org)).toEqual({ storage: 10, messages: 10, chunks: 10 });
    expect(reserved.charges).toMatchObject({ storage: 0, messages: 0, chunks: 0 });
  });

  it("a refund that fails is logged, never thrown, and leaves the other counters refunded", async () => {
    const org = await newOrg();
    const reserved = await reserveAppend(db, org, "free", msgs(2));
    if (!reserved.allowed) throw new Error("expected the reservation to succeed");
    // D1 that refuses only the storage refund.
    const flaky = {
      prepare: (sql: string) => {
        if (sql.includes("messages_stored_total = MAX(0")) throw new Error("D1 down (test)");
        return db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;
    const log = { error: vi.fn() };

    await expect(releaseAppendCharges(flaky, org, reserved.charges, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(String(log.error.mock.calls[0][0])).toMatch(/could not refund 2 storage/);
    // Over-charged by the failed refund, never under-charged.
    expect(await counters(org)).toEqual({ storage: 2, messages: 0, chunks: 0 });
  });

  it("a refund goes back to the month the charge was made in, even across midnight on the 1st", async () => {
    const org = await newOrg();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2031-01-31T23:59:59Z"));
    const reserved = await reserveAppend(db, org, "free", msgs(2));
    if (!reserved.allowed) throw new Error("expected the reservation to succeed");
    expect(reserved.charges.period).toBe("2031-01");
    const january = await counters(org, "2031-01");
    expect(january.messages).toBe(2);

    vi.setSystemTime(new Date("2031-02-01T00:00:01Z"));
    await releaseAppendCharges(db, org, reserved.charges);
    expect(await counters(org, "2031-01")).toEqual({ storage: 0, messages: 0, chunks: 0 });
    // Nothing was charged to, or refunded from, February.
    expect(await usageRows(org, "2031-02")).toBe(0);
  });

  it("the month is read once: a reservation that straddles midnight on the 1st charges, and refunds, the month it began in", async () => {
    const org = await newOrg();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2032-03-31T23:59:59Z"));
    // D1 whose clock reaches April while the storage gate runs: after the
    // reservation read the month, before the monthly and indexing charges.
    const straddling = {
      prepare: (sql: string) => {
        if (/SET messages_stored_total = messages_stored_total \+/.test(sql)) {
          vi.setSystemTime(new Date("2032-04-01T00:00:01Z"));
        }
        return db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;
    const messages = msgs(2);

    const reserved = await reserveAppend(straddling, org, "free", messages);
    if (!reserved.allowed) throw new Error("expected the reservation to succeed");
    expect(reserved.charges.period).toBe("2032-03");
    expect(getCurrentPeriod()).toBe("2032-04");
    expect(await counters(org, "2032-03")).toEqual({
      storage: 2,
      messages: 2,
      chunks: estimateIndexingUnits(messages),
    });
    expect(await usageRows(org, "2032-04")).toBe(0);

    await releaseAppendCharges(db, org, reserved.charges);
    expect(await counters(org, "2032-03")).toEqual({ storage: 0, messages: 0, chunks: 0 });
    expect(await usageRows(org, "2032-04")).toBe(0);
  });
});
