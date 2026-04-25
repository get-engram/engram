import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(tier: AuthContext["tier"] = "free") {
  const app = new Hono<HonoEnv>();

  // Fake auth middleware — sets auth context
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: `org_${tier}`,
      apiKeyId: "key_test",
      tier,
    });
    await next();
  });

  app.use("*", rateLimitMiddleware);
  app.get("/test", (c) => c.json({ ok: true }));

  return app;
}

describe("rate limit middleware", () => {
  it("allows requests under the limit", async () => {
    const app = createApp("pro"); // 120/min
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("120");
  });

  it("returns 429 when limit is exceeded", async () => {
    const app = createApp("free"); // 30/min
    // Use a unique org to avoid polluting other tests
    const uniqueApp = new Hono<HonoEnv>();
    uniqueApp.use("*", async (c, next) => {
      c.set("auth", {
        organizationId: "org_burst_test",
        apiKeyId: "key_test",
        tier: "free",
      });
      await next();
    });
    uniqueApp.use("*", rateLimitMiddleware);
    uniqueApp.get("/test", (c) => c.json({ ok: true }));

    // Send 31 requests — the 31st should be rejected
    let lastStatus = 200;
    for (let i = 0; i < 31; i++) {
      const res = await uniqueApp.request("/test");
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it("returns correct error body on 429", async () => {
    const uniqueApp = new Hono<HonoEnv>();
    uniqueApp.use("*", async (c, next) => {
      c.set("auth", {
        organizationId: "org_error_body_test",
        apiKeyId: "key_test",
        tier: "free",
      });
      await next();
    });
    uniqueApp.use("*", rateLimitMiddleware);
    uniqueApp.get("/test", (c) => c.json({ ok: true }));

    // Exhaust the limit
    for (let i = 0; i < 30; i++) {
      await uniqueApp.request("/test");
    }

    const res = await uniqueApp.request("/test");
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retry_after).toBe(60);
  });

  it("gives higher limits to paid tiers", async () => {
    // Enterprise gets 600/min — 31 requests should be fine
    const app = new Hono<HonoEnv>();
    app.use("*", async (c, next) => {
      c.set("auth", {
        organizationId: "org_enterprise_test",
        apiKeyId: "key_test",
        tier: "enterprise",
      });
      await next();
    });
    app.use("*", rateLimitMiddleware);
    app.get("/test", (c) => c.json({ ok: true }));

    let allOk = true;
    for (let i = 0; i < 50; i++) {
      const res = await app.request("/test");
      if (res.status !== 200) {
        allOk = false;
        break;
      }
    }
    expect(allOk).toBe(true);
  });
});
