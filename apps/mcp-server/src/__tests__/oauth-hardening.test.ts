/**
 * OAuth hardening regressions (engram#442, #446, #447, #453).
 *
 * Each test states the attack it pins. The mock D1 is sequential, so a true
 * concurrent race cannot be reproduced; the race's observable precondition
 * (a stale read that no longer sees the write) is simulated instead.
 */
import { describe, it, expect } from "vitest";
import app from "../index.js";
import { consumeAuthorizationCode, claimRefreshGrace } from "@getengram/db";
import { normalizeClientName } from "../oauth/router.js";
import { createOAuthD1, createOAuthEnv, signSupabaseJwt, pkcePair } from "./oauth-helpers.js";

const REDIRECT = "https://chatgpt.com/connector/callback";

type Env = ReturnType<typeof createOAuthEnv>;
type Tables = Record<string, Array<Record<string, unknown>>>;
const tablesOf = (db: D1Database) => (db as unknown as { _tables: Tables })._tables;

function form(fields: Record<string, string>): Request {
  return new Request("http://mcp.test/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
}

function registerReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://mcp.test/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function registerClient(env: Env, name: unknown = "ChatGPT"): Promise<string> {
  const res = await app.fetch(registerReq({ client_name: name, redirect_uris: [REDIRECT] }), env);
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function getAuthCode(env: Env, clientId: string, challenge: string): Promise<string> {
  const approve = await app.fetch(
    new Request("http://mcp.test/oauth/authorize/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        supabase_token: await signSupabaseJwt("alice@example.com"),
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        scope: "engram:read engram:write",
        state: "xyz",
        approved: true,
      }),
    }),
    env,
  );
  expect(approve.status).toBe(200);
  const { redirect } = (await approve.json()) as { redirect: string };
  return new URL(redirect).searchParams.get("code") as string;
}

interface Pair {
  access_token: string;
  refresh_token: string;
}

/** register → authorize → exchange; returns the first token pair. */
async function connect(env: Env): Promise<{ clientId: string; pair: Pair }> {
  const clientId = await registerClient(env);
  const { verifier, challenge } = await pkcePair();
  const code = await getAuthCode(env, clientId, challenge);
  const res = await app.fetch(
    form({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }),
    env,
  );
  expect(res.status).toBe(200);
  return { clientId, pair: (await res.json()) as Pair };
}

const refresh = (env: Env, clientId: string, token: string) =>
  app.fetch(form({ grant_type: "refresh_token", client_id: clientId, refresh_token: token }), env);

