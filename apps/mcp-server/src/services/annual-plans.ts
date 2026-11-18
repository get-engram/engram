/**
 * Accounts on a prepaid plan: one payment for a fixed term, no subscription
 * (the Black Friday offer, engram#763 / #765).
 *
 * Stripe's subscription list never holds them, so every figure built on it
 * (services/mrr.ts) leaves them out, and the admin page and the daily report
 * showed a customer who had paid as nobody at all (engram#768). The record
 * of the purchase is the `prepaid_plans` table, one row per paid Checkout
 * Session, written by the Stripe webhook (services/black-friday.ts).
 *
 * This module depends on that table only. It has to keep working after the
 * offer's own code is removed: a plan bought in November 2026 runs until
 * November 2027.
 */

/** One running prepaid plan, with what is needed to avoid counting its account twice. */
export interface AnnualPlanRow {
  org_id: string;
  stripe_customer_id: string | null;
  /**
   * 1 when the account's row carries a Stripe subscription id, by the test
   * the daily report's fallback count uses (IS NOT NULL). That column
   * outlives the subscription, so it is only a stand-in for "also
   * subscribed" on a run where Stripe itself did not answer.
   */
  has_subscription_id: number;
  offer: string;
  amount_total: number | null;
  currency: string | null;
  ends_at: string;
}

export interface AnnualPlans {
  /** Accounts on a prepaid plan that has not run out. */
  plans: number;
  /**
   * Of `plans`, the accounts already counted among the subscriptions
   * reported beside this figure. `plans - also_monthly` is what to add to
   * that count to get paying customers, with nobody counted twice.
   */
  also_monthly: number;
  /** What was paid for those plans, in usd cents. A payment, not a monthly figure. */
  cents: number;
  /**
   * `plans` split by the offer that sold them. An account holding plans
   * from two offers is under the one that ends first.
   */
  by_offer: Record<string, number>;
  /**
   * When the first of those accounts comes off its plan, as D1 stores it
   * (UTC, "YYYY-MM-DD HH:MM:SS"). An account with several plans is on them
   * until the last one ends.
   */
  next_end: string | null;
  /** Plan payments in another currency: their accounts are in `plans`, the money is not in `cents`. */
  other_currency_payments: number;
}

/**
 * The running prepaid plans of real customers.
 *
 * Left out: a plan that has run out, a deleted account, the owner's own
 * accounts (the rule services/mrr.ts uses), and a plan whose account is no
 * longer on the tier it bought. That last one covers an account an admin
 * set back to Free after a refund and one that moved to another plan since.
 *
 * CROSS JOIN is SQLite's way of fixing the join order: start from
 * prepaid_plans, which holds a row per purchase, and look each account up
 * by its primary key. The planner picks that order by itself today; this
 * keeps it from ever walking organizations instead, and
 * annual-plans.d1.test.ts pins the plan.
 */
export function annualPlansStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(`
    SELECT
      p.org_id,
      o.stripe_customer_id,
      CASE WHEN o.stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END AS has_subscription_id,
      p.offer,
      p.amount_total,
      p.currency,
      p.ends_at
    FROM prepaid_plans p
    CROSS JOIN organizations o ON o.id = p.org_id
    WHERE p.ends_at > datetime('now')
      AND o.deleted_at IS NULL
      AND o.tier = p.tier
      AND COALESCE(o.referral_source, '') != 'internal'
    ORDER BY p.ends_at
  `);
}

/**
 * Add the rows up. `alreadyCounted` says whether a plan's account is
 * already in the subscription count the caller reports next to this one;
 * the caller knows which count that is.
 */
export function summarizeAnnualPlans(
  rows: AnnualPlanRow[],
  alreadyCounted: (row: AnnualPlanRow) => boolean,
): AnnualPlans {
  /** Each account's last end date. An account that bought twice is one customer. */
  const endOf = new Map<string, string>();
  const counted = new Set<string>();
  const out: AnnualPlans = {
    plans: 0,
    also_monthly: 0,
    cents: 0,
    by_offer: {},
    next_end: null,
    other_currency_payments: 0,
  };
  for (const r of rows) {
    // The row stores the currency the Checkout Session reported. A row
    // without one is read as usd, which is what the one offer sold so far
    // (Black Friday 2026) charged. Any other currency is counted apart,
    // never added in as if it were cents of a dollar.
    const currency = (r.currency ?? "usd").toLowerCase();
    if (currency === "usd") out.cents += r.amount_total ?? 0;
    else out.other_currency_payments += 1;

    if (alreadyCounted(r)) counted.add(r.org_id);

    const end = endOf.get(r.org_id);
    if (end === undefined) out.by_offer[r.offer] = (out.by_offer[r.offer] ?? 0) + 1;
    // D1's datetime text sorts in time order.
    if (end === undefined || r.ends_at > end) endOf.set(r.org_id, r.ends_at);
  }
  out.plans = endOf.size;
  out.also_monthly = counted.size;
  for (const end of endOf.values()) {
    if (out.next_end === null || end < out.next_end) out.next_end = end;
  }
  return out;
}

/** Whether the plan's account is one of these Stripe customers. */
export function holdsSubscription(customers: ReadonlySet<string>): (row: AnnualPlanRow) => boolean {
  return (row) => row.stripe_customer_id !== null && customers.has(row.stripe_customer_id);
}
