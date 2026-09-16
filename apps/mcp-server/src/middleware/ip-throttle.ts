import type { Context, Next } from "hono";
import type { Env, AuthContext } from "../types.js";

/**
 * Best-effort per-IP throttle for UNAUTHENTICATED routes.
 *
 * This is a floor, not a wall. Like the per-org rate limiter it is an
 * in-memory token bucket scoped to a single Worker isolate, so it resets on
 * deploy/eviction and an attacker spread across isolates gets a multiple of
 * the nominal rate. That is a known limit (the durable per-key version is the
 * P1 follow-up — a Durable Object or the Cloudflare native rate-limit
 * binding). What it does buy, cheaply and today, is turning "unlimited" into
 * "bounded": an unauthenticated caller can no longer mint thousands of orgs
 * or spray a route in a tight loop from one address, which is the concrete
 * abuse the audit flagged on /signup/anonymous.
 *
 * Keyed on Cloudflare's CF-Connecting-IP (the real client IP at the edge,
 * unspoofable by request headers). If it is ever absent (non-CF path, local
 * dev) the request is allowed through rather than blocked — fail-open, since
 * this is abuse-dampening, not authorization.
 */
interface Bucket {
  tokens: number;
  updated: number;
}

const buckets = new Map<string, Bucket>();

// Bounded sweep: only runs when the Map is large, and only removes buckets
// that have been idle for at least a full window (their tokens have fully
// refilled by the time-based refill, so dropping them loses no throttle state
// — a returning IP just gets a fresh full bucket, which is the same thing).
// This keeps memory proportional to ACTIVE IPs without evicting IPs mid-abuse.
const SWEEP_THRESHOLD = 20_000;
function maybeSweep(now: number, windowMs: number) {
  if (buckets.size < SWEEP_THRESHOLD) return;
  for (const [k, b] of buckets) {
    if (now - b.updated >= windowMs) buckets.delete(k);
  }
}

export function ipThrottle(opts: { limit: number; windowMs: number; bucket: string }) {
  const { limit, windowMs, bucket: name } = opts;
  return async function (
    c: Context<{ Bindings: Env; Variables: { auth: AuthContext } }>,
    next: Next,
  ) {
    const ip = c.req.header("CF-Connecting-IP");
    if (!ip) {
      // No trustworthy client IP (local dev, non-CF ingress) — don't block.
      await next();
      return;
    }
    const key = `${name}:${ip}`;
    const now = Date.now();
    maybeSweep(now, windowMs);
    let b = buckets.get(key);
    if (!b) {
      b = { tokens: limit, updated: now };
      buckets.set(key, b);
    }
    // Refill proportionally to elapsed time.
    const refill = ((now - b.updated) / windowMs) * limit;
    b.tokens = Math.min(limit, b.tokens + refill);
    b.updated = now;

    if (b.tokens < 1) {
      const retry = Math.ceil((windowMs / limit) / 1000);
      c.header("Retry-After", String(retry));
      return c.json(
        { error: "rate_limited", message: "Too many requests from this address. Slow down and retry shortly." },
        429,
      );
    }
    b.tokens -= 1;
    await next();
  };
}