/** Status of /mcp with a bearer: 401 means the token no longer authenticates. */
async function mcpStatus(env: Env, token: string): Promise<number> {
  const res = await app.fetch(
    new Request("http://mcp.test/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    env,
  );
  return res.status;
}

/** Push every rotation in the table an hour into the past. */
async function ageRotations(db: D1Database): Promise<void> {
  const anHourAgo = new Date(Date.now() - 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  await db
    .prepare("UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE rotated_to IS NOT NULL")
    .bind(anHourAgo)
    .run();
}

// ---------------------------------------------------------------------------
// #453 — authorization-code redemption is atomic
// ---------------------------------------------------------------------------
describe("authorization code: conditional consume (#453)", () => {
  it("consumeAuthorizationCode changes one row the first time and none after", async () => {
    const db = createOAuthD1();
    await db
      .prepare(
        "INSERT INTO oauth_authorization_codes (code_hash, client_id, organization_id, redirect_uri, code_challenge, code_challenge_method, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind("h1", "c1", "org", REDIRECT, "chal", "S256", "engram:read", "2999-01-01 00:00:00")
      .run();
    expect((await consumeAuthorizationCode(db, "h1")).meta.changes).toBe(1);
    expect((await consumeAuthorizationCode(db, "h1")).meta.changes).toBe(0);
    expect((await consumeAuthorizationCode(db, "never-issued")).meta.changes).toBe(0);
  });

  it("a stale read cannot double-spend a code: the UPDATE is the lock", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const clientId = await registerClient(env);
    const { verifier, challenge } = await pkcePair();
    const code = await getAuthCode(env, clientId, challenge);

    // Simulate the race's precondition: the second request's SELECT ran
    // before the first request's UPDATE landed, so it still sees the code as
    // unconsumed. Strip the predicate from the read; the write keeps it.
    const realPrepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) =>
      realPrepare(
        /SELECT[\s\S]*FROM oauth_authorization_codes/i.test(sql)
          ? sql.replace(/AND consumed_at IS NULL/i, "")
          : sql,
      );

    const fields = { grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier };
    expect((await app.fetch(form(fields), env)).status).toBe(200);

    const second = await app.fetch(form(fields), env);
    expect(second.status).toBe(400);
    expect(((await second.json()) as { error: string }).error).toBe("invalid_grant");

    // Exactly one token pair exists for this client.
    const t = tablesOf(db);
    expect(t.oauth_access_tokens.filter((r) => r.client_id === clientId)).toHaveLength(1);
    expect(t.oauth_refresh_tokens.filter((r) => r.client_id === clientId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #442 — reuse detection ends the session, not just the refresh chain
// ---------------------------------------------------------------------------
describe("refresh reuse detection revokes access tokens too (#442)", () => {
  it("after a replay outside the grace window every access token of the client is dead", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { clientId, pair: first } = await connect(env);
    // The thief's exchange: rotates RT0 → RT1 and mints AT_evil.
    const evil = (await (await refresh(env, clientId, first.refresh_token)).json()) as Pair;
    expect(await mcpStatus(env, evil.access_token)).not.toBe(401);
    expect(await mcpStatus(env, first.access_token)).not.toBe(401);

    await ageRotations(db);
    // The legitimate client presents RT0 — detection fires.
    const replay = await refresh(env, clientId, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error_description: string }).error_description).toMatch(/reuse/i);

    // Containment is immediate: both access tokens and the successor are dead.
    expect(await mcpStatus(env, evil.access_token)).toBe(401);
    expect(await mcpStatus(env, first.access_token)).toBe(401);
    expect((await refresh(env, clientId, evil.refresh_token)).status).toBe(400);
    expect(tablesOf(db).oauth_access_tokens.filter((r) => r.client_id === clientId)).toHaveLength(0);
  });

  it("does not touch another client's tokens for the same org", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const a = await connect(env);
    const b = await connect(env); // same email → same org, different client
    expect((await refresh(env, a.clientId, a.pair.refresh_token)).status).toBe(200);
    await ageRotations(db);
    expect((await refresh(env, a.clientId, a.pair.refresh_token)).status).toBe(400);

    expect(await mcpStatus(env, b.pair.access_token)).not.toBe(401);
    expect((await refresh(env, b.clientId, b.pair.refresh_token)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// #446 — the grace window is redeemable once
// ---------------------------------------------------------------------------
describe("refresh reuse grace is single-redemption (#446)", () => {
  it("first in-window replay gets a pair, the second is reuse and revokes everything", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { clientId, pair: first } = await connect(env);
    const second = (await (await refresh(env, clientId, first.refresh_token)).json()) as Pair;

    // One dropped response is forgiven.
    const graceRes = await refresh(env, clientId, first.refresh_token);
    expect(graceRes.status).toBe(200);
    const grace = (await graceRes.json()) as Pair;
    expect(grace.refresh_token).not.toBe(second.refresh_token);

    const rows = tablesOf(db).oauth_refresh_tokens.filter((r) => r.client_id === clientId);
    expect(rows.filter((r) => r.grace_used_at != null)).toHaveLength(1);

    // Hammering the same rotated token again is not a dropped response.
    const again = await refresh(env, clientId, first.refresh_token);
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error_description: string }).error_description).toMatch(/reuse/i);

    // And the whole connection is gone: successor, grace chain, access tokens.
    expect((await refresh(env, clientId, second.refresh_token)).status).toBe(400);
    expect((await refresh(env, clientId, grace.refresh_token)).status).toBe(400);
    for (const at of [first.access_token, second.access_token, grace.access_token]) {
      expect(await mcpStatus(env, at)).toBe(401);
    }
  });

  it("a grace-minted chain is capped at one per rotation even across the window", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { clientId, pair: first } = await connect(env);
    await refresh(env, clientId, first.refresh_token);
    expect((await refresh(env, clientId, first.refresh_token)).status).toBe(200);
    // Within the window, a third presentation must not mint another chain.
    expect((await refresh(env, clientId, first.refresh_token)).status).toBe(400);
    const chains = tablesOf(db).oauth_refresh_tokens.filter(
      (r) => r.client_id === clientId && r.rotated_to == null,
    );
    // Every surviving un-rotated token was revoked by the detection.
    expect(chains.every((r) => r.revoked_at != null)).toBe(true);
  });

  it("claimRefreshGrace never succeeds on a token that was revoked without rotation", async () => {
    const db = createOAuthD1();
    await db
      .prepare("INSERT INTO oauth_refresh_tokens (token_hash, client_id, organization_id, scope, expires_at) VALUES (?, ?, ?, ?, ?)")
      .bind("rt_revoked", "c", "org", "engram:read", "2999-01-01 00:00:00")
      .run();
    await db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ?").bind("rt_revoked").run();
    expect((await claimRefreshGrace(db, "rt_revoked")).meta.changes).toBe(0);
  });

  it("a token revoked by the dashboard (not rotated) gets no grace", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const { clientId, pair } = await connect(env);
    await db
      .prepare("UPDATE oauth_refresh_tokens SET revoked_at = datetime('now') WHERE client_id = ?")
      .bind(clientId)
      .run();
    const res = await refresh(env, clientId, pair.refresh_token);
    expect(res.status).toBe(400);
    expect(tablesOf(db).oauth_access_tokens.filter((r) => r.client_id === clientId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #447 — registration is bounded and client_name is display-safe
// ---------------------------------------------------------------------------
describe("dynamic client registration (#447)", () => {
  it("throttles registrations per client IP", async () => {
    const env = createOAuthEnv(createOAuthD1());
    const ip = { "CF-Connecting-IP": "203.0.113.47" };
    for (let i = 0; i < 30; i++) {
      const res = await app.fetch(registerReq({ client_name: `App ${i}`, redirect_uris: [REDIRECT] }, ip), env);
      expect(res.status, `registration #${i + 1}`).toBe(201);
    }
    const blocked = await app.fetch(registerReq({ client_name: "App 31", redirect_uris: [REDIRECT] }, ip), env);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBeTruthy();
    expect(((await blocked.json()) as { error: string }).error).toBe("rate_limited");

    // Another address is unaffected, and so is a non-Cloudflare path (no IP).
    const other = await app.fetch(
      registerReq({ client_name: "Elsewhere", redirect_uris: [REDIRECT] }, { "CF-Connecting-IP": "198.51.100.8" }),
      env,
    );
    expect(other.status).toBe(201);
    expect((await app.fetch(registerReq({ client_name: "Dev", redirect_uris: [REDIRECT] }), env)).status).toBe(201);
  });

  it("normalizeClientName strips invisible characters, collapses whitespace, caps length", () => {
    expect(normalizeClientName("  Chat​GPT‮ \t ")).toBe("ChatGPT");
    expect(normalizeClientName("Claude\n\n   Desktop")).toBe("Claude Desktop");
    expect(normalizeClientName("​​   ")).toBeNull();
    expect(normalizeClientName("")).toBeNull();
    expect(normalizeClientName(42)).toBeNull();
    expect(normalizeClientName(undefined)).toBeNull();
    expect(normalizeClientName("x".repeat(500))).toHaveLength(64);
    expect(normalizeClientName("ChatGPT")).toBe("ChatGPT");
  });

  it("stores and echoes the normalized name, and the consent hand-off carries it", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const res = await app.fetch(registerReq({ client_name: "  Chat​GPT  ", redirect_uris: [REDIRECT] }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_name?: string };
    expect(body.client_name).toBe("ChatGPT");
    expect(tablesOf(db).oauth_clients.find((r) => r.id === body.client_id)?.client_name).toBe("ChatGPT");

    const auth = await app.fetch(
      new Request(
        `http://mcp.test/oauth/authorize?response_type=code&client_id=${body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=abc&code_challenge_method=S256&state=s`,
      ),
      env,
    );
    expect(auth.status).toBe(302);
    const consent = new URL(auth.headers.get("Location") as string);
    expect(consent.searchParams.get("client_name")).toBe("ChatGPT");
  });

  it("an all-invisible name is dropped so the consent screen shows the fallback", async () => {
    const db = createOAuthD1();
    const env = createOAuthEnv(db);
    const res = await app.fetch(registerReq({ client_name: "​⁠ ", redirect_uris: [REDIRECT] }), env);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; client_name?: string };
    expect(body.client_name).toBeUndefined();
    const auth = await app.fetch(
      new Request(
        `http://mcp.test/oauth/authorize?response_type=code&client_id=${body.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=abc&code_challenge_method=S256`,
      ),
      env,
    );
    expect(new URL(auth.headers.get("Location") as string).searchParams.get("client_name")).toBe("An application");
  });
});
