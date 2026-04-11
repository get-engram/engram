import type { Context, Next } from "hono";
import { hashApiKey } from "@getengram/shared";
import { getApiKeyByHash, updateApiKeyLastUsed, getOrganizationById } from "@getengram/db";
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

  // Fetch org to get tier
  const org = await getOrganizationById(c.env.DB, key.organization_id) as {
    id: string;
    tier: "free" | "pro" | "team" | "enterprise";
  } | null;

  if (!org) {
    return c.json({ error: "Organization not found" }, 401);
  }

  c.set("auth", {
    organizationId: key.organization_id,
    apiKeyId: key.id,
    tier: org.tier ?? "free",
  });

  // Update last_used_at non-blocking
  c.executionCtx.waitUntil(updateApiKeyLastUsed(c.env.DB, key.id));

  await next();
}
