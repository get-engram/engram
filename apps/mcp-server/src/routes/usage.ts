import { Hono } from "hono";
import { TIER_LIMITS } from "@getengram/shared";
import { getUsage, getUsageHistory, getApiKeyCount, getSeatCount, getOrganizationById } from "@getengram/db";
import { checkFeatureAccess, storageLimitFor } from "../services/tier.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const usage = new Hono<HonoEnv>();

// Current period usage
usage.get("/", async (c) => {
  const auth = c.get("auth");
  const limits = TIER_LIMITS[auth.tier];

  const [currentUsage, keyCount, seatCount, org] = await Promise.all([
    getUsage(c.env.DB, auth.organizationId),
    getApiKeyCount(c.env.DB, auth.organizationId),
    getSeatCount(c.env.DB, auth.organizationId),
    getOrganizationById(c.env.DB, auth.organizationId) as Promise<{
      seat_limit: number;
      stripe_subscription_id: string | null;
      grace_ends_at: string | null;
      messages_stored_total: number;
    } | null>,
  ]);

  const u = currentUsage as {
    messages_stored: number;
    searches_run: number;
    api_requests?: number;
    period: string;
  } | null;
  // For team tier, seat limit comes from Stripe subscription quantity
  const seatLimit = limits.seats === -1 ? (org?.seat_limit ?? 1) : limits.seats;
  const storageLimit = storageLimitFor(auth.tier, org?.seat_limit ?? 1);

  return c.json({
    tier: auth.tier,
    has_subscription: !!org?.stripe_subscription_id,
    grace_ends_at: org?.grace_ends_at ?? null,
    period: u?.period ?? null,
    messages: {
      used: u?.messages_stored ?? 0,
      limit: limits.messages_per_month,
    },
    // Lifetime memory storage (engram#275) — the primary gate. Memory
    // never expires; it fills up. -1 limit = unlimited.
    storage: {
      used: org?.messages_stored_total ?? 0,
      limit: storageLimit,
    },
    searches: {
      used: u?.searches_run ?? 0,
    },
    // Data-plane requests (/mcp + /api/v1) this period (engram#287).
    api_requests: {
      used: u?.api_requests ?? 0,
    },
    api_keys: {
      used: keyCount?.count ?? 0,
      limit: -1,
    },
    seats: {
      used: seatCount?.count ?? 0,
      limit: seatLimit,
    },
    features: {
      webhooks: limits.webhooks,
      usage_dashboard: limits.usage_dashboard,
    },
  });
});

// Usage history (Team+ only)
usage.get("/history", async (c) => {
  const auth = c.get("auth");

  if (!checkFeatureAccess(auth.tier, "usage_dashboard")) {
    return c.json({
      error: "feature_not_available",
      message: "Usage dashboard is available on Team and Enterprise plans.",
      tier: auth.tier,
    }, 403);
  }

  const months = Number(c.req.query("months") || "6");
  const result = await getUsageHistory(c.env.DB, auth.organizationId, Math.min(months, 12));

  return c.json({ history: result.results });
});

export { usage };
