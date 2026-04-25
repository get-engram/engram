import type { Context, Next } from "hono";
import type { Env, AuthContext } from "../types.js";
import type { Tier } from "@getengram/shared";

/**
 * Per-org request rate limits (requests per minute).
 * Generous enough for normal agent usage, tight enough to block abuse.
 */
const RATE_LIMITS: Record<Tier, number> = {
  free: 30,
  pro: 120,
  team: 300,
  enterprise: 600,
};

interface BucketEntry {
  tokens: number;
  lastRefill: number;
}

// In-memory token bucket per org. Shared across requests within a
// Worker isolate; resets on deploy or isolate eviction — which is fine,
// this is burst protection, not billing.
const buckets = new Map<string, BucketEntry>();

function consumeToken(orgId: string, tier: Tier): boolean {
  const maxTokens = RATE_LIMITS[tier] ?? RATE_LIMITS.free;
  const now = Date.now();

  let bucket = buckets.get(orgId);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(orgId, bucket);
  }

  // Refill tokens based on elapsed time (token bucket algorithm)
  const elapsed = now - bucket.lastRefill;
  const refill = (elapsed / 60_000) * maxTokens; // full refill per minute
  bucket.tokens = Math.min(maxTokens, bucket.tokens + refill);
  bucket.lastRefill = now;

  if (bucket.tokens < 1) {
    return false;
  }

  bucket.tokens -= 1;
  return true;
}

// Evict stale entries every 1000 requests to prevent memory growth
let requestCount = 0;
const EVICT_INTERVAL = 1000;
const STALE_MS = 5 * 60_000; // 5 minutes

function maybeEvict() {
  requestCount++;
  if (requestCount % EVICT_INTERVAL !== 0) return;
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (now - entry.lastRefill > STALE_MS) {
      buckets.delete(key);
    }
  }
}

export async function rateLimitMiddleware(
  c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
  next: Next,
) {
  const auth = c.get("auth");
  const allowed = consumeToken(auth.organizationId, auth.tier);

  maybeEvict();

  if (!allowed) {
    const limit = RATE_LIMITS[auth.tier] ?? RATE_LIMITS.free;
    return c.json(
      {
        error: "rate_limit_exceeded",
        message: `Rate limit exceeded. ${limit} requests per minute allowed for ${auth.tier} tier.`,
        retry_after: 60,
      },
      429,
    );
  }

  // Set rate limit headers
  c.header("X-RateLimit-Limit", String(RATE_LIMITS[auth.tier] ?? RATE_LIMITS.free));

  await next();
}
