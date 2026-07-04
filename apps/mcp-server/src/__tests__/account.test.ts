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
      scopes: ["read", "write", "search", "delete"],
      tier: "free" as const,
    });
    await next();
  });

  app.route("/api/account", account);
  return app;
}

describe("DELETE /api/account", () => {
  it("soft-deletes an organization and returns grace period info", async () => {
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
    expect(body.grace_period_days).toBe(30);
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
});

describe("POST /api/account/restore", () => {
  it("returns 400 when org is not deleted", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_active", "Active Org");

    const app = createApp("org_active");
    const res = await app.request("/api/account/restore", { method: "POST" }, env);

    // Org exists but has no deleted_at set — should return 400
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Account is not marked for deletion");
  });

  it("returns 404 for non-existent org", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);

    const app = createApp("org_gone");
    const res = await app.request("/api/account/restore", { method: "POST" }, env);

    expect(res.status).toBe(404);
  });
});
