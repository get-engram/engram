import { Hono } from "hono";
import { generateId, generateApiKeyRaw, hashApiKey, TIER_LIMITS } from "@getengram/shared";
import { insertApiKey, getApiKeysByOrg, getApiKeyCount, revokeApiKey } from "@getengram/db";
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
  const body = await c.req.json<{ name?: string }>();

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

  await insertApiKey(c.env.DB, id, auth.organizationId, keyHash, prefix, name);

  // Return the raw key ONCE — it can never be retrieved again
  return c.json({ id, key: raw, prefix, name }, 201);
});

// Revoke an API key
keys.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const keyId = c.req.param("id");

  // Don't allow revoking the key being used for this request
  if (keyId === auth.apiKeyId) {
    return c.json({ error: "Cannot revoke the API key currently in use" }, 400);
  }

  await revokeApiKey(c.env.DB, keyId, auth.organizationId);
  return c.json({ revoked: true });
});

export { keys };
