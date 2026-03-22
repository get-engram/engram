import type { Context, Next } from "hono";
import { hashApiKey } from "@engram/shared";
import { getApiKeyByHash, updateApiKeyLastUsed } from "@engram/db";
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
  const apiKey = await getApiKeyByHash(c.env.DB, keyHash);

  if (!apiKey) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  const key = apiKey as { id: string; organization_id: string };

  c.set("auth", {
    organizationId: key.organization_id,
    apiKeyId: key.id,
  });

  // Update last_used_at non-blocking
  c.executionCtx.waitUntil(updateApiKeyLastUsed(c.env.DB, key.id));

  await next();
}
