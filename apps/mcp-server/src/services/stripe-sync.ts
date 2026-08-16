import type { Env } from "../types.js";

// ---------------------------------------------------------------------------
// Reconcile one org's D1 tier/cancel state from its live Stripe subscriptions.
//
// This is the single source of the "what does Stripe actually say" logic,
// shared by the admin Sync button (routes/admin.ts) and the reconciliation
// cron (cron/reconcile-stripe.ts) so they can never drift.
//
// Guardrails (each one guards a way an ACTIVE/valid payer could be wrongly
// downgraded — the whole point of this fix):
//   - enterprise tier is negotiated above the Stripe price tiers → never sync.
//   - an active admin grant/comp (grace_ends_at in the future) → never churn.
//   - an EMPTY Stripe result is a stale customer id, NOT a cancellation → skip.
//   - a recoverable sub (past_due dunning / paused / incomplete) → don't
//     downgrade; the customer may still pay. Only churn on genuinely terminal
//     subs (canceled / incomplete_expired / unpaid).
// ---------------------------------------------------------------------------

export interface OrgSyncInput {
  id: string;
  tier: string;
  stripe_customer_id: string | null;
  grace_ends_at?: string | null;
}

export type StripeSyncResult =
  | {
      synced: false;
      reason:
        | "no_stripe_customer"
        | "stripe_api_error"
        | "no_subscriptions_returned"
        | "manual_tier"
        | "in_dunning";
      tier: string;
    }
  | {
      synced: true;
      tier: string;
      subscription_id: string | null;
      status?: string;
      cancel_at_period_end?: boolean;
      cancel_at?: string | null;
      seat_limit?: number;
      churned_at?: string | null;
    };

interface StripeSub {
  id: string;
  status: string;
  items: { data: Array<{ price: { id: string }; quantity: number }> };
  cancel_at_period_end: boolean;
  cancel_at: number | null;
  canceled_at: number | null;
}

// D1 datetimes are stored UTC-naive ("YYYY-MM-DD HH:MM:SS"); parse as UTC.
function isFuture(d1Datetime: string | null | undefined): boolean {
  if (!d1Datetime) return false;
  const t = Date.parse(d1Datetime.replace(" ", "T") + "Z");
  return Number.isFinite(t) && t > Date.now();
}

export async function syncOrganizationFromStripe(
  env: Env,
  org: OrgSyncInput,
): Promise<StripeSyncResult> {
  // Enterprise is manually negotiated above the Stripe price tiers — syncing
  // from Stripe would wrongly rewrite it. Leave it entirely to the operator.
  if (org.tier === "enterprise") {
    return { synced: false, reason: "manual_tier", tier: org.tier };
  }
  if (!org.stripe_customer_id) {
    return { synced: false, reason: "no_stripe_customer", tier: org.tier };
  }

  // limit=100 (Stripe max): status=all is ordered created-desc, so a live sub
  // must never be paginated out behind old churned subs — that would read as a
  // false cancellation, and the cron would apply it fleet-wide.
  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&status=all&limit=100`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );
  if (!subsRes.ok) {
    return { synced: false, reason: "stripe_api_error", tier: org.tier };
  }

  const subs = (await subsRes.json()) as { data: StripeSub[] };

  const activeSub = subs.data.find(
    (s) => s.status === "active" || s.status === "trialing",
  );

  if (activeSub) {
    // Live subscription — set the tier from its price, clear any stale churn.
    const priceId = activeSub.items?.data?.[0]?.price?.id;
    const quantity = activeSub.items?.data?.[0]?.quantity ?? 1;
    let tier = "pro";
    if (priceId === env.STRIPE_PRICE_ID_TEAM) tier = "team";
    const seatLimit = tier === "team" ? quantity : 1;

    // Both of Stripe's scheduled-cancel mechanisms count: the bool AND the
    // cancel_at timestamp (portal "cancel on <date>").
    const cancelling =
      Boolean(activeSub.cancel_at_period_end) ||
      (typeof activeSub.cancel_at === "number" && activeSub.cancel_at > 0);

    await env.DB.prepare(
      "UPDATE organizations SET tier = ?, stripe_subscription_id = ?, seat_limit = ?, cancel_at_period_end = ?, churned_at = CASE WHEN ? = 0 THEN NULL ELSE churned_at END WHERE id = ?",
    )
      .bind(tier, activeSub.id, seatLimit, cancelling ? 1 : 0, cancelling ? 1 : 0, org.id)
      .run();

    return {
      synced: true,
      tier,
      subscription_id: activeSub.id,
      status: activeSub.status,
      cancel_at_period_end: cancelling,
      cancel_at: activeSub.cancel_at ? new Date(activeSub.cancel_at * 1000).toISOString() : null,
      seat_limit: seatLimit,
    };
  }

  // No live subscription. Decide carefully before downgrading — several
  // non-cancellation states land here.
  if (subs.data.length === 0) {
    // Empty result = stale/duplicate customer id, NOT a cancellation.
    return { synced: false, reason: "no_subscriptions_returned", tier: org.tier };
  }
  if (isFuture(org.grace_ends_at)) {
    // Admin grant-pro / comp still within its grace window — operator-managed,
    // don't revert it just because Stripe has no live sub.
    return { synced: false, reason: "manual_tier", tier: org.tier };
  }
  const recoverable = subs.data.find(
    (s) => s.status === "past_due" || s.status === "paused" || s.status === "incomplete",
  );
  if (recoverable) {
    // In dunning / paused / incomplete — the customer may still pay. Keep
    // their tier; a real cancellation will surface as a terminal sub later.
    return { synced: false, reason: "in_dunning", tier: org.tier };
  }

  // Genuine churn: every sub is terminal (canceled / incomplete_expired /
  // unpaid). Stamp churned_at from Stripe's canceled_at (keeping any earlier
  // stamp) and downgrade. Churn is derived from Stripe evidence only.
  const canceled = subs.data
    .filter((s) => s.canceled_at)
    .sort((a, b) => (b.canceled_at ?? 0) - (a.canceled_at ?? 0))[0];
  const churnedAt = canceled?.canceled_at
    ? new Date(canceled.canceled_at * 1000).toISOString().slice(0, 19).replace("T", " ")
    : null;
  await env.DB.prepare(
    `UPDATE organizations SET
       churned_at = COALESCE(churned_at, COALESCE(?, datetime('now'))),
       cancel_at_period_end = 0,
       tier = 'free', stripe_subscription_id = NULL, seat_limit = 1
     WHERE id = ?`,
  )
    .bind(churnedAt, org.id)
    .run();
  return { synced: true, tier: "free", subscription_id: null, churned_at: churnedAt ?? "now" };
}
