import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { insertApiKey } from "@getengram/db";
import app from "../index.js";
import { keys } from "../routes/keys.js";
import { privacy } from "../routes/privacy.js";
import { billing } from "../routes/billing.js";
import { admin } from "../routes/admin.js";
import { registerManageSubscription } from "../mcp/tools/manage-subscription.js";
import { timingSafeEqual } from "../middleware/auth.js";
import { isSeatMember } from "../mcp/auth-kind.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Owner RBAC floor (engram#441) + per-key admin revoke and constant-time
 * admin guard (engram#506).
 *
 * The escalation this pins shut: a Team member's seat key could POST
 * /api/keys and receive a key with seat_id NULL — which is what an OWNER key
 * looks like to the auth join. One call turned a member into the owner, with
 * billing, privacy policy and every other member's keys in reach.
 */

type Vars = { Bindings: Env; Variables: { auth: AuthContext } };

const OWNER: AuthContext = {
  organizationId: "org_test",
  apiKeyId: "key_owner",
  tier: "team",
  scopes: ["read", "write", "search", "delete"],
  seatId: null,
};
const MEMBER: AuthContext = { ...OWNER, apiKeyId: "key_member", seatId: "seat_member" };
const CONNECTOR: AuthContext = { ...OWNER, apiKeyId: "oauth:client_chatgpt" };
const READ_ONLY_OWNER: AuthContext = { ...OWNER, apiKeyId: "key_ro", scopes: ["read", "search"] };

function appAs(auth: AuthContext, mount: (a: Hono<Vars>) => void) {
  const a = new Hono<Vars>();
  a.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  mount(a);
  return a;
}

function world() {
  const db = createMockD1();
  const env = createMockEnv(db) as unknown as Env;
  return { db, env };
}

const json = (body: unknown) => ({
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function keyRow(db: D1Database, id: string) {
  return db
    .prepare("SELECT id, seat_id, revoked_at FROM api_keys WHERE id = ? AND organization_id = ?")
    .bind(id, "org_test")
    .first<{ id: string; seat_id: string | null }>();
}

// ── isSeatMember ──────────────────────────────────────────────────────────

describe("isSeatMember", () => {
  it("is the owner floor: null, undefined and empty seat are all 'owner'", () => {
    expect(isSeatMember(OWNER)).toBe(false);
    expect(isSeatMember({ ...OWNER, seatId: undefined })).toBe(false);
    expect(isSeatMember({ ...OWNER, seatId: "" })).toBe(false);
    expect(isSeatMember(CONNECTOR)).toBe(false);
    expect(isSeatMember(MEMBER)).toBe(true);
  });
});

// ── keys: seat-bound minting ──────────────────────────────────────────────

describe("POST /api/keys stamps the minter's seat (the escalation)", () => {
  it("a Team member's key is bound to their seat, never a null-seat owner key", async () => {
    const { db, env } = world();
    const a = appAs(MEMBER, (x) => x.route("/api/keys", keys));
    const res = await a.request("/api/keys", { method: "POST", ...json({ name: "laptop" }) }, env);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const row = await keyRow(db, id);
    expect(row?.seat_id).toBe("seat_member");
  });

  it("the owner's key carries no seat", async () => {
    const { db, env } = world();
    const a = appAs(OWNER, (x) => x.route("/api/keys", keys));
    const res = await a.request("/api/keys", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect((await keyRow(db, id))?.seat_id).toBeNull();
  });
});

describe("GET /api/keys is seat-filtered", () => {
  it("a member lists only their own keys; the owner sees every key", async () => {
    const { db, env } = world();
    await insertApiKey(db, "key_o1", "org_test", "h1", "eng_o1", "owner laptop", "read,write", null);
    await insertApiKey(db, "key_m1", "org_test", "h2", "eng_m1", "member laptop", "read,write", "seat_member");
    await insertApiKey(db, "key_x1", "org_test", "h3", "eng_x1", "other member", "read,write", "seat_other");

    const member = appAs(MEMBER, (x) => x.route("/api/keys", keys));
    const mine = (await (await member.request("/api/keys", {}, env)).json()) as { keys: Array<{ id: string }> };
    expect(mine.keys.map((k) => k.id)).toEqual(["key_m1"]);

    const owner = appAs(OWNER, (x) => x.route("/api/keys", keys));
    const all = (await (await owner.request("/api/keys", {}, env)).json()) as { keys: Array<{ id: string }> };
    expect(all.keys.map((k) => k.id).sort()).toEqual(["key_m1", "key_o1", "key_x1"]);
  });
});

describe("DELETE /api/keys/:id honours seat ownership", () => {
  async function seeded() {
    const { db, env } = world();
    await insertApiKey(db, "key_o1", "org_test", "h1", "eng_o1", "owner laptop", "read,write", null);
    await insertApiKey(db, "key_m1", "org_test", "h2", "eng_m1", "member laptop", "read,write", "seat_member");
    await insertApiKey(db, "key_x1", "org_test", "h3", "eng_x1", "other member", "read,write", "seat_other");
    return { db, env };
  }

  it("a member cannot revoke the owner's key, another member's key, or probe unknown ids", async () => {
    const { env } = await seeded();
    const a = appAs(MEMBER, (x) => x.route("/api/keys", keys));
    for (const id of ["key_o1", "key_x1", "key_does_not_exist"]) {
      const res = await a.request(`/api/keys/${id}`, { method: "DELETE" }, env);
      expect(res.status, id).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    }
  });

  it("a member can revoke their own key", async () => {
    const { env } = await seeded();
    const a = appAs(MEMBER, (x) => x.route("/api/keys", keys));
    const res = await a.request("/api/keys/key_m1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
  });

  it("the owner can revoke any member's key", async () => {
    const { env } = await seeded();
    const a = appAs(OWNER, (x) => x.route("/api/keys", keys));
    expect((await a.request("/api/keys/key_x1", { method: "DELETE" }, env)).status).toBe(200);
  });
});

// ── privacy: owner + first-party + write ──────────────────────────────────

describe("PATCH /api/privacy", () => {
  const patch = { method: "PATCH", ...json({ assistant_can_read_bodies: false }) };

  it("refuses a Team member (403 forbidden)", async () => {
    const { env } = world();
    const res = await appAs(MEMBER, (x) => x.route("/api/privacy", privacy)).request("/api/privacy", patch, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("refuses an OAuth connector — the policy restricting it is not its to relax", async () => {
    const { env } = world();
    const res = await appAs(CONNECTOR, (x) => x.route("/api/privacy", privacy)).request("/api/privacy", patch, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("refuses a read-only owner key (403 insufficient_scope)", async () => {
    const { env } = world();
    const res = await appAs(READ_ONLY_OWNER, (x) => x.route("/api/privacy", privacy)).request("/api/privacy", patch, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("insufficient_scope");
  });

  it("the owner can still change it, and a member can still read it", async () => {
    const { env } = world();
    const ok = await appAs(OWNER, (x) => x.route("/api/privacy", privacy)).request("/api/privacy", patch, env);
    expect(ok.status).toBe(200);
    expect((await ok.json()) as object).toMatchObject({ updated: true, assistant_can_read_bodies: false });

    const read = await appAs(MEMBER, (x) => x.route("/api/privacy", privacy)).request("/api/privacy", {}, env);
    expect(read.status).toBe(200);
  });
});

// ── billing: owner only ───────────────────────────────────────────────────

describe("billing is owner-only", () => {
  // The mock env has no Stripe key: if the gate did not run FIRST the handler
  // would reach Stripe and fail some other way, so a clean 403 is also proof
  // of ordering.
  it.each([["/api/billing/checkout"], ["/api/billing/portal"]])("refuses a Team member on POST %s", async (path) => {
    const { env } = world();
    const res = await appAs(MEMBER, (x) => x.route("/api/billing", billing)).request(path, { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
  });

  it("the owner gets past the gate (portal with no Stripe customer → 400 no_subscription)", async () => {
    const { env } = world();
    const res = await appAs(OWNER, (x) => x.route("/api/billing", billing)).request("/api/billing/portal", { method: "POST", body: "{}" }, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("no_subscription");
  });
});

describe("manage_subscription tool", () => {
  type Handler = (params: Record<string, unknown>) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  function toolFor(auth: AuthContext, env: Env): Handler {
    let handler: Handler | undefined;
    const server = {
      tool: (_name: string, _desc: string, ..._rest: unknown[]) => {
        handler = _rest[_rest.length - 1] as Handler;
      },
    } as unknown as McpServer;
    registerManageSubscription(server, env, auth);
    if (!handler) throw new Error("tool not registered");
    return handler;
  }

  it("a Team member can see status but not open the portal or checkout", async () => {
    const { db, env } = world();
    await db.exec(
      "INSERT INTO organizations (id, name, tier, email, stripe_customer_id) VALUES ('org_test', 'T', 'team', 'o@example.com', 'cus_1')",
    );
    const tool = toolFor(MEMBER, env);

    const status = await tool({ action: "status" });
    expect(status.isError).toBeFalsy();
    expect(JSON.parse(status.content[0].text)).toMatchObject({ tier: "team" });

    for (const action of ["portal", "upgrade"]) {
      const res = await tool({ action });
      expect(res.isError, action).toBe(true);
      expect(JSON.parse(res.content[0].text)).toMatchObject({ error: "forbidden" });
    }
  });
});

// ── admin: per-key revoke ─────────────────────────────────────────────────

describe("admin per-key revoke (engram#506)", () => {
  function adminApp() {
    const a = new Hono<{ Bindings: Env }>();
    a.route("/admin", admin);
    return a;
  }

  async function seeded() {
    const { db, env } = world();
    await insertApiKey(db, "key_leaked", "org_a", "hash-a", "eng_leak", "Default", "read,write", null);
    await insertApiKey(db, "key_fine", "org_a", "hash-b", "eng_fine", "laptop", "read", "seat_1");
    return { db, env };
  }

  it("lists an org's keys without ever selecting the hash", async () => {
    const { db, env } = await seeded();
    const seen: string[] = [];
    const orig = db.prepare.bind(db);
    (db as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      seen.push(sql);
      return orig(sql);
    };
    const res = await adminApp().request("/admin/users/org_a/keys", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: Array<{ id: string }>; count: number };
    expect(body.count).toBe(2);
    expect(body.keys.map((k) => k.id).sort()).toEqual(["key_fine", "key_leaked"]);
    const selects = seen.filter((s) => /FROM api_keys/i.test(s));
    expect(selects.length).toBeGreaterThan(0);
    for (const s of selects) expect(s).not.toMatch(/key_hash/i);
  });

  it("revokes exactly one key and audits it on the org", async () => {
    const { env } = await seeded();
    const a = adminApp();
    const res = await a.request("/admin/users/org_a/keys/key_leaked", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ revoked: true, id: "key_leaked", already_revoked: false });

    const audit = (await (await a.request("/admin/audit/org_a", {}, env)).json()) as {
      logs: Array<{ action: string; api_key_id: string; resource_id: string }>;
    };
    expect(audit.logs).toHaveLength(1);
    expect(audit.logs[0]).toMatchObject({ action: "admin.key.revoke", api_key_id: "admin", resource_id: "key_leaked" });
  });

  it("404s for a key id that belongs to a different org, and writes no audit row there", async () => {
    const { env } = await seeded();
    const a = adminApp();
    const res = await a.request("/admin/users/org_b/keys/key_leaked", { method: "DELETE" }, env);
    expect(res.status).toBe(404);
    const audit = (await (await a.request("/admin/audit/org_b", {}, env)).json()) as { logs: unknown[] };
    expect(audit.logs).toHaveLength(0);
  });
});

// ── admin guard: constant-time secret compare ─────────────────────────────

describe("timingSafeEqual", () => {
  it("compares whole strings, including length", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("ab", "abc")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("/admin/* guard", () => {
  const SECRET = "s3cret-admin-value";
  function envWithSecret(secret: string | undefined) {
    return { ...createMockEnv(createMockD1()), ADMIN_SECRET: secret } as unknown as Env;
  }
  function hit(authz: string | undefined, secret: string | undefined = SECRET) {
    return app.fetch(
      new Request("https://mcp.getengram.app/admin/audit/org_x", {
        headers: authz ? { Authorization: authz } : {},
      }),
      envWithSecret(secret),
    );
  }

  it("admits exactly the configured secret", async () => {
    expect((await hit(`Bearer ${SECRET}`)).status).toBe(200);
  });

  it("rejects prefixes, extensions, other values, a bare token, and a missing header", async () => {
    for (const authz of [
      `Bearer ${SECRET.slice(0, -1)}`,
      `Bearer ${SECRET}x`,
      "Bearer nope",
      SECRET,
      "Basic abc",
      undefined,
    ]) {
      expect((await hit(authz)).status, String(authz)).toBe(401);
    }
  });

  it("rejects everything when no ADMIN_SECRET is configured", async () => {
    expect((await hit("Bearer ", undefined)).status).toBe(401);
    expect((await hit(`Bearer ${SECRET}`, "")).status).toBe(401);
  });
});
