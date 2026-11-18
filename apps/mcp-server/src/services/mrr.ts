import type { Env } from "../types.js";
import { describeError, listRows, StripeListTooLong } from "./stripe-list.js";

export interface Mrr {
  /**
   * Whether Stripe answered. When false every figure below is zero and means
   * nothing: render "unavailable", never "$0" (engram#569).
   */
  available: boolean;
  /** Why Stripe was unavailable, in a few words. Never holds the key. */
  error?: string;
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

/** Safety stop: 20 pages is 2,000 active subscriptions. */
const MAX_PAGES = 20;

interface StripeSubscription {
  id: string;
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
}

/**
 * Stripe customers that belong to the owner's own accounts. They are tagged
 * referral_source='internal' (see POST /admin/comp-internal), so the
 * exclusion stays data-driven and no personal emails live in the code.
 * Throws when D1 does not answer: a figure computed without this list
 * would count the owner as a customer.
 */
export async function loadInternalCustomers(db: D1Database): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      "SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL AND referral_source = 'internal'",
    )
    .all<{ stripe_customer_id: string }>();
  return new Set((results ?? []).map((r) => r.stripe_customer_id));
}

/**
 * What one read of Stripe's active subscriptions came to: the figures, and
 * the customers behind two of them. A caller that also counts paying
 * customers from somewhere else (prepaid plans, services/annual-plans.ts)
 * uses the sets to leave out the ones already counted here. Both are empty
 * when Stripe did not answer.
 */
export interface SubscriptionRead {
  mrr: Mrr;
  /** The real customers behind `mrr.external_subscriptions`. */
  externalCustomers: ReadonlySet<string>;
  /** Of those, the ones behind `committedSubscriptions(mrr)`: a subscription not scheduled to cancel. */
  committedCustomers: ReadonlySet<string>;
}

function zeros(): Mrr {
  return {
    available: false,
    total_cents: 0,
    external_cents: 0,
    subscriptions: 0,
    external_subscriptions: 0,
    at_risk_cents: 0,
    at_risk_subscriptions: 0,
  };
}

function unavailable(reason: string): SubscriptionRead {
  console.error(`[mrr] revenue unavailable: ${reason}`);
  return {
    mrr: { ...zeros(), error: reason },
    externalCustomers: new Set(),
    committedCustomers: new Set(),
  };
}

/**
 * Live MRR from Stripe, with the customers it counted. Sums active
 * subscription items and normalizes yearly plans to monthly, rather than
 * trusting hardcoded tier prices — a comped or legacy-priced account would
 * otherwise be counted at list price.
 *
 * `at_risk_*` covers subscriptions Stripe still reports as active but which
 * are already scheduled to cancel (either `cancel_at_period_end` or a
 * `cancel_at` timestamp — both of Stripe's mechanisms count). They pay this
 * period and then stop, so folding them into the headline overstates
 * recurring revenue.
 *
 * Never throws: callers render without Stripe. A failure returns
 * `available: false` with the reason, and is logged. It used to return bare
 * zeros, which the daily report printed as "$0/mo committed from 0
 * customers" on a morning Stripe failed to answer once (engram#569).
 */
export async function readSubscriptions(env: Env): Promise<SubscriptionRead> {
  if (!env.STRIPE_SECRET_KEY) return unavailable("no STRIPE_SECRET_KEY");

  const subs: StripeSubscription[] = [];
  try {
    const list = listRows<StripeSubscription>(
      env.STRIPE_SECRET_KEY,
      "/v1/subscriptions",
      { status: "active" },
      MAX_PAGES,
    );
    for await (const s of list) subs.push(s);
  } catch (err) {
    if (err instanceof StripeListTooLong) {
      return unavailable(`more than ${err.limit} active subscriptions`);
    }
    return unavailable(describeError(err));
  }

  // Without the owner's accounts taken out every figure would count them
  // as customers, so a failed lookup is a failed read.
  let internalCustomers: Set<string>;
  try {
    internalCustomers = await loadInternalCustomers(env.DB);
  } catch (err) {
    return unavailable(`internal-account lookup failed: ${describeError(err)}`);
  }

  const mrr = zeros();
  const externalCustomers = new Set<string>();
  const committedCustomers = new Set<string>();
  for (const s of subs) {
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
      externalCustomers.add(s.customer);
      const cancelling =
        Boolean(s.cancel_at_period_end) ||
        (typeof s.cancel_at === "number" && s.cancel_at > 0);
      if (cancelling) {
        mrr.at_risk_cents += Math.round(cents);
        mrr.at_risk_subscriptions += 1;
      } else {
        committedCustomers.add(s.customer);
      }
    }
  }
  mrr.available = true;
  return { mrr, externalCustomers, committedCustomers };
}
