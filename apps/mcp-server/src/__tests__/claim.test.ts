import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { signup } from "../routes/signup.js";
import type { Env } from "../types.js";

/**
 * Identity pin + self-service claim (migration 0040; follow-up to #476).
 *
 * Two behaviours matter and both are pinned here against a stub D1 that
 * answers by SQL shape:
 *  1. /signup connects an org's OWN Supabase user (present in org_identities)
 *     with no gate — the Oct 2026 false positives were exactly this case.
 *  2. For an unknown sub on an org with data, /signup mails a one-time link
 *     (hash-only storage, cooldown, daily cap) and /signup/claim redeems it
 *     only for the same sub, same email, unconsumed, unexpired, and still
 *     the org that email maps to — and consumes before minting.
 */

interface Rows {
  identity?: Record<string, unknown> | null;
  orgByEmail?: Record<string, unknown> | null;
  cooldown?: Record<string, unknown> | null;
  daily?: number;
  claim?: Record<string, unknown> | null;
  updateChanges?: number;
  /** what the INSERT OR IGNORE into org_claims reports (0 = lost the window race) */
  insertChanges?: number;
  /** what getApiKeyWithOrg's join returns, for API-key-authenticated routes */
  keyWithOrg?: Record<string, unknown> | null;
}

function stubDb(rows: Rows) {
  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        first: async () => {
          if (/FROM api_keys k\s+JOIN organizations/i.test(sql)) return rows.keyWithOrg ?? null;
          if (/FROM org_identities/i.test(sql)) return rows.identity ?? null;
          if (/FROM organizations WHERE email/i.test(sql)) return rows.orgByEmail ?? null;
          if (/FROM organizations WHERE id/i.test(sql)) return rows.orgByEmail ?? null;
          if (/FROM org_claims\s+WHERE organization_id = \? AND sub/i.test(sql)) return rows.cooldown ?? null;
          if (/COUNT\(\*\) AS n FROM org_claims/i.test(sql)) return { n: rows.daily ?? 0 };
          if (/FROM org_claims WHERE token_hash/i.test(sql)) return rows.claim ?? null;
          if (/COUNT\(\*\)/i.test(sql)) return { count: 0 };
          return null;
        },
        run: async () => {
          writes.push({ sql, args });
          const changes = /UPDATE org_claims/i.test(sql)
            ? (rows.updateChanges ?? 1)
            : /INSERT OR IGNORE INTO org_claims/i.test(sql)
              ? (rows.insertChanges ?? 1)
              : 1;
          return { success: true, meta: { changes } };
        },
        all: async () => ({ results: [] }),
        __sql: sql,
        __args: () => args,
      };
      return stmt;
    },
    // clearOAuthTokensByOrg goes through batch(); record those too.
    batch: async (stmts: Array<{ __sql: string; __args: () => unknown[] }>) => {
      for (const st of stmts) writes.push({ sql: st.__sql, args: st.__args() });
      return [];
    },
  } as unknown as D1Database;
  return { db, writes };
}

const SECRET = "test-jwt-secret-claim";
const APP_URL = "https://getengram.app";
const ADMIN_SECRET = "admin-secret-test";

function envWith(db: D1Database): Env {
  return {
    DB: db,
    SUPABASE_JWT_SECRET: SECRET,
    SUPABASE_URL: "https://example.supabase.co",
    APP_URL,
    ADMIN_SECRET,
  } as unknown as Env;
}

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

const EMAIL = "herman@example.com";
const SUB = "sub_herman";
const ORG = { id: "org_h", email: EMAIL, messages_stored_total: 424 };

function app(db: D1Database) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/signup", signup);
  return { app: a, env: envWith(db) };
}

async function post(path: string, db: D1Database, sub: string | null, body: unknown = {}) {
  const { app: a, env } = app(db);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub) {
    headers.authorization = `Bearer ${await signJwt({ sub, email: EMAIL, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}`;
  }
  return a.request(path, { method: "POST", headers, body: JSON.stringify(body) }, env);
}

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const has = (writes: Array<{ sql: string }>, re: RegExp) => writes.some((w) => re.test(w.sql));

// ── /signup: identity pin decides whether the gate fires ─────────────────

