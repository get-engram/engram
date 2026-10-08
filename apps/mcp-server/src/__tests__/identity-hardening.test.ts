import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { mintableScopes, type Scope } from "../mcp/scopes.js";
import { requiresClaim, signup } from "../routes/signup.js";
import { keys } from "../routes/keys.js";
import { verifySupabaseJwt } from "../utils/jwt.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Identity-layer hardening (engram#475 audit — criticals #1, #2, #3).
 *
 * These tests use a stub D1 that answers by SQL *shape*, which lets them
 * assert the one thing that matters most: that the routes authenticate keys
 * through the revocation-aware query. The stub returns a row for the OLD raw
 * `SELECT k.organization_id FROM api_keys k WHERE k.key_hash = ?` and NULL for
 * `getApiKeyWithOrg`'s join — so if anyone ever reverts to the raw lookup, a
 * "revoked" key starts authenticating again and these fail.
 */

// ── stub D1 ──────────────────────────────────────────────────────────────

interface StubRows {
  /** what getApiKeyWithOrg's join returns (null = revoked/expired/unknown) */
  keyWithOrg?: Record<string, unknown> | null;
  /** what getOrganizationByEmail returns */
  orgByEmail?: Record<string, unknown> | null;
  /** what getOrganizationById returns */
  orgById?: Record<string, unknown> | null;
}

