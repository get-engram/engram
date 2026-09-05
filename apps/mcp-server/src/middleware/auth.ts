import type { Context, Next } from "hono";
import { requestCountry } from "../utils/geo.js";
import { hashApiKey } from "@getengram/shared";
import {
  getApiKeyWithOrg,
  touchOrganizationCountry,
  updateApiKeyLastUsed,
  getAccessTokenWithOrg,
} from "@getengram/db";
import { audit } from "../services/audit.js";
import { originOf, wwwAuthenticate } from "../oauth/metadata.js";
import { ALL_SCOPES, parseScopes } from "../mcp/scopes.js";
import type { Env, AuthContext } from "../types.js";

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next
) {
  // Per RFC 9728, a 401 from a protected resource advertises where to discover
  // the authorization server so OAuth clients can start the flow.
  const challenge = () => {
    c.header("WWW-Authenticate", wwwAuthenticate(originOf(c.req.url)));
  };

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    challenge();
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);

  // Admin access via ADMIN_SECRET — cross-org visibility for the business owner.
  const adminSecret = (c.env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (adminSecret && token === adminSecret) {
    c.set("auth", {
      organizationId: "admin",
      apiKeyId: "admin",
      tier: "enterprise" as AuthContext["tier"],
      scopes: [...ALL_SCOPES],
      isAdmin: true,
    });
    await next();
    return;
  }

  // OAuth 2.1 access token (issued via /oauth/token).
  if (token.startsWith("engram_at_")) {
    const tokenHash = await hashApiKey(token);
    const row = await getAccessTokenWithOrg(c.env.DB, tokenHash);
    if (!row) {
      challenge();
      return c.json({ error: "Invalid or expired access token" }, 401);
    }
    c.set("auth", {
      organizationId: row.organization_id,
      apiKeyId: `oauth:${row.client_id}`,
      tier: (row.tier ?? "free") as AuthContext["tier"],
      // OAuth connections get the full memory scope set; their tool surface
      // is already narrowed elsewhere (isExternalOAuthClient).
      scopes: [...ALL_SCOPES],
    });
    await next();
    return;
  }

  // Long-lived API key (engram_sk_live_*).
  if (!token.startsWith("engram_sk_live_")) {
    challenge();
    return c.json({ error: "Invalid API key format" }, 401);
  }

  const keyHash = await hashApiKey(token);
  const row = await getApiKeyWithOrg(c.env.DB, keyHash);

  if (!row) {
    await audit(c.env.DB, "unknown", null, "auth.failure", undefined, undefined, {
      reason: "invalid_key",
    });
    challenge();
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("auth", {
    organizationId: row.organization_id,
    apiKeyId: row.key_id,
    tier: (row.tier ?? "free") as AuthContext["tier"],
    scopes: parseScopes(row.scopes),
    seatId: row.seat_id ?? null,
  });

  // Update last_used_at non-blocking
  c.executionCtx.waitUntil(updateApiKeyLastUsed(c.env.DB, row.key_id));

  // Backfill the org's country on first sight. Writes only where country IS
  // NULL, so this is a no-op for everyone already stamped and costs one cheap
  // indexed UPDATE once per account. It is how accounts created before the
  // column existed acquire one — there is no way to derive it retroactively.
  const country = requestCountry(c.req.raw);
  if (country) {
    c.executionCtx.waitUntil(
      touchOrganizationCountry(c.env.DB, row.organization_id, country).catch(() => {}),
    );
  }

  await next();
}