describe("POST /signup with an existing org that holds data", () => {
  it("connects the org's own Supabase user with no gate and no email", async () => {
    const { db, writes } = stubDb({ identity: { present: 1 }, orgByEmail: ORG });
    const res = await post("/signup", db, SUB);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { organization_id: string; api_key: string; created: boolean };
    expect(body.organization_id).toBe("org_h");
    expect(body.api_key).toMatch(/^engram_sk_live_/);
    expect(body.created).toBe(false);
    expect(has(writes, /INSERT INTO api_keys/i)).toBe(true);
    expect(has(writes, /INSERT INTO org_identities/i)).toBe(true);
    expect(has(writes, /INSERT INTO org_claims/i)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gates an unknown sub: no key, a hashed claim row, and the link email", async () => {
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG });
    const res = await post("/signup", db, "sub_stranger");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; claim: Record<string, unknown> };
    expect(body.error).toBe("claim_required");
    expect(body.claim).toMatchObject({ email: EMAIL, sent: true, reason: "sent", expires_minutes: 30 });

    expect(has(writes, /INSERT INTO api_keys/i)).toBe(false);
    const ins = writes.find((w) => /INSERT OR IGNORE INTO org_claims/i.test(w.sql))!;
    expect(ins).toBeTruthy();
    // args: id, org, sub, email, token_hash, ttl — the hash is sha256 hex, never the token
    expect(ins.args[1]).toBe("org_h");
    expect(ins.args[2]).toBe("sub_stranger");
    expect(ins.args[4]).toMatch(/^[0-9a-f]{64}$/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${APP_URL}/api/email/claim-link`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ADMIN_SECRET}`);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.to).toBe(EMAIL);
    expect(sent.claim_url).toMatch(new RegExp(`^${APP_URL}/claim\\?token=[A-Za-z0-9_-]{40,}$`));
    expect(sent.expires_minutes).toBe(30);
    expect(sent.messages).toBe(424);
    // the mailed token must never be what is stored
    const tokenInMail = (sent.claim_url as string).split("token=")[1];
    expect(ins.args[4]).not.toBe(tokenInMail);

    // exactly one audit row — per send, not per gate hit
    expect(writes.filter((w) => /INSERT INTO audit_log/i.test(w.sql)).length).toBe(1);
    expect(has(writes, /DELETE FROM org_claims/i)).toBe(false);
  });

  it("records the identity BEFORE minting when the org's own user connects", async () => {
    const { db, writes } = stubDb({ identity: { present: 1 }, orgByEmail: ORG });
    await post("/signup", db, SUB);
    const order = writes.map((w) => w.sql);
    const iIdent = order.findIndex((s) => /INSERT INTO org_identities/i.test(s));
    const iMint = order.findIndex((s) => /INSERT INTO api_keys/i.test(s));
    expect(iIdent).toBeGreaterThanOrEqual(0);
    expect(iMint).toBeGreaterThan(iIdent);
  });

  it("collapses a parallel burst: losing the send-window race reports cooldown and sends nothing", async () => {
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG, insertChanges: 0 });
    const res = await post("/signup", db, "sub_stranger");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { claim: { reason: string; sent: boolean } };
    expect(body.claim).toMatchObject({ reason: "cooldown", sent: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(has(writes, /INSERT INTO audit_log/i)).toBe(false);
  });

  it("does not gate an unknown sub on an EMPTY org (nothing to take over)", async () => {
    const { db, writes } = stubDb({ identity: null, orgByEmail: { ...ORG, messages_stored_total: 0 } });
    const res = await post("/signup", db, "sub_new_surface");
    expect(res.status).toBe(200);
    expect(has(writes, /INSERT INTO org_identities/i)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours the resend cooldown: no new row, no new email", async () => {
    const created = new Date(Date.now() - 30_000).toISOString().replace("T", " ").slice(0, 19);
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG, cooldown: { created_at: created } });
    const res = await post("/signup", db, "sub_stranger");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { claim: { reason: string; retry_after_seconds: number } };
    expect(body.claim.reason).toBe("cooldown");
    expect(body.claim.retry_after_seconds).toBeGreaterThan(0);
    expect(body.claim.retry_after_seconds).toBeLessThanOrEqual(120);
    expect(has(writes, /INSERT OR IGNORE INTO org_claims/i)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(has(writes, /INSERT INTO audit_log/i)).toBe(false);
  });

  it("caps sends per org per day", async () => {
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG, daily: 5 });
    const res = await post("/signup", db, "sub_stranger");
    const body = (await res.json()) as { claim: { reason: string; sent: boolean } };
    expect(body.claim).toMatchObject({ reason: "rate_limited", sent: false });
    expect(has(writes, /INSERT OR IGNORE INTO org_claims/i)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports delivery failure honestly and removes the undeliverable row", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG });
    const res = await post("/signup", db, "sub_stranger");
    const body = (await res.json()) as { claim: { reason: string; sent: boolean } };
    expect(body.claim).toMatchObject({ reason: "delivery_failed", sent: false });
    const ins = writes.find((w) => /INSERT OR IGNORE INTO org_claims/i.test(w.sql))!;
    const del = writes.find((w) => /DELETE FROM org_claims WHERE id/i.test(w.sql))!;
    expect(del).toBeTruthy();
    expect(del.args[0]).toBe(ins.args[0]); // the same row it just inserted
  });

  it("the message tells the truth per outcome", async () => {
    const { db } = stubDb({ identity: null, orgByEmail: ORG, daily: 5 });
    const body = (await (await post("/signup", db, "sub_stranger")).json()) as { message: string };
    expect(body.message).toMatch(/Too many connection links/);
    expect(body.message).not.toMatch(/open the link we just emailed/);
  });
});

