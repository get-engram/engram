import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { v1 } from "../routes/v1.js";
import { meterApiRequest } from "../middleware/meter.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { insertOrganization } from "@getengram/db";
import type { Env, AuthContext } from "../types.js";
import type { Scope } from "../mcp/scopes.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createApp(orgId: string, scopes: Scope[] = ["read", "write", "search", "delete"]) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      organizationId: orgId,
      apiKeyId: "key_test",
      scopes,
      tier: "free" as const,
    });
    await next();
  });
  app.route("/api/v1", v1);
  return app;
}

describe("REST v1 — scopes", () => {
  it("rejects create without the write scope", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_scope", ["read"]);

    const res = await app.request(
      "/api/v1/conversations",
      { method: "POST", body: JSON.stringify({}), headers: { "Content-Type": "application/json" } },
      env,
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; required: string };
    expect(body.error).toBe("insufficient_scope");
    expect(body.required).toBe("write");
  });

  it("rejects delete without the delete scope", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_scope", ["read", "write", "search"]);

    const res = await app.request("/api/v1/conversations/conv_x", { method: "DELETE" }, env);
    expect(res.status).toBe(403);
  });
});

describe("REST v1 — conversations", () => {
  it("creates a conversation and returns 201", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_v1", "V1 Org");
    const app = createApp("org_v1");

    const res = await app.request(
      "/api/v1/conversations",
      {
        method: "POST",
        body: JSON.stringify({ title: "REST chat", tags: ["api"] }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation_id: string };
    expect(body.conversation_id).toMatch(/^conv_/);
  });

  it("rejects an invalid create body", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_v1");

    const res = await app.request(
      "/api/v1/conversations",
      {
        method: "POST",
        body: JSON.stringify({ tags: "not-an-array" }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_body");
  });

  it("lists conversations for the org", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_list", "List Org");
    const app = createApp("org_list");

    await app.request(
      "/api/v1/conversations",
      {
        method: "POST",
        body: JSON.stringify({ title: "One" }),
        headers: { "Content-Type": "application/json" },
      },
      env,
    );

    const res = await app.request("/api/v1/conversations", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[]; total: number };
    expect(body.total).toBe(1);
  });

  it("returns 404 for a missing conversation", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_404");

    const res = await app.request("/api/v1/conversations/conv_missing", { method: "GET" }, env);
    expect(res.status).toBe(404);
  });

  it("returns 404 deleting a missing conversation", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_404");

    const res = await app.request("/api/v1/conversations/conv_missing", { method: "DELETE" }, env);
    expect(res.status).toBe(404);
  });
});

describe("REST v1 — search", () => {
  it("requires a query", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const app = createApp("org_search");

    const res = await app.request("/api/v1/search", { method: "GET" }, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("missing_query");
  });

  it("returns an empty result set", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    await insertOrganization(db, "org_search", "Search Org");
    const app = createApp("org_search");

    const res = await app.request("/api/v1/search?q=hello", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { results: unknown[]; total: number };
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
  });
});

describe("meterApiRequest middleware", () => {
  function meteredApp(auth: AuthContext | null) {
    const app = new Hono<HonoEnv>();
    if (auth) {
      app.use("*", async (c, next) => {
        c.set("auth", auth);
        await next();
      });
    }
    app.use("*", meterApiRequest);
    app.get("/ping", (c) => c.json({ ok: true }));
    return app;
  }

  it("counts an authenticated request via waitUntil", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;

    const app = meteredApp({
      organizationId: "org_meter",
      apiKeyId: "key_m",
      scopes: ["read"],
      tier: "free",
    });
    const res = await app.fetch(new Request("http://localhost/ping"), env, ctx);
    expect(res.status).toBe(200);
    expect(waited.length).toBe(1);
    await Promise.all(waited);
  });

  it("does not count admin requests", async () => {
    const db = createMockD1();
    const env = createMockEnv(db);
    const waited: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;

    const app = meteredApp({
      organizationId: "admin",
      apiKeyId: "admin",
      scopes: ["read"],
      tier: "enterprise",
      isAdmin: true,
    });
    const res = await app.fetch(new Request("http://localhost/ping"), env, ctx);
    expect(res.status).toBe(200);
    expect(waited.length).toBe(0);
  });
});
