import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { privacy } from "../routes/privacy.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { insertOrganization } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(orgId: string) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: orgId,
      apiKeyId: "key_test",
      tier: "free" as const,
    });
    await next();
  });
  app.route("/api/privacy", privacy);
  return app;
}

describe("GET /api/privacy", () => {
  it("defaults both toggles to open (true) for a fresh org", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_p1", "Privacy Org");

    const app = createApp("org_p1");
    const res = await app.request("/api/privacy", {}, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.assistant_can_read_bodies).toBe(true);
    expect(body.assistant_can_read_cross_conversation).toBe(true);
  });
});

describe("PATCH /api/privacy", () => {
  it("rejects non-boolean values with 400", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_p2", "Privacy Org");

    const app = createApp("org_p2");
    const res = await app.request(
      "/api/privacy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistant_can_read_bodies: "nope" }),
      },
      env,
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_settings");
  });

  it("updates one toggle and leaves the other at its default", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_p3", "Privacy Org");

    const app = createApp("org_p3");
    const res = await app.request(
      "/api/privacy",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistant_can_read_bodies: false }),
      },
      env,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.updated).toBe(true);
    expect(body.assistant_can_read_bodies).toBe(false);
    // Omitted field merges onto the current (default-open) value.
    expect(body.assistant_can_read_cross_conversation).toBe(true);
  });
});