function stubDb(rows: StubRows) {
  const writes: string[] = [];
  const db = {
    prepare: (sql: string) => {
      const stmt = {
        bind: () => stmt,
        first: async () => {
          if (/FROM api_keys k\s+JOIN organizations/i.test(sql)) return rows.keyWithOrg ?? null;
          // The pre-fix raw lookup: answer it, so a regression is visible.
          if (/SELECT k\.organization_id FROM api_keys k WHERE k\.key_hash/i.test(sql))
            return { organization_id: "org_LEAK" };
          if (/FROM organizations WHERE email/i.test(sql)) return rows.orgByEmail ?? null;
          if (/FROM organizations WHERE id/i.test(sql)) return rows.orgById ?? null;
          if (/SELECT email FROM organizations/i.test(sql)) return rows.orgById ?? null;
          if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
          return null;
        },
        run: async () => {
          writes.push(sql);
          return { success: true, meta: {} };
        },
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
    batch: async () => [],
  } as unknown as D1Database;
  return { db, writes };
}

const SECRET = "test-jwt-secret-identity-hardening";

function envWith(db: D1Database): Env {
  return {
    DB: db,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    APP_URL: "https://getengram.app",
  } as unknown as Env;
}

/** Minimal HS256 signer matching utils/jwt.ts (same approach jwt.test.ts uses). */
async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const enc = new TextEncoder();
  const b64 = (b: ArrayBuffer | Uint8Array) => {
    const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
    let s = "";
    for (const x of bytes) s += String.fromCharCode(x);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const header = b64(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = b64(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${header}.${body}`));
  return `${header}.${body}.${b64(sig)}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

// ── #2: scope narrowing is pure and strict ───────────────────────────────

describe("mintableScopes", () => {
  it("defaults to the caller's own scopes, never ALL_SCOPES", () => {
    expect(mintableScopes(["read"], undefined)).toEqual(["read"]);
  });
  it("refuses to grant what the caller does not hold", () => {
    const r = mintableScopes(["read", "search"], ["read", "delete"]);
    expect(r).toEqual({ error: expect.stringMatching(/cannot grant.*delete/) });
  });
  it("accepts a subset and dedupes", () => {
    expect(mintableScopes(["read", "write"], ["write", "write"])).toEqual(["write"]);
  });
  it("rejects unknown scopes and empty sets", () => {
    expect(mintableScopes(["read"], ["admin"])).toHaveProperty("error");
    expect(mintableScopes(["read"], [])).toHaveProperty("error");
  });
});

// ── #2: POST /api/keys gate ──────────────────────────────────────────────

function keysApp(auth: AuthContext, db: D1Database) {
  const app = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/api/keys", keys);
  return { app, env: envWith(db) };
}

const base: AuthContext = {
  organizationId: "org_1",
  apiKeyId: "key_caller",
  tier: "pro",
  scopes: ["read", "write", "search", "delete"] as Scope[],
  seatId: null,
};

describe("POST /api/keys", () => {
  it("rejects an OAuth connector outright", async () => {
    const { db } = stubDb({});
    const { app, env } = keysApp({ ...base, apiKeyId: "oauth:client_x", scopes: ["read", "write"] as Scope[] }, db);
    const res = await app.request("/api/keys", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(403);
  });

  it("rejects a read-only key", async () => {
    const { db } = stubDb({});
    const { app, env } = keysApp({ ...base, scopes: ["read", "search"] as Scope[] }, db);
    const res = await app.request("/api/keys", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(403);
  });

  it("never mints beyond the caller, and audits the mint", async () => {
    const { db, writes } = stubDb({});
    const { app, env } = keysApp({ ...base, scopes: ["read", "write"] as Scope[] }, db);
    const res = await app.request(
      "/api/keys",
      { method: "POST", body: JSON.stringify({ scopes: ["read", "write", "delete"] }) },
      env,
    );
    expect(res.status).toBe(400);
    const ok = await app.request("/api/keys", { method: "POST", body: "{}" }, env);
    expect(ok.status).toBe(201);
    const body = (await ok.json()) as { scopes: string[] };
    expect(body.scopes.sort()).toEqual(["read", "write"]);
    expect(writes.some((w) => /INSERT INTO audit_log/i.test(w))).toBe(true);
  });

  it("gates and audits revocation the same way", async () => {
    const { db, writes } = stubDb({});
    const ro = keysApp({ ...base, scopes: ["read"] as Scope[] }, db);
    expect((await ro.app.request("/api/keys/key_other", { method: "DELETE" }, ro.env)).status).toBe(403);
    const rw = keysApp(base, db);
    expect((await rw.app.request("/api/keys/key_other", { method: "DELETE" }, rw.env)).status).toBe(200);
    expect(writes.some((w) => /INSERT INTO audit_log/i.test(w))).toBe(true);
  });
});

// ── #3: /signup/link + /set-password honor revocation ────────────────────

function signupApp(db: D1Database) {
  const app = new Hono<{ Bindings: Env }>();
  app.route("/signup", signup);
  return { app, env: envWith(db) };
}

describe("/signup/link", () => {
  const hdr = { Authorization: "Bearer engram_sk_live_" + "x".repeat(32), "Content-Type": "application/json" };

  it("rejects a REVOKED key even though the raw lookup would have found it", async () => {
    // keyWithOrg null = revoked/expired; the raw query still returns org_LEAK.
    const { db, writes } = stubDb({ keyWithOrg: null });
    const { app, env } = signupApp(db);
    const res = await app.request("/signup/link", { method: "POST", headers: hdr, body: JSON.stringify({ email: "a@b.com" }) }, env);
    expect(res.status).toBe(401);
    expect(writes.some((w) => /UPDATE organizations SET email/i.test(w))).toBe(false);
  });

  it("rejects a read-only key", async () => {
    const { db } = stubDb({ keyWithOrg: { key_id: "k1", organization_id: "org_1", scopes: "read", seat_id: null, tier: "free" } });
    const { app, env } = signupApp(db);
    const res = await app.request("/signup/link", { method: "POST", headers: hdr, body: JSON.stringify({ email: "a@b.com" }) }, env);
    expect(res.status).toBe(403);
  });

  it("links with a live write key and audits old → new", async () => {
    const { db, writes } = stubDb({
      keyWithOrg: { key_id: "k1", organization_id: "org_1", scopes: "read,write", seat_id: null, tier: "free" },
      orgByEmail: null,
      orgById: { email: "old@b.com" },
    });
    const { app, env } = signupApp(db);
    const res = await app.request("/signup/link", { method: "POST", headers: hdr, body: JSON.stringify({ email: "new@b.com" }) }, env);
    expect(res.status).toBe(200);
    expect(writes.some((w) => /UPDATE organizations SET email/i.test(w))).toBe(true);
    expect(writes.some((w) => /INSERT INTO audit_log/i.test(w))).toBe(true);
  });
});

describe("/signup/set-password", () => {
  it("rejects a revoked key", async () => {
    const { db } = stubDb({ keyWithOrg: null });
    const { app, env } = signupApp(db);
    const res = await app.request(
      "/signup/set-password",
      { method: "POST", headers: { Authorization: "Bearer engram_sk_live_" + "x".repeat(32), "Content-Type": "application/json" }, body: JSON.stringify({ password: "hunter2hunter2" }) },
      env,
    );
    expect(res.status).toBe(401);
  });
});

// ── #1: a new identity may not claim an org that holds data ──────────────

describe("requiresClaim", () => {
  it("is true only when the org holds memories", () => {
    expect(requiresClaim({ messages_stored_total: 383 })).toBe(true);
    expect(requiresClaim({ messages_stored_total: 0 })).toBe(false);
    expect(requiresClaim({})).toBe(false);
  });
});

describe("POST /signup bind-by-email", () => {
  async function post(db: D1Database, email: string) {
    const { app, env } = signupApp(db);
    const token = await signJwt({ sub: "user_new", email, role: "authenticated", exp: nowSec() + 600 });
    return app.request("/signup", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" }, env);
  }

  it("refuses to bind a fresh identity to an existing org WITH data, and mints no key", async () => {
    const { db, writes } = stubDb({ orgByEmail: { id: "org_victim", messages_stored_total: 716 } });
    const res = await post(db, "victim@example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "claim_required" });
    expect(writes.some((w) => /INSERT INTO api_keys/i.test(w))).toBe(false);
    expect(writes.some((w) => /INSERT INTO audit_log/i.test(w))).toBe(true);
  });

  it("still binds an existing EMPTY org — nothing to steal, no friction", async () => {
    const { db, writes } = stubDb({ orgByEmail: { id: "org_empty", messages_stored_total: 0 } });
    const res = await post(db, "new@example.com");
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toMatchObject({ organization_id: "org_empty", created: false });
    expect(writes.some((w) => /INSERT INTO api_keys/i.test(w))).toBe(true);
  });

  it("creates a fresh org for a brand-new email — zero friction unchanged", async () => {
    const { db } = stubDb({ orgByEmail: null });
    const res = await post(db, "brandnew@example.com");
    expect(res.status).toBe(201);
    expect((await res.json()) as object).toMatchObject({ created: true });
  });
});

// ── JWT: exp is mandatory ────────────────────────────────────────────────

describe("verifySupabaseJwt", () => {
  it("rejects a token with no exp instead of trusting it forever", async () => {
    const t = await signJwt({ sub: "u", email: "a@b.com", role: "authenticated" });
    await expect(verifySupabaseJwt(t, SECRET)).rejects.toThrow(/no exp/);
  });
  it("still accepts a normal token", async () => {
    const t = await signJwt({ sub: "u", email: "a@b.com", role: "authenticated", exp: nowSec() + 60 });
    await expect(verifySupabaseJwt(t, SECRET)).resolves.toMatchObject({ sub: "u" });
  });
});
