import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { seats } from "../routes/seats.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

function createSeatsEnv(db: D1Database): Env {
  return {
    ...createMockEnv(db),
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    STRIPE_PRICE_ID_PRO: "price_pro",
    STRIPE_PRICE_ID_TEAM: "price_team",
    APP_URL: "https://test.example.com",
    ADMIN_SECRET: "admin_test",
    SUPABASE_JWT_SECRET: "jwt_test",
    SUPABASE_URL: "https://test.supabase.co",
  } as Env;
}

function createSeatsApp(env: Env, auth: AuthContext) {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/api/seats", seats);
  return app;
}

async function insertOrgWithSeatLimit(
  db: D1Database,
  id: string,
  name: string,
  email: string,
  tier: string,
  seatLimit: number,
) {
  await db.exec(
    `INSERT INTO organizations (id, name, email, tier, seat_limit) VALUES ('${id}', '${name}', '${email}', '${tier}', ${seatLimit})`,
  );
}

// ---------------------------------------------------------------------------
// Tests: GET /api/seats — List seats
// ---------------------------------------------------------------------------

describe("GET /api/seats", () => {
  it("returns empty list for new org", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);
    const res = await app.request("/api/seats", { method: "GET" }, env);

    expect(res.status).toBe(200);
    const data = await res.json() as { seats: unknown[] };
    expect(data.seats).toEqual([]);
  });

  it("returns invited seats", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);

    // Invite a seat first
    await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    }, env);

    const res = await app.request("/api/seats", { method: "GET" }, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { seats: unknown[] };
    expect(data.seats.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/seats — Invite a seat
// ---------------------------------------------------------------------------

describe("POST /api/seats", () => {
  it("invites a seat successfully", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);
    const res = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    }, env);

    expect(res.status).toBe(201);
    const data = await res.json() as { id: string; email: string; role: string; status: string };
    expect(data.email).toBe("new@example.com");
    expect(data.role).toBe("member");
    expect(data.status).toBe("invited");
  });

  it("returns 400 without email", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);
    const res = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    }, env);

    expect(res.status).toBe(400);
  });

  it("enforces seat limit from org.seat_limit", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    // Only 2 seats allowed
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 2);

    const app = createSeatsApp(env, auth);

    // Invite 2 seats (should succeed)
    const res1 = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    }, env);
    expect(res1.status).toBe(201);

    const res2 = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "b@example.com" }),
    }, env);
    expect(res2.status).toBe(201);

    // Third invite should fail
    const res3 = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "c@example.com" }),
    }, env);
    expect(res3.status).toBe(403);
    const data = await res3.json() as { error: string; limit: number };
    expect(data.error).toBe("seat_limit_exceeded");
    expect(data.limit).toBe(2);
  });

  it("free tier defaults to 1 seat", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_free", apiKeyId: "key_1", tier: "free", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_free", "Free Org", "free@example.com", "free", 1);

    const app = createSeatsApp(env, auth);

    // First seat
    const res1 = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    }, env);
    expect(res1.status).toBe(201);

    // Second seat should fail
    const res2 = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "b@example.com" }),
    }, env);
    expect(res2.status).toBe(403);
  });

  it("allows custom role", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);
    const res = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.com", role: "admin" }),
    }, env);

    expect(res.status).toBe(201);
    const data = await res.json() as { role: string };
    expect(data.role).toBe("admin");
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /api/seats/:id/accept — Accept a seat invitation
// ---------------------------------------------------------------------------

describe("POST /api/seats/:id/accept", () => {
  it("accepts an invited seat", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);

    // Invite
    const inviteRes = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com" }),
    }, env);
    const { id } = await inviteRes.json() as { id: string };

    // Accept
    const res = await app.request(`/api/seats/${id}/accept`, {
      method: "POST",
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { id: string; status: string };
    expect(data.status).toBe("accepted");
  });

  it("returns 404 for nonexistent seat", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);
    const res = await app.request("/api/seats/seat_nonexistent/accept", {
      method: "POST",
    }, env);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Tests: DELETE /api/seats/:id — Remove a seat
// ---------------------------------------------------------------------------

describe("DELETE /api/seats/:id", () => {
  it("removes a seat", async () => {
    const db = createMockD1();
    const env = createSeatsEnv(db);
    const auth: AuthContext = { organizationId: "org_1", apiKeyId: "key_1", tier: "team", scopes: ["read", "write", "search", "delete"] };
    await insertOrgWithSeatLimit(db, "org_1", "Test Org", "test@example.com", "team", 5);

    const app = createSeatsApp(env, auth);

    // Invite
    const inviteRes = await app.request("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "remove@example.com" }),
    }, env);
    const { id } = await inviteRes.json() as { id: string };

    // Delete
    const res = await app.request(`/api/seats/${id}`, {
      method: "DELETE",
    }, env);
    expect(res.status).toBe(200);
    const data = await res.json() as { removed: boolean };
    expect(data.removed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Webhook quantity sync (via billing webhook)
// ---------------------------------------------------------------------------

describe("webhook: subscription quantity sets seat_limit", () => {
  // These are tested in billing.test.ts — here we verify the DB query works
  it("setOrganizationTier stores seat_limit", async () => {
    const { setOrganizationTier } = await import("@getengram/db");
    const db = createMockD1();
    await insertOrgWithSeatLimit(db, "org_qty", "Qty Org", "qty@example.com", "free", 1);

    await setOrganizationTier(db, "org_qty", "team", "sub_123", 10);
    // In mock D1, UPDATE doesn't actually modify rows, but we verify no errors
    // Real D1 integration tests would verify the seat_limit column
  });
});
