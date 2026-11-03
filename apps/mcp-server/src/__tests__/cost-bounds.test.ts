import { describe, it, expect, vi, type Mock } from "vitest";
import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TIER_LIMITS } from "@getengram/shared";
import { insertOrganization, getUsage, getCurrentPeriod } from "@getengram/db";
import { v1 } from "../routes/v1.js";
import { usage } from "../routes/usage.js";
import { memories } from "../routes/memories.js";
import { registerSearch } from "../mcp/tools/search.js";
import { registerAppendMessages } from "../mcp/tools/append-messages.js";
import { estimateIndexingUnits } from "../services/tier.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";
import type { Scope } from "../mcp/scopes.js";

/**
 * End-to-end behavior of the cost budgets (engram#445, #450, #451) on every
 * surface that spends them: the three save paths (MCP tool, REST, dashboard)
 * and the three search paths, plus the edit/delete re-index. The point of
 * each refusal test is the same — the request is turned away BEFORE the
 * expensive call (the embedding model, the vector query) and before any
 * write, with a structured 429 the client can act on.
 */

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };
const ALL_SCOPES: Scope[] = ["read", "write", "search", "delete"];
const FREE = TIER_LIMITS.free;
const JSON_HEADERS = { "Content-Type": "application/json" };

function authFor(
  organizationId: string,
  tier: AuthContext["tier"] = "free",
  apiKeyId = "key_test",
): AuthContext {
  return { organizationId, apiKeyId, scopes: ALL_SCOPES, tier };
}

function restApp(auth: AuthContext) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/api/v1", v1);
  app.route("/api/usage", usage);
  app.route("/api/memories", memories);
  return app;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

/** Captures the handlers register*() hands to the SDK server. */
function captureTools() {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
    tool: (name: string, ...rest: unknown[]) => {
      tools.set(name, rest[rest.length - 1] as ToolHandler);
    },
  } as unknown as McpServer;
  return { server, tools };
}

function toolJson(result: Awaited<ReturnType<ToolHandler>>) {
  return {
    data: JSON.parse(result.content[0].text) as Record<string, unknown>,
    isError: result.isError ?? false,
  };
}

/** A usage row for the current period with the given counters already spent. */
async function seedUsage(
  db: D1Database,
  organizationId: string,
  spent: { searches_run?: number; chunks_indexed?: number },
) {
  await db.exec(
    `INSERT INTO usage (id, organization_id, period, messages_stored, searches_run, api_requests, chunks_indexed) VALUES ('usg_${organizationId}', '${organizationId}', '${getCurrentPeriod()}', 0, ${spent.searches_run ?? 0}, 0, ${spent.chunks_indexed ?? 0})`,
  );
}

async function setup(organizationId: string) {
  const db = createMockD1();
  const env = createMockEnv(db) as unknown as Env;
  await insertOrganization(db, organizationId, `Org ${organizationId}`);
  const ai = env.AI as unknown as { run: Mock };
  const vec = env.VECTORIZE as unknown as { query: Mock; upsert: Mock; deleteByIds: Mock };
  return { db, env, ai, vec };
}

async function usageRow(db: D1Database, organizationId: string) {
  return (await getUsage(db, organizationId)) as {
    searches_run: number;
    chunks_indexed: number;
  } | null;
}

async function rows(db: D1Database, table: string) {
  return (await db.prepare(`SELECT * FROM ${table}`).all()).results;
}

/** Create a conversation and append `bodies` to it through the REST API. */
async function seedConversation(app: Hono<HonoEnv>, env: Env, bodies: string[]) {
  const create = await app.request(
    "/api/v1/conversations",
    { method: "POST", body: JSON.stringify({ title: "Budget" }), headers: JSON_HEADERS },
    env,
  );
  expect(create.status).toBe(201);
  const { conversation_id } = (await create.json()) as { conversation_id: string };
  const append = await app.request(
    "/api/v1/messages",
    {
      method: "POST",
      body: JSON.stringify({
        conversation_id,
        messages: bodies.map((content) => ({ role: "user", content })),
      }),
      headers: JSON_HEADERS,
    },
    env,
  );
  expect(append.status).toBe(200);
  const { message_ids } = (await append.json()) as { message_ids: string[] };
  return { conversationId: conversation_id, messageIds: message_ids };
}

