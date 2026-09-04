import type { Env } from "../types.js";

export interface Mrr {
  /** All active subscriptions, including the owner's own accounts. */
  total_cents: number;
  /** Excludes the owner's internal accounts — real customer revenue. */
  external_cents: number;
  subscriptions: number;
  external_subscriptions: number;
  /** Still 'active' in Stripe but already scheduled to cancel. */
  at_risk_cents: number;
  at_risk_subscriptions: number;
}

/** external_cents minus what is already scheduled to cancel — the honest
 *  "money that will still be here next month" figure. */
export function committedCents(m: Mrr): number {
  return Math.max(0, m.external_cents - m.at_risk_cents);
}

export function committedSubscriptions(m: Mrr): number {
  return Math.max(0, m.external_subscriptions - m.at_risk_subscriptions);
}

/**
 * Live MRR from Stripe. Sums active subscription items and normalizes yearly
 * plans to monthly, rather than trusting hardcoded tier prices — a comped or
 * legacy-priced account would otherwise be counted at list price.
 *
 * `at_risk_*` covers subscriptions Stripe still reports as active but which
 * are already scheduled to cancel (either `cancel_at_period_end` or a
 * `cancel_at` timestamp — both of Stripe's mechanisms count). They pay this
 * period and then stop, so folding them into the headline overstates
 * recurring revenue.
 *
 * Fail-soft by design: callers render without Stripe, so an outage returns
 * zeros rather than throwing. A zero subscription count means "unavailable",
 * not "no customers".
 */
export async function computeMrr(env: Env): Promise<Mrr> {
  const mrr: Mrr = {
    total_cents: 0,
    external_cents: 0,
    subscriptions: 0,
    external_subscriptions: 0,
    at_risk_cents: 0,
    at_risk_subscriptions: 0,
  };
  try {
    if (!env.STRIPE_SECRET_KEY) return mrr;
    const subsRes = await fetch(
      "https://api.stripe.com/v1/subscriptions?status=active&limit=100",
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
    );
    if (!subsRes.ok) return mrr;
    const subs = (await subsRes.json()) as {
      data: Array<{
        customer: string;
        cancel_at_period_end?: boolean;
        cancel_at?: number | null;
        items: {
          data: Array<{
            quantity?: number;
            price?: {
              unit_amount?: number | null;
              recurring?: { interval?: string; interval_count?: number };
            };
          }>;
        };
      }>;
    };

    // Owner's own accounts are tagged referral_source='internal' (see
    // POST /admin/comp-internal), so the exclusion stays data-driven and no
    // personal emails live in the code.
    const internalCustomers = new Set(
      (
        await env.DB.prepare(
          "SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL AND referral_source = 'internal'",
        ).all<{ stripe_customer_id: string }>()
      ).results?.map((r) => r.stripe_customer_id) ?? [],
    );

    for (const s of subs.data) {
      let cents = 0;
      for (const item of s.items?.data ?? []) {
        const unit = item.price?.unit_amount ?? 0;
        const qty = item.quantity ?? 1;
        const interval = item.price?.recurring?.interval ?? "month";
        const count = item.price?.recurring?.interval_count ?? 1;
        cents += interval === "year" ? (unit * qty) / (12 * count) : (unit * qty) / count;
      }
      mrr.total_cents += Math.round(cents);
      mrr.subscriptions += 1;
      if (!internalCustomers.has(s.customer)) {
        mrr.external_cents += Math.round(cents);
        mrr.external_subscriptions += 1;
        const cancelling =
          Boolean(s.cancel_at_period_end) ||
          (typeof s.cancel_at === "number" && s.cancel_at > 0);
        if (cancelling) {
          mrr.at_risk_cents += Math.round(cents);
          mrr.at_risk_subscriptions += 1;
        }
      }
    }
  } catch {
    // leave zeros — callers treat 0 subscriptions as "unavailable"
  }
  return mrr;
}
