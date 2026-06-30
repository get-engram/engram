import { Hono } from "hono";
import { cors } from "hono/cors";
import {
  generateAccessToken,
  generateRefreshToken,
  generateAuthorizationCode,
  generateClientId,
  generateClientSecret,
  generateId,
  hashApiKey,
  verifyPkceS256,
} from "@getengram/shared";
import {
  insertOAuthClient,
  getOAuthClient,
  insertAuthorizationCode,
  getAuthorizationCode,
  consumeAuthorizationCode,
  insertAccessToken,
  insertRefreshToken,
  getRefreshToken,
  rotateRefreshToken,
  revokeRefreshTokenChain,
  getOrganizationByEmail,
  insertOrganizationWithEmail,
} from "@getengram/db";
import { verifySupabaseJwt } from "../utils/jwt.js";
import { DEFAULT_SCOPE, originOf } from "./metadata.js";
import type { Env } from "../types.js";

type HonoEnv = { Bindings: Env };

const ACCESS_TTL_SECONDS = 60 * 60; // 1 hour
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days
const CODE_TTL_SECONDS = 60 * 10; // 10 minutes

const BROWSER_ORIGINS = [
  "https://getengram.app",
  "https://www.getengram.app",
  "http://localhost:3000",
];

/** Format a Date as SQLite's datetime('now') string: "YYYY-MM-DD HH:MM:SS" (UTC). */
function sqliteDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function expiryFromNow(seconds: number): string {
  return sqliteDateTime(new Date(Date.now() + seconds * 1000));
}

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    // Allow loopback for native/dev clients per OAuth 2.1.
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const oauth = new Hono<HonoEnv>();

// engram-web posts the consent approval cross-origin; allow it.
oauth.use(
  "/authorize/approve",
  cors({
    origin: BROWSER_ORIGINS,
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------
oauth.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    redirect_uris?: unknown;
    client_name?: unknown;
    grant_types?: unknown;
    token_endpoint_auth_method?: unknown;
  } | null;

  if (!body) {
    return c.json({ error: "invalid_client_metadata", error_description: "Body must be JSON" }, 400);
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0) {
    return c.json(
      { error: "invalid_redirect_uri", error_description: "At least one redirect_uri is required" },
      400,
    );
  }
  if (redirectUris.length > 10 || !redirectUris.every(isValidRedirectUri)) {
    return c.json(
      { error: "invalid_redirect_uri", error_description: "redirect_uris must be https or http://localhost" },
      400,
    );
  }

  const authMethod =
    body.token_endpoint_auth_method === "client_secret_post" ? "client_secret_post" : "none";
  const grantTypes = Array.isArray(body.grant_types)
    ? body.grant_types.filter((g): g is string => typeof g === "string")
    : ["authorization_code", "refresh_token"];
  const clientName = typeof body.client_name === "string" ? body.client_name : null;

  const clientId = generateClientId();
  let clientSecret: string | null = null;
  let clientSecretHash: string | null = null;
  if (authMethod === "client_secret_post") {
    clientSecret = generateClientSecret();
    clientSecretHash = await hashApiKey(clientSecret);
  }

  await insertOAuthClient(
    c.env.DB,
    clientId,
    clientSecretHash,
    clientName,
    redirectUris,
    grantTypes,
    authMethod,
  );

  return c.json(
    {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      token_endpoint_auth_method: authMethod,
      ...(clientName ? { client_name: clientName } : {}),
    },
    201,
  );
});