// ── /signup/login: the CLI gets the same rule ────────────────────────────

describe("POST /signup/login", () => {
  function supabaseAnswers(user: unknown) {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/auth/v1/token")
        ? new Response(JSON.stringify({ access_token: "x", user }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
  }
  const loginEnv = (db: D1Database) =>
    ({ ...envWith(db), SUPABASE_ANON_KEY: "anon" }) as unknown as Env;
  async function login(db: D1Database) {
    const { app: a } = app(db);
    return a.request(
      "/signup/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: "pw" }) },
      loginEnv(db),
    );
  }

  it("gates an unknown sub on an org with data instead of minting a key", async () => {
    supabaseAnswers({ id: "sub_stranger" });
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG });
    const res = await login(db);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("claim_required");
    expect(body.message).toMatch(/engram login/);
    expect(has(writes, /INSERT INTO api_keys/i)).toBe(false);
  });

  it("lets the org's own user in and records the identity before the key", async () => {
    supabaseAnswers({ id: SUB });
    const { db, writes } = stubDb({ identity: { present: 1 }, orgByEmail: ORG });
    const res = await login(db);
    expect(res.status).toBe(200);
    const order = writes.map((w) => w.sql);
    expect(order.findIndex((s) => /INSERT INTO org_identities/i.test(s))).toBeLessThan(
      order.findIndex((s) => /INSERT INTO api_keys/i.test(s)),
    );
    const ident = writes.find((w) => /INSERT INTO org_identities/i.test(w.sql))!;
    expect(ident.args[3]).toBe("cli-login");
  });

  it("fails closed when the identity provider returns no user id", async () => {
    supabaseAnswers(undefined);
    const { db, writes } = stubDb({ identity: null, orgByEmail: ORG });
    const res = await login(db);
    expect(res.status).toBe(502);
    expect(has(writes, /INSERT INTO api_keys/i)).toBe(false);
  });
});

// ── /signup/set-password: the moment a CLI-born org gets a Supabase user ──

describe("POST /signup/set-password", () => {
  it("records the newly created Supabase user on the org", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/auth/v1/signup")
        ? new Response(JSON.stringify({ user: { id: "sub_cli", identities: [{}] }, session: {} }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    const { db, writes } = stubDb({
      keyWithOrg: { key_id: "key_1", organization_id: "org_h", scopes: "read,write,search,delete", seat_id: null, tier: "free" },
      orgByEmail: ORG,
    });
    const { app: a } = app(db);
    const res = await a.request(
      "/signup/set-password",
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer engram_sk_live_abc" },
        body: JSON.stringify({ password: "longenough" }),
      },
      { ...envWith(db), SUPABASE_ANON_KEY: "anon" } as unknown as Env,
    );
    expect(res.status).toBe(200);
    const ident = writes.find((w) => /INSERT INTO org_identities/i.test(w.sql))!;
    expect(ident.args).toEqual(["org_h", "sub_cli", EMAIL, "set-password"]);
  });
});

