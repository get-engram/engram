import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { dataExport } from "../routes/export.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { insertOrganization, insertConversation } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(orgId: string) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: orgId,
      apiKeyId: "key_test",
      scopes: ["read", "write", "search", "delete"],
      tier: "free" as const,
    });
    await next();
  });
  app.route("/api/export", dataExport);
  return app;
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

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.export_version).toBe("1.0");
    expect(body.exported_at).toBeDefined();
    expect(body.organization).toBeDefined();
    expect(Array.isArray(body.conversations)).toBe(true);
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

    const app = createApp("org_msg_exp");
    const res = await app.request("/api/export", { method: "GET" }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ messages: unknown[] }> };
    expect(body.conversations.length).toBe(1);
    expect(Array.isArray(body.conversations[0].messages)).toBe(true);
  });
});