// ---------------------------------------------------------------------------
// Authorization endpoint — validate, then hand off to the engram-web consent UI
// ---------------------------------------------------------------------------
oauth.get("/authorize", async (c) => {
  const q = c.req.query();
  const { response_type, client_id, redirect_uri, code_challenge } = q;
  const codeChallengeMethod = q.code_challenge_method ?? "S256";
  const scope = q.scope || DEFAULT_SCOPE;
  const state = q.state ?? "";

  if (!client_id || !redirect_uri) {
    return c.json(
      { error: "invalid_request", error_description: "client_id and redirect_uri are required" },
      400,
    );
  }

  const client = await getOAuthClient(c.env.DB, client_id);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "Unknown client_id" }, 400);
  }

  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirect_uri)) {
    // Never redirect to an unregistered URI — show the error here instead.
    return c.json(
      { error: "invalid_request", error_description: "redirect_uri not registered for this client" },
      400,
    );
  }

  // From here, errors can be safely redirected back to the client.
  const errorRedirect = (error: string, description: string) => {
    const url = new URL(redirect_uri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (state) url.searchParams.set("state", state);
    return c.redirect(url.toString(), 302);
  };

  if (response_type !== "code") {
    return errorRedirect("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!code_challenge || codeChallengeMethod !== "S256") {
    return errorRedirect("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }

  // Hand off to the dashboard consent page, which handles Supabase login and
  // then POSTs back to /oauth/authorize/approve.
  const consent = new URL(`${c.env.APP_URL}/oauth/consent`);
  consent.searchParams.set("client_id", client_id);
  consent.searchParams.set("redirect_uri", redirect_uri);
  consent.searchParams.set("code_challenge", code_challenge);
  consent.searchParams.set("code_challenge_method", "S256");
  consent.searchParams.set("scope", scope);
  consent.searchParams.set("state", state);
  consent.searchParams.set("client_name", client.client_name ?? "An application");
  return c.redirect(consent.toString(), 302);
});

// ---------------------------------------------------------------------------
// Approval — called by the engram-web consent page after the user signs in
// ---------------------------------------------------------------------------
oauth.post("/authorize/approve", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    supabase_token?: string;
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    scope?: string;
    state?: string;
    approved?: boolean;
  } | null;

  if (!body?.client_id || !body.redirect_uri) {
    return c.json({ error: "invalid_request", error_description: "Missing parameters" }, 400);
  }

  const client = await getOAuthClient(c.env.DB, body.client_id);
  if (!client) {
    return c.json({ error: "invalid_client", error_description: "Unknown client_id" }, 400);
  }
  const allowedUris: string[] = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(body.redirect_uri)) {
    return c.json({ error: "invalid_request", error_description: "redirect_uri not registered" }, 400);
  }

  const denied = (error: string) => {
    const url = new URL(body.redirect_uri as string);
    url.searchParams.set("error", error);
    if (body.state) url.searchParams.set("state", body.state);
    return c.json({ redirect: url.toString() });
  };

  if (body.approved === false) {
    return denied("access_denied");
  }

  // Authenticate the resource owner via their Supabase session.
  if (!body.supabase_token) {
    return c.json({ error: "login_required", error_description: "Supabase token required" }, 401);
  }
  let claims;
  try {
    claims = await verifySupabaseJwt(body.supabase_token, c.env.SUPABASE_JWT_SECRET, c.env.SUPABASE_URL);
  } catch {
    return c.json({ error: "login_required", error_description: "Invalid Supabase token" }, 401);
  }
  const email = claims.email;
  if (!email) {
    return c.json({ error: "invalid_token", error_description: "No email claim" }, 400);
  }

  if (!body.code_challenge) {
    return denied("invalid_request");
  }

  // Find-or-create the org for this user (mirrors /signup behavior).
  let orgId: string;
  const existing = (await getOrganizationByEmail(c.env.DB, email)) as { id: string } | null;
  if (existing) {
    orgId = existing.id;
  } else {
    orgId = generateId("org");
    await insertOrganizationWithEmail(c.env.DB, orgId, email.split("@")[0], email);
  }

  const scope = body.scope || DEFAULT_SCOPE;
  const code = generateAuthorizationCode();
  const codeHash = await hashApiKey(code);
  await insertAuthorizationCode(
    c.env.DB,
    codeHash,
    body.client_id,
    orgId,
    body.redirect_uri,
    body.code_challenge,
    "S256",
    scope,
    expiryFromNow(CODE_TTL_SECONDS),
  );

  const url = new URL(body.redirect_uri);
  url.searchParams.set("code", code);
  if (body.state) url.searchParams.set("state", body.state);
  return c.json({ redirect: url.toString() });
});

// ---------------------------------------------------------------------------
// Token endpoint — authorization_code and refresh_token grants
// ---------------------------------------------------------------------------
oauth.post("/token", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const grantType = String(form.grant_type ?? "");

  if (grantType === "authorization_code") {
    return handleAuthorizationCodeGrant(c, form);
  }
  if (grantType === "refresh_token") {
    return handleRefreshTokenGrant(c, form);
  }
  return c.json(
    { error: "unsupported_grant_type", error_description: `Unsupported grant_type: ${grantType}` },
    400,
  );
});

