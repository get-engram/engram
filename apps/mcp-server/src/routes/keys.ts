import { Hono } from "hono";
import { generateId, generateApiKeyRaw, hashApiKey, TIER_LIMITS } from "@getengram/shared";
import { insertApiKey, getApiKeysByOrg, getApiKeyCount, revokeApiKey } from "@getengram/db";
import { ALL_SCOPES, hasScope, mintableScopes } from "../mcp/scopes.js";
import { isExternalOAuthClient } from "../mcp/auth-kind.js";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const keys = new Hono<HonoEnv>();

// List API keys (prefix only, never full key)
keys.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getApiKeysByOrg(c.env.DB, auth.organizationId);
  return c.json({ keys: result.results });
});

// Create a new API key
keys.post("/", async (c) => {
  const auth = c.get("auth");

  // Minting a credential is a first-party, write-level act (engram#475
  // audit). Before this gate ANY authenticated principal could mint a
  // permanent full-scope key: a read-only key, or a ChatGPT connector the
  // user had granted read-only consent to — which made every scope narrowing
  // elsewhere in the system decorative.
  if (isExternalOAuthClient(auth)) {
    return c.json(
      {
        error: "forbidden",
        message:
          "API keys are managed from the Engram dashboard or CLI, not from a connected app.",
      },
      403,
    );
  }
  if (!hasScope(auth, "write")) return c.json({ error: "insufficient_scope", message: "This action requires the 'write' scope." }, 403);

  const body = await c.req
    .json<{ name?: string; scopes?: unknown }>()
    .catch(() => ({}) as { name?: string; scopes?: unknown });

  // A key never carries more than the principal minting it; omitted means
  // "what I have", not ALL_SCOPES.
  const narrowed = mintableScopes(auth.scopes ?? ALL_SCOPES, body.scopes);
  if (!Array.isArray(narrowed)) {
    return c.json({ error: "invalid_scopes", message: narrowed.error }, 400);
  }
  const scopes = narrowed;

  // Check key limit
  const limits = TIER_LIMITS[auth.tier];
  if (limits.api_keys !== -1) {
    const count = await getApiKeyCount(c.env.DB, auth.organizationId);
    if ((count?.count ?? 0) >= limits.api_keys) {
      return c.json({
        error: "api_key_limit_exceeded",
        message: `Your ${auth.tier} plan allows ${limits.api_keys} API key(s). Upgrade at https://getengram.app/pricing`,
        limit: limits.api_keys,
      }, 403);
    }
  }

  const id = generateId("key");
  const { raw, prefix } = generateApiKeyRaw();
  const keyHash = await hashApiKey(raw);
  const name = body.name || "default";

  await insertApiKey(c.env.DB, id, auth.organizationId, keyHash, prefix, name, scopes.join(","));
  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "key.create", "api_key", id, {
    name,
    scopes,
    prefix,
  });

  // Return the raw key ONCE — it can never be retrieved again
  return c.json({ id, key: raw, prefix, name, scopes }, 201);
});

// Revoke an API key
keys.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const keyId = c.req.param("id");

  // Same gate as minting: revocation is a write, and not a connector's call.
  // (A proper owner/member distinction is RBAC work tracked separately; this
  // closes the read-only-principal case and makes the act visible.)
  if (isExternalOAuthClient(auth)) {
    return c.json({ error: "forbidden", message: "API keys are managed from the dashboard or CLI." }, 403);
  }
  if (!hasScope(auth, "write")) return c.json({ error: "insufficient_scope", message: "This action requires the 'write' scope." }, 403);

  // Don't allow revoking the key being used for this request
  if (keyId === auth.apiKeyId) {
    return c.json({ error: "Cannot revoke the API key currently in use" }, 400);
  }

  await revokeApiKey(c.env.DB, keyId, auth.organizationId);
  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "key.revoke", "api_key", keyId);
  return c.json({ revoked: true });
});

export { keys };
