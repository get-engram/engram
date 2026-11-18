import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { TIER_LIMITS, type Tier } from "@getengram/shared";
import { webhooks } from "../routes/webhooks.js";
import { usage } from "../routes/usage.js";
import { checkFeatureAccess } from "../services/tier.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Webhooks and the usage dashboard belong to every paid plan (engram#766).
 * They were Team and up before; the free plan still has neither.
 */

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const PAID: Tier[] = ["pro", "student", "team", "enterprise"];

function ownerOn(tier: Tier): AuthContext {
  return {
    organizationId: `org_${tier}`,
    apiKeyId: "key_owner",
    // AuthContext's type predates the student plan; the value read from the
    // organization row at sign-in can be any Tier.
    tier: tier as AuthContext["tier"],
    scopes: ["read", "write", "search", "delete"],
    seatId: null,
  };
}

function appAs(auth: AuthContext) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/api/webhooks", webhooks);
  app.route("/api/usage", usage);
  return app;
}

function env(): Env {
  return createMockEnv(createMockD1()) as unknown as Env;
}

const register = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://hooks.example.com/engram", events: ["messages.appended"] }),
};

describe("what each plan includes", () => {
  it.each(PAID)("%s has webhooks and the usage dashboard", (tier) => {
    expect(checkFeatureAccess(tier, "webhooks")).toBe(true);
    expect(checkFeatureAccess(tier, "usage_dashboard")).toBe(true);
  });

  it("free has neither", () => {
    expect(checkFeatureAccess("free", "webhooks")).toBe(false);
    expect(checkFeatureAccess("free", "usage_dashboard")).toBe(false);
  });

  it("student is the same as pro for both", () => {
    expect(TIER_LIMITS.student.webhooks).toBe(TIER_LIMITS.pro.webhooks);
    expect(TIER_LIMITS.student.usage_dashboard).toBe(TIER_LIMITS.pro.usage_dashboard);
  });
});

describe("/api/webhooks by plan", () => {
  it.each(PAID)("the owner of a %s account can register and list an endpoint", async (tier) => {
    const e = env();
    const app = appAs(ownerOn(tier));
    const made = await app.request("/api/webhooks", register, e);
    expect(made.status).toBe(201);
    const body = (await made.json()) as { id: string; secret: string; events: string[] };
    expect(body.events).toEqual(["messages.appended"]);
    expect(body.secret).toBeTruthy();

    const list = await app.request("/api/webhooks", {}, e);
    expect(list.status).toBe(200);
    const { webhooks: rows } = (await list.json()) as { webhooks: { id: string }[] };
    expect(rows.map((r) => r.id)).toEqual([body.id]);
  });

  it("a free account is refused, and told it is a paid feature", async () => {
    const res = await appAs(ownerOn("free")).request("/api/webhooks", register, env());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string; tier: string };
    expect(body).toMatchObject({ error: "feature_not_available", tier: "free" });
    expect(body.message).toContain("paid plans");
    // Pro has it now; the message must not send anyone to Team for it.
    expect(body.message).not.toMatch(/team|enterprise/i);
  });
});

describe("GET /api/usage/history by plan", () => {
  it.each(PAID)("a %s account gets its history", async (tier) => {
    const res = await appAs(ownerOn(tier)).request("/api/usage/history", {}, env());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ history: [] });
  });

  it("a free account is refused, and told it is a paid feature", async () => {
    const res = await appAs(ownerOn("free")).request("/api/usage/history", {}, env());
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string; tier: string };
    expect(body).toMatchObject({ error: "feature_not_available", tier: "free" });
    expect(body.message).toContain("paid plans");
    expect(body.message).not.toMatch(/team|enterprise/i);
  });
});