async function issueTokens(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  clientId: string,
  organizationId: string,
  scope: string,
) {
  const accessToken = generateAccessToken();
  const refreshToken = generateRefreshToken();
  await insertAccessToken(
    c.env.DB,
    await hashApiKey(accessToken),
    clientId,
    organizationId,
    scope,
    expiryFromNow(ACCESS_TTL_SECONDS),
  );
  await insertRefreshToken(
    c.env.DB,
    await hashApiKey(refreshToken),
    clientId,
    organizationId,
    scope,
    expiryFromNow(REFRESH_TTL_SECONDS),
  );
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: refreshToken,
    scope,
  });
}

async function verifyClientAuth(
  env: Env,
  clientId: string,
  form: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const client = await getOAuthClient(env.DB, clientId);
  if (!client) return { ok: false, reason: "Unknown client_id" };
  if (client.token_endpoint_auth_method === "client_secret_post") {
    const secret = typeof form.client_secret === "string" ? form.client_secret : "";
    if (!secret || (await hashApiKey(secret)) !== client.client_secret_hash) {
      return { ok: false, reason: "Invalid client_secret" };
    }
  }
  return { ok: true };
}

async function handleAuthorizationCodeGrant(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  form: Record<string, unknown>,
) {
  const clientId = String(form.client_id ?? "");
  const code = String(form.code ?? "");
  const redirectUri = String(form.redirect_uri ?? "");
  const codeVerifier = String(form.code_verifier ?? "");

  if (!clientId || !code || !redirectUri || !codeVerifier) {
    return c.json(
      { error: "invalid_request", error_description: "client_id, code, redirect_uri, code_verifier required" },
      400,
    );
  }

  const clientAuth = await verifyClientAuth(c.env, clientId, form);
  if (!clientAuth.ok) {
    return c.json({ error: "invalid_client", error_description: clientAuth.reason }, 401);
  }

  const codeHash = await hashApiKey(code);
  const row = await getAuthorizationCode(c.env.DB, codeHash);
  if (!row) {
    return c.json({ error: "invalid_grant", error_description: "Code invalid, expired, or used" }, 400);
  }
  if (row.client_id !== clientId || row.redirect_uri !== redirectUri) {
    return c.json({ error: "invalid_grant", error_description: "Code does not match client/redirect_uri" }, 400);
  }
  if (!(await verifyPkceS256(codeVerifier, row.code_challenge))) {
    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }

  // Single-use: consume before issuing so a replay can't mint a second token.
  await consumeAuthorizationCode(c.env.DB, codeHash);
  return issueTokens(c, clientId, row.organization_id, row.scope);
}

async function handleRefreshTokenGrant(
  c: { env: Env; json: (body: unknown, status?: number) => Response },
  form: Record<string, unknown>,
) {
  const clientId = String(form.client_id ?? "");
  const refreshToken = String(form.refresh_token ?? "");
  if (!clientId || !refreshToken) {
    return c.json(
      { error: "invalid_request", error_description: "client_id and refresh_token required" },
      400,
    );
  }

  const clientAuth = await verifyClientAuth(c.env, clientId, form);
  if (!clientAuth.ok) {
    return c.json({ error: "invalid_client", error_description: clientAuth.reason }, 401);
  }

  const tokenHash = await hashApiKey(refreshToken);
  const row = await getRefreshToken(c.env.DB, tokenHash);
  if (!row || row.client_id !== clientId) {
    return c.json({ error: "invalid_grant", error_description: "Unknown refresh token" }, 400);
  }
  // Reuse detection: an already-rotated or revoked token means the chain is
  // compromised — revoke everything for this client+org.
  if (row.rotated_to || row.revoked_at) {
    await revokeRefreshTokenChain(c.env.DB, row.client_id, row.organization_id);
    return c.json({ error: "invalid_grant", error_description: "Refresh token reuse detected" }, 400);
  }
  if (sqliteDateTime(new Date()) > row.expires_at) {
    return c.json({ error: "invalid_grant", error_description: "Refresh token expired" }, 400);
  }

  const newRefresh = generateRefreshToken();
  const newRefreshHash = await hashApiKey(newRefresh);
  await rotateRefreshToken(c.env.DB, tokenHash, newRefreshHash);

  const accessToken = generateAccessToken();
  await insertAccessToken(
    c.env.DB,
    await hashApiKey(accessToken),
    clientId,
    row.organization_id,
    row.scope,
    expiryFromNow(ACCESS_TTL_SECONDS),
  );
  await insertRefreshToken(
    c.env.DB,
    newRefreshHash,
    clientId,
    row.organization_id,
    row.scope,
    expiryFromNow(REFRESH_TTL_SECONDS),
  );
  return c.json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    refresh_token: newRefresh,
    scope: row.scope,
  });
}
