import type { Context, Next } from "hono";
import { hashApiKey } from "@getengram/shared";
import { getApiKeyWithOrg, updateApiKeyLastUsed } from "@getengram/db";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next
) {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  if (!token.startsWith("engram_sk_live_")) {
    return c.json({ error: "Invalid API key format" }, 401);
  }

  const keyHash = await hashApiKey(token);
  const row = await getApiKeyWithOrg(c.env.DB, keyHash);

  if (!row) {
    audit(c.env.DB, "unknown", null, "auth.failure", undefined, undefined, {
      reason: "invalid_key",
    });
    return c.json({ error: "Invalid API key" }, 401);
  }

  c.set("auth", {
    organizationId: row.organization_id,
    apiKeyId: row.key_id,
    tier: (row.tier ?? "free") as AuthContext["tier"],
  });

  // Update last_used_at non-blocking
  c.executionCtx.waitUntil(updateApiKeyLastUsed(c.env.DB, row.key_id));

  await next();
}