// ── /signup/claim: redemption ────────────────────────────────────────────

const CLAIM_ROW = {
  id: "clm_1",
  organization_id: "org_h",
  sub: SUB,
  email: EMAIL,
  consumed_at: null,
  expired: 0,
};

describe("POST /signup/claim", () => {
  it("redeems a valid link for the same user: consumes, mints, records identity, audits", async () => {
    const { db, writes } = stubDb({ orgByEmail: ORG, claim: CLAIM_ROW });
    const res = await post("/signup/claim", db, SUB, { token: "tok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ organization_id: "org_h", created: false, claimed: true });
    expect(body.api_key).toMatch(/^engram_sk_live_/);

    const order = writes.map((w) => w.sql);
    const iConsume = order.findIndex((s) => /UPDATE org_claims SET consumed_at/i.test(s));
    const iIdent = order.findIndex((s) => /INSERT INTO org_identities/i.test(s));
    const iMint = order.findIndex((s) => /INSERT INTO api_keys/i.test(s));
    expect(iConsume).toBeGreaterThanOrEqual(0);
    expect(iIdent).toBeGreaterThan(iConsume); // consume, then identity, then mint
    expect(iMint).toBeGreaterThan(iIdent);
    const ident = writes.find((w) => /INSERT INTO org_identities/i.test(w.sql))!;
    expect(ident.args).toEqual(["org_h", SUB, EMAIL, "claim"]);
    expect(has(writes, /INSERT INTO audit_log/i)).toBe(true);
  });

  it("cuts every credential that predates the claim — owner keys and connector tokens, not seat keys", async () => {
    const { db, writes } = stubDb({ orgByEmail: ORG, claim: CLAIM_ROW });
    const res = await post("/signup/claim", db, SUB, { token: "tok" });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toHaveProperty("revoked_keys", 1);

    const mint = writes.find((w) => /INSERT INTO api_keys/i.test(w.sql))!;
    const newKeyId = mint.args[0];
    const revoke = writes.find((w) => /UPDATE api_keys SET revoked_at/i.test(w.sql))!;
    expect(revoke.sql).toMatch(/seat_id IS NULL/);
    expect(revoke.sql).toMatch(/id != \?/);
    expect(revoke.args).toEqual(["org_h", newKeyId]); // the key just minted survives
    expect(has(writes, /DELETE FROM oauth_access_tokens WHERE organization_id/i)).toBe(true);
    expect(has(writes, /UPDATE oauth_refresh_tokens SET revoked_at/i)).toBe(true);
    // the revocation happens AFTER the new key exists, never before
    const order = writes.map((w) => w.sql);
    expect(order.findIndex((s) => /UPDATE api_keys SET revoked_at/i.test(s))).toBeGreaterThan(
      order.findIndex((s) => /INSERT INTO api_keys/i.test(s)),
    );
  });

  it.each([
    ["unknown token", { claim: null }],
    ["already consumed", { claim: { ...CLAIM_ROW, consumed_at: "2026-10-10 00:00:00" } }],
    ["expired", { claim: { ...CLAIM_ROW, expired: 1 } }],
    ["issued to a different user", { claim: { ...CLAIM_ROW, sub: "sub_other" } }],
    ["issued for a different email", { claim: { ...CLAIM_ROW, email: "else@example.com" } }],
    ["org no longer maps to that email", { claim: CLAIM_ROW, orgByEmail: { ...ORG, id: "org_other" } }],
    ["lost the consume race", { claim: CLAIM_ROW, updateChanges: 0 }],
  ])("refuses identically when %s — and mints nothing", async (_label, rows) => {
    const { db, writes } = stubDb({ orgByEmail: ORG, ...rows });
    const res = await post("/signup/claim", db, SUB, { token: "tok" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
    expect(has(writes, /INSERT INTO api_keys/i)).toBe(false);
    expect(has(writes, /INSERT INTO org_identities/i)).toBe(false);
  });

  it("requires a Supabase JWT and a token", async () => {
    const { db } = stubDb({ orgByEmail: ORG, claim: CLAIM_ROW });
    expect((await post("/signup/claim", db, null, { token: "tok" })).status).toBe(401);
    expect((await post("/signup/claim", db, SUB, {})).status).toBe(400);
  });
});