describe("search budget (engram#451)", () => {
  it("REST search is refused with 429 before anything is embedded or queried", async () => {
    const org = "org_cb_s1";
    const { db, env, ai, vec } = await setup(org);
    await seedUsage(db, org, { searches_run: FREE.searches_per_month });

    const res = await restApp(authFor(org)).request("/api/v1/search?q=hello", {}, env);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "search_quota_exceeded",
      limit: FREE.searches_per_month,
      used: FREE.searches_per_month,
      tier: "free",
      upgrade_url: "https://getengram.app/pricing",
    });
    expect(ai.run).not.toHaveBeenCalled();
    expect(vec.query).not.toHaveBeenCalled();
  });

  it("a search under the budget runs and is counted", async () => {
    const org = "org_cb_s2";
    const { db, env } = await setup(org);
    const app = restApp(authFor(org));

    expect((await app.request("/api/v1/search?q=hello", {}, env)).status).toBe(200);
    expect((await usageRow(db, org))?.searches_run).toBe(1);
    expect((await app.request("/api/v1/search?q=again", {}, env)).status).toBe(200);
    expect((await usageRow(db, org))?.searches_run).toBe(2);
  });

  it("the MCP search tool answers an isError with factual connector copy", async () => {
    const org = "org_cb_s3";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { searches_run: FREE.searches_per_month });
    const { server, tools } = captureTools();
    registerSearch(server, env, authFor(org, "free", "oauth:conn_1"));

    const { data, isError } = toolJson(await tools.get("search")!({ query: "hello" }));
    expect(isError).toBe(true);
    expect(data.error).toBe("search_quota_exceeded");
    expect(data.limit).toBe(FREE.searches_per_month);
    expect(data.tier).toBe("free");
    expect(data.message).toMatch(/limit reached/i);
    expect(data.message).not.toMatch(/https?:\/\/|getengram\.app/i);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("the dashboard search path is metered too", async () => {
    const org = "org_cb_s4";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { searches_run: FREE.searches_per_month });

    const res = await restApp(authFor(org)).request("/api/memories/search?q=hello", {}, env);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("search_quota_exceeded");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("an unlimited tier is never refused", async () => {
    const org = "org_cb_s5";
    const { db, env } = await setup(org);
    await seedUsage(db, org, { searches_run: 999_999_999 });

    const res = await restApp(authFor(org, "enterprise")).request("/api/v1/search?q=hello", {}, env);
    expect(res.status).toBe(200);
  });
});

