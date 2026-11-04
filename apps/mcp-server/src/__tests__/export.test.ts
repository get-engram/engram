import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { dataExport, decodeCursor, encodeCursor } from "../routes/export.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { insertOrganization, insertConversation } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(orgId: string, apiKeyId = "key_test") {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: orgId,
      apiKeyId,
      scopes: ["read", "write", "search", "delete"],
      tier: "free" as const,
    });
    await next();
  });
  // Both mounts in production (engram#544): the documented REST path and the
  // original one.
  app.route("/api/export", dataExport);
  app.route("/api/v1/export", dataExport);
  return app;
}

async function seedMessages(
  env: ReturnType<typeof createMockEnv>,
  orgId: string,
  convId: string,
  count: number,
) {
  for (let i = 1; i <= count; i++) {
    await env.DB.prepare(
      "INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, sequence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(`msg_${convId}_${i}`, convId, orgId, i % 2 ? "user" : "assistant", `body ${i}`, null, i, "2026-01-01T00:00:00Z")
      .run();
  }
}

interface ExportPage {
  export_version: string;
  exported_at: string;
  organization: Record<string, unknown>;
  total_conversations: number;
  page: { cursor: string | null; limit: number };
  next_cursor: string | null;
  conversations: Array<{
    id: string;
    message_offset: number;
    messages: Array<{ sequence: number; content: string }>;
  }>;
}

async function fetchPage(
  app: Hono<HonoEnv>,
  env: ReturnType<typeof createMockEnv>,
  path: string,
): Promise<ExportPage> {
  const res = await app.request(path, { method: "GET" }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as ExportPage;
}

describe("GET /api/export", () => {
  it("exports organization data as JSON", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_exp", "Export Org");
    await insertConversation(db, "conv_1", "org_exp", "My Chat", "agent_1", ["dev"], {});

    const app = createApp("org_exp");
    const res = await app.request("/api/export", { method: "GET" }, env);

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("engram-export");

    const body = (await res.json()) as ExportPage;
    expect(body.export_version).toBe("1.1");
    expect(body.exported_at).toBeDefined();
    expect(body.organization).toBeDefined();
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(body.total_conversations).toBe(1);
    expect(body.next_cursor).toBeNull();
  });

  it("returns 404 for non-existent org", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);

    const app = createApp("org_ghost");
    const res = await app.request("/api/export", { method: "GET" }, env);

    expect(res.status).toBe(404);
  });

  it("includes conversation messages in export", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_msg_exp", "Msg Org");
    await insertConversation(db, "conv_2", "org_msg_exp", "Chat 2", null, [], {});
    await seedMessages(env, "org_msg_exp", "conv_2", 3);

    const app = createApp("org_msg_exp");
    const res = await app.request("/api/export", { method: "GET" }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportPage;
    expect(body.conversations.length).toBe(1);
    expect(body.conversations[0].messages.map((m) => m.content)).toEqual([
      "body 1",
      "body 2",
      "body 3",
    ]);
    expect(body.conversations[0].message_offset).toBe(0);
  });

  it("is reachable at the documented REST path /api/v1/export (engram#544)", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_v1", "V1 Org");
    await insertConversation(db, "conv_v1", "org_v1", "Hello", null, [], {});

    const app = createApp("org_v1");
    const res = await app.request("/api/v1/export", { method: "GET" }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ExportPage;
    expect(body.conversations.map((c) => c.id)).toEqual(["conv_v1"]);
  });

  it("refuses a connected OAuth app", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_oauth", "OAuth Org");

    const app = createApp("org_oauth", "oauth:conn_1");
    const res = await app.request("/api/v1/export", { method: "GET" }, env);
    expect(res.status).toBe(403);
  });

  it("rejects a malformed cursor or limit", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_bad", "Bad Org");
    const app = createApp("org_bad");

    expect((await app.request("/api/v1/export?cursor=nonsense", { method: "GET" }, env)).status).toBe(400);
    expect((await app.request("/api/v1/export?cursor=conv_x:-1", { method: "GET" }, env)).status).toBe(400);
    expect((await app.request("/api/v1/export?limit=0", { method: "GET" }, env)).status).toBe(400);
    expect((await app.request("/api/v1/export?limit=401", { method: "GET" }, env)).status).toBe(400);
    expect((await app.request("/api/v1/export?limit=abc", { method: "GET" }, env)).status).toBe(400);
  });
});

