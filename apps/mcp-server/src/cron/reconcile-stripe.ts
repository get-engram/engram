import type { Env } from "../types.js";
import { syncOrganizationFromStripe } from "../services/stripe-sync.js";

// ---------------------------------------------------------------------------
// Reconcile every org's D1 tier/cancel state against live Stripe.
//
// D1 is a webhook-only projection: a missed/late/mis-signed Stripe delivery
// leaves the admin dashboard permanently stale until someone clicks "Sync".
// This backstop polls Stripe for every org that has a customer id and repairs
// D1 with the shared, evidence-only sync logic — so a dropped
// `customer.subscription.created` (today's upgrade not showing) or a missed
// `subscription.deleted` self-heals within one cron tick.
//
// Safe by construction: syncOrganizationFromStripe never downgrades on an
// empty Stripe result, so this can run fleet-wide without nuking live payers.
// Only orgs with a stripe_customer_id are touched (a handful today), so the
// Stripe API volume is trivial; batch/paginate if that grows.
// ---------------------------------------------------------------------------

export async function reconcileStripeToD1(
  env: Env,
): Promise<{ checked: number; changed: number; errors: number }> {
  // Enterprise is manually managed (comped / negotiated, often with no live
  // Stripe sub) — never auto-sync it from Stripe (the helper also guards this).
  // grace_ends_at lets the helper skip active admin grants/comps.
  const rows = await env.DB.prepare(
    "SELECT id, tier, stripe_customer_id, grace_ends_at FROM organizations WHERE stripe_customer_id IS NOT NULL AND deleted_at IS NULL AND tier != 'enterprise'",
  ).all<{ id: string; tier: string; stripe_customer_id: string | null; grace_ends_at: string | null }>();

  let checked = 0;
  let changed = 0;
  let errors = 0;

  for (const org of rows.results ?? []) {
    try {
      const before = org.tier;
      const result = await syncOrganizationFromStripe(env, org);
      checked++;
      if (result.synced && result.tier !== before) changed++;
    } catch (err) {
      errors++;
      console.error(
        `[reconcile] org ${org.id} FAILED: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { checked, changed, errors };
}