describe("indexing budget (engram#445, #450)", () => {
  it("REST append is refused with 429 and nothing is stored or embedded", async () => {
    const org = "org_cb_i1";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { chunks_indexed: FREE.chunks_indexed_per_month });

    const res = await restApp(authFor(org)).request(
      "/api/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "remember this" }] }),
        headers: JSON_HEADERS,
      },
      env,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "indexing_quota_exceeded",
      limit: FREE.chunks_indexed_per_month,
      used: FREE.chunks_indexed_per_month,
      tier: "free",
      upgrade_url: "https://getengram.app/pricing",
    });
    expect(await rows(db, "messages")).toHaveLength(0);
    expect(await rows(db, "conversations")).toHaveLength(0);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("the MCP append tool refuses with the indexing copy", async () => {
    const org = "org_cb_i2";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { chunks_indexed: FREE.chunks_indexed_per_month });
    const { server, tools } = captureTools();
    registerAppendMessages(server, env, authFor(org, "free", "oauth:conn_2"));

    const { data, isError } = toolJson(
      await tools.get("append_messages")!({
        messages: [{ role: "user", content: "remember this" }],
      }),
    );
    expect(isError).toBe(true);
    expect(data.error).toBe("indexing_quota_exceeded");
    expect(data.message).toMatch(/limit reached/i);
    expect(data.message).toContain("indexed chunks");
    expect(data.message).not.toMatch(/https?:\/\/|getengram\.app/i);
    expect(await rows(db, "messages")).toHaveLength(0);
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("the dashboard save path is metered too", async () => {
    const org = "org_cb_i3";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { chunks_indexed: FREE.chunks_indexed_per_month });

    const res = await restApp(authFor(org)).request(
      "/api/memories",
      { method: "POST", body: JSON.stringify({ text: "remember this" }), headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("indexing_quota_exceeded");
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("a batch is charged in chunks embedded, not messages", async () => {
    const org = "org_cb_i4";
    const { db, env, ai } = await setup(org);
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user",
      content: `note ${i}`,
    }));
    const expected = estimateIndexingUnits(messages);
    expect(expected).toBeGreaterThan(0);
    expect(expected).toBeLessThan(messages.length);

    const res = await restApp(authFor(org)).request(
      "/api/v1/messages",
      { method: "POST", body: JSON.stringify({ messages }), headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(200);
    expect((await usageRow(db, org))?.chunks_indexed).toBe(expected);
    // …and that is exactly how many texts went to the embedding model.
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((ai.run.mock.calls[0][1] as { text: string[] }).text).toHaveLength(expected);
  });
});

describe("edit and delete re-index (engram#445)", () => {
  it("an edit is refused before anything is written when the budget is spent", async () => {
    const org = "org_cb_e1";
    const { db, env, ai } = await setup(org);
    await seedUsage(db, org, { chunks_indexed: FREE.chunks_indexed_per_month });
    // Seed through an unlimited tier so the budget only bites on the edit.
    const { conversationId, messageIds } = await seedConversation(
      restApp(authFor(org, "enterprise")),
      env,
      ["the old wording"],
    );
    ai.run.mockClear();

    const res = await restApp(authFor(org)).request(
      `/api/v1/conversations/${conversationId}/messages/${messageIds[0]}`,
      { method: "PATCH", body: JSON.stringify({ content: "the new wording" }), headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "indexing_quota_exceeded",
      limit: FREE.chunks_indexed_per_month,
      used: FREE.chunks_indexed_per_month,
      tier: "free",
      upgrade_url: "https://getengram.app/pricing",
    });
    expect(ai.run).not.toHaveBeenCalled();
    // The previous body is archived before the new one is written; no
    // archive means the write never started.
    expect(await rows(db, "message_revisions")).toHaveLength(0);
  });

  it("an edit under the budget re-embeds its window and is charged for it", async () => {
    const org = "org_cb_e2";
    const { db, env, ai } = await setup(org);
    const app = restApp(authFor(org));
    const { conversationId, messageIds } = await seedConversation(app, env, ["the old wording"]);
    expect((await usageRow(db, org))?.chunks_indexed).toBe(1);
    ai.run.mockClear();

    const res = await app.request(
      `/api/v1/conversations/${conversationId}/messages/${messageIds[0]}`,
      { method: "PATCH", body: JSON.stringify({ content: "the new wording" }), headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(200);
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect((await usageRow(db, org))?.chunks_indexed).toBe(2);
    expect(await rows(db, "message_revisions")).toHaveLength(1);
  });

  it("an edit body is bounded like an append before it is chunked", async () => {
    const org = "org_cb_e3";
    const { env, ai } = await setup(org);
    const app = restApp(authFor(org));
    const { conversationId, messageIds } = await seedConversation(app, env, ["short"]);
    ai.run.mockClear();

    // ~990,000 characters of prose (the schema's ceiling is 1,000,000) used
    // to go straight into the embedding model (~520 chunks). Bounded to
    // MAX_MESSAGE_CONTENT_CHARS it is the same ~53-chunk window an append of
    // that body produces — and exactly the number the append estimate
    // charges for it.
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(22_000);
    const res = await app.request(
      `/api/v1/conversations/${conversationId}/messages/${messageIds[0]}`,
      { method: "PATCH", body: JSON.stringify({ content: prose }), headers: JSON_HEADERS },
      env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { message: { content: string } };
    expect(body.message.content).toMatch(/\[truncated: message exceeded/);
    expect(ai.run).toHaveBeenCalledTimes(1);
    const texts = (ai.run.mock.calls[0][1] as { text: string[] }).text;
    expect(texts.length).toBe(estimateIndexingUnits([{ role: "user", content: prose }]));
    expect(texts.length).toBeLessThan(60);
  });

  it("a delete always completes; past the budget the stale chunks are dropped without re-embedding", async () => {
    const org = "org_cb_d1";
    const { db, env, ai, vec } = await setup(org);
    await seedUsage(db, org, { chunks_indexed: FREE.chunks_indexed_per_month });
    const { conversationId, messageIds } = await seedConversation(
      restApp(authFor(org, "enterprise")),
      env,
      ["first", "second"],
    );
    expect(await rows(db, "conversation_chunks")).not.toHaveLength(0);
    ai.run.mockClear();
    vec.upsert.mockClear();
    vec.deleteByIds.mockClear();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await restApp(authFor(org)).request(
        `/api/v1/conversations/${conversationId}/messages/${messageIds[0]}`,
        { method: "DELETE" },
        env,
      );
      expect(res.status).toBe(200);
      // The deleted text must not stay recallable: its vectors go…
      expect(vec.deleteByIds).toHaveBeenCalled();
      // …but the window is not re-embedded on an exhausted budget.
      expect(ai.run).not.toHaveBeenCalled();
      expect(vec.upsert).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Indexing budget exhausted/));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("GET /api/usage", () => {
  it("reports both budgets with the plan's limits", async () => {
    const org = "org_cb_u1";
    const { db, env } = await setup(org);
    await seedUsage(db, org, { searches_run: 5, chunks_indexed: 7 });

    const res = await restApp(authFor(org)).request("/api/usage", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      searches: { used: number; limit: number };
      indexing: { used: number; limit: number };
    };
    expect(body.searches).toEqual({ used: 5, limit: FREE.searches_per_month });
    expect(body.indexing).toEqual({ used: 7, limit: FREE.chunks_indexed_per_month });

    const ent = await restApp(authFor(org, "enterprise")).request("/api/usage", {}, env);
    const entBody = (await ent.json()) as typeof body;
    expect(entBody.searches.limit).toBe(-1);
    expect(entBody.indexing.limit).toBe(-1);
  });
});
