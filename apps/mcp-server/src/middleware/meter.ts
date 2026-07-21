import type { Context, Next } from "hono";
import { trackApiRequest } from "../services/tier.js";
import type { Env, AuthContext } from "../types.js";

/**
 * Count data-plane API usage (engram#287) — applied to /mcp and /api/v1
 * only, so account-management calls from the dashboard don't inflate the
 * "API requests" number a customer sees. Runs after authMiddleware: if
 * auth was rejected nothing was set and nothing is counted. Admin
 * requests are cross-org and excluded.
 */
export async function meterApiRequest(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next
) {
  await next();
  const auth = c.get("auth");
  if (!auth || auth.isAdmin) return;
  c.executionCtx.waitUntil(
    trackApiRequest(c.env.DB, auth.organizationId).catch(() => {})
  );
}
