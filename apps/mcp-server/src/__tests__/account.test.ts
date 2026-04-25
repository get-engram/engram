import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { account } from "../routes/account.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { insertOrganization, insertConversation } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(orgId: string) {
  const app = new Hono<HonoEnv>();

  // Fake auth middleware
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: orgId,
      apiKeyId: "key_test",
      tier: "free" as const,
    });
    await next();
  });

  app.route("/api/account", account);
  return app;
}

describe("DELETE /api/account", () => {
  it("deletes an organization and returns stats", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_del", "Delete Me");
    await insertConversation(db, "conv_1", "org_del", "Test", null, [], {});

    const app = createApp("org_del");
    const res = await app.request("/api/account", { method: "DELETE" }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.deleted).toBe(true);
    expect(body.organization_id).toBe("org_del");
    expect(body.deleted_records).toBeDefined();
  });

  it("returns 404 for non-existent org", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);

    const app = createApp("org_ghost");
    const res = await app.request("/api/account", { method: "DELETE" }, env);

    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Organization not found");
  });

  it("calls VECTORIZE.deleteByIds when vectors exist", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_vec", "Vec Org");

    // Manually insert a chunk with a vectorize_id
    await db
      .prepare(
        "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("chk_1", "conv_1", "org_vec", "test", 1, 1, "vec_abc")
      .run();

    const app = createApp("org_vec");
    const res = await app.request("/api/account", { method: "DELETE" }, env);

    expect(res.status).toBe(200);
    expect(env.VECTORIZE.deleteByIds).toHaveBeenCalledWith(["vec_abc"]);
  });
});