describe("paged export (engram#546)", () => {
  it("walks every conversation across pages and ends with next_cursor null", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_pg", "Paged Org");
    // Ids deliberately out of insertion order: paging is by id, not by when
    // the row was written.
    for (const [id, n] of [["conv_c", 2], ["conv_a", 1], ["conv_b", 0], ["conv_d", 3]] as const) {
      await insertConversation(db, id, "org_pg", `Title ${id}`, null, [], {});
      await seedMessages(env, "org_pg", id, n);
    }

    const app = createApp("org_pg");
    const seen: Array<[string, number[]]> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/v1/export?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await fetchPage(app, env, url);
      pages++;
      expect(page.total_conversations).toBe(4);
      expect(page.page.limit).toBe(2);
      for (const conv of page.conversations) {
        seen.push([conv.id, conv.messages.map((m) => m.sequence)]);
      }
      cursor = page.next_cursor;
    } while (cursor !== null && pages < 20);

    expect(pages).toBeGreaterThan(1);
    // Every conversation appears, in id order, with every message exactly once.
    const merged = new Map<string, number[]>();
    for (const [id, seqs] of seen) merged.set(id, [...(merged.get(id) ?? []), ...seqs]);
    expect([...merged.keys()]).toEqual(["conv_a", "conv_b", "conv_c", "conv_d"]);
    expect(merged.get("conv_a")).toEqual([1]);
    expect(merged.get("conv_b")).toEqual([]);
    expect(merged.get("conv_c")).toEqual([1, 2]);
    expect(merged.get("conv_d")).toEqual([1, 2, 3]);
  });

  it("splits a conversation larger than a page and labels each slice with message_offset", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_big", "Big Org");
    await insertConversation(db, "conv_big", "org_big", "Huge", null, [], {});
    await seedMessages(env, "org_big", "conv_big", 7);

    const app = createApp("org_big");
    const first = await fetchPage(app, env, "/api/v1/export?limit=3");
    expect(first.conversations.length).toBe(1);
    expect(first.conversations[0].message_offset).toBe(0);
    expect(first.conversations[0].messages.map((m) => m.sequence)).toEqual([1, 2, 3]);
    expect(first.next_cursor).toBe("conv_big:3");

    const second = await fetchPage(app, env, `/api/v1/export?limit=3&cursor=${first.next_cursor}`);
    expect(second.conversations[0].id).toBe("conv_big");
    expect(second.conversations[0].message_offset).toBe(3);
    expect(second.conversations[0].messages.map((m) => m.sequence)).toEqual([4, 5, 6]);
    expect(second.next_cursor).toBe("conv_big:6");

    const third = await fetchPage(app, env, `/api/v1/export?limit=3&cursor=${second.next_cursor}`);
    expect(third.conversations[0].message_offset).toBe(6);
    expect(third.conversations[0].messages.map((m) => m.sequence)).toEqual([7]);
    expect(third.next_cursor).toBeNull();
  });

  it("a page that ends exactly on a conversation boundary resumes cleanly", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_edge", "Edge Org");
    await insertConversation(db, "conv_1", "org_edge", "One", null, [], {});
    await seedMessages(env, "org_edge", "conv_1", 2);
    await insertConversation(db, "conv_2", "org_edge", "Two", null, [], {});
    await seedMessages(env, "org_edge", "conv_2", 1);

    const app = createApp("org_edge");
    const first = await fetchPage(app, env, "/api/v1/export?limit=2");
    expect(first.conversations.map((c) => c.id)).toEqual(["conv_1"]);
    expect(first.next_cursor).not.toBeNull();

    const second = await fetchPage(app, env, `/api/v1/export?limit=2&cursor=${first.next_cursor}`);
    // conv_1 had nothing left: it is not repeated with an empty slice.
    expect(second.conversations.map((c) => c.id)).toEqual(["conv_2"]);
    expect(second.conversations[0].messages.map((m) => m.sequence)).toEqual([1]);
    expect(second.next_cursor).toBeNull();
  });

  it("cursor round-trips", () => {
    expect(decodeCursor(undefined)).toEqual({ conversationId: null, messageOffset: 0 });
    expect(decodeCursor("")).toEqual({ conversationId: null, messageOffset: 0 });
    expect(decodeCursor("conv_abc:0")).toEqual({ conversationId: "conv_abc", messageOffset: 0 });
    expect(decodeCursor("conv_abc:400")).toEqual({ conversationId: "conv_abc", messageOffset: 400 });
    expect(decodeCursor(":5")).toBeNull();
    expect(decodeCursor("conv_abc")).toBeNull();
    expect(decodeCursor("conv_abc:x")).toBeNull();
    expect(encodeCursor({ conversationId: "conv_abc", messageOffset: 12 })).toBe("conv_abc:12");
  });
});
