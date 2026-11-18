import type { Env } from "../types.js";
import { createTtlMemo } from "../utils/ttl-memo.js";
import { loadInternalCustomers } from "./mrr.js";
import { describeError, listRows, StripeListTooLong } from "./stripe-list.js";

/**
 * Total sales to date: every successful payment Stripe holds for the
 * account, after refunds and before Stripe's fees (engram#768).
 *
 * Subscription payments and one-time payments (a prepaid plan) are both
 * charges in Stripe, so one list covers both. The owner's own accounts are
 * kept out of the customer figures, by the same rule services/mrr.ts uses.
 */
export interface Sales {
  /**
   * Whether Stripe answered. When false every figure below is zero and means
   * nothing: render "unavailable", never "$0" (engram#569).
   */
  available: boolean;
  /** Why the figures are unavailable, in a few words. Never holds the key. */
  error?: string;
  /** Money from real customers, after refunds and before fees, in usd cents. */
  external_cents: number;
  /** Payments behind `external_cents`. One refunded in full is not counted. */
  external_payments: number;
  /** Stripe customers behind `external_cents`. A payment with no customer attached adds none. */
  external_customers: number;
  /** What was refunded to real customers, already taken out of `external_cents`. */
  refunded_cents: number;
  /** Payments by the owner's own accounts. In no figure above. */
  internal_cents: number;
  internal_payments: number;
  /** When the first payment in `external_payments` was made (ISO), or null. */
  first_paid_at: string | null;
  /** Payments in `external_payments` the customer's bank has disputed, and what they add up to. */
  disputed_payments: number;
  disputed_cents: number;
  /** Successful payments in another currency. In no figure above. */
  other_currency_payments: number;
  /** When Stripe was read (ISO). Older than the cache window means Stripe has not answered since. */
  computed_at: string | null;
}

/** How long a read is served before Stripe is asked again. */
export const SALES_TTL_MS = 60_000;
/** After a failed read, how long the last good figures are served before trying again. */
export const SALES_ERROR_BACKOFF_MS = 60_000;
/** Safety stop: 20 pages is 2,000 payment attempts, failed ones included. */
const MAX_PAGES = 20;

interface StripeCharge {
  id: string;
  status?: string;
  paid?: boolean;
  currency?: string;
  amount_captured?: number;
  amount_refunded?: number;
  disputed?: boolean;
  customer?: string | null;
  created?: number;
}

function zeros(): Sales {
  return {
    available: false,
    external_cents: 0,
    external_payments: 0,
    external_customers: 0,
    refunded_cents: 0,
    internal_cents: 0,
    internal_payments: 0,
    first_paid_at: null,
    disputed_payments: 0,
    disputed_cents: 0,
    other_currency_payments: 0,
    computed_at: null,
  };
}

function unavailable(reason: string): Sales {
  console.error(`[sales] total sales unavailable: ${reason}`);
  return { ...zeros(), error: reason };
}

/** One full read of Stripe's charges. Throws with a short reason. */
async function readSales(env: Env, key: string): Promise<Sales> {
  const charges: StripeCharge[] = [];
  try {
    for await (const c of listRows<StripeCharge>(key, "/v1/charges", {}, MAX_PAGES)) {
      // Failed charges on this account carry a non-zero amount_captured, so
      // the status decides what counts, not the amount.
      if (c.status === "succeeded" && c.paid === true) charges.push(c);
    }
  } catch (err) {
    if (err instanceof StripeListTooLong) {
      throw new Error(`more than ${err.limit} payment attempts`);
    }
    throw err;
  }

  // Read after Stripe, like the subscription figures: without this list the
  // owner's own payments would be reported as sales, so a failed lookup is
  // a failed read.
  let internalCustomers: Set<string>;
  try {
    internalCustomers = await loadInternalCustomers(env.DB);
  } catch (err) {
    throw new Error(`internal-account lookup failed: ${describeError(err)}`);
  }

  const sales = zeros();
  const customers = new Set<string>();
  let firstPaid: number | null = null;
  for (const c of charges) {
    if ((c.currency ?? "").toLowerCase() !== "usd") {
      sales.other_currency_payments += 1;
      continue;
    }
    const refunded = c.amount_refunded ?? 0;
    const kept = Math.max(0, (c.amount_captured ?? 0) - refunded);
    if (c.customer && internalCustomers.has(c.customer)) {
      sales.internal_cents += kept;
      if (kept > 0) sales.internal_payments += 1;
      continue;
    }
    sales.external_cents += kept;
    sales.refunded_cents += refunded;
    if (kept === 0) continue;
    sales.external_payments += 1;
    if (c.customer) customers.add(c.customer);
    if (c.disputed) {
      sales.disputed_payments += 1;
      sales.disputed_cents += kept;
    }
    if (typeof c.created === "number" && (firstPaid === null || c.created < firstPaid)) {
      firstPaid = c.created;
    }
  }
  sales.external_customers = customers.size;
  sales.first_paid_at = firstPaid === null ? null : new Date(firstPaid * 1000).toISOString();
  sales.computed_at = new Date().toISOString();
  sales.available = true;
  return sales;
}

/**
 * One value per isolate. Payments arrive a few times a day and the admin
 * page asks every 30 seconds, so a read is kept for a minute: a new sale
 * shows within about that long. When Stripe fails after a good read, the
 * good read is served and `computed_at` says how old it is.
 */
const memo = createTtlMemo<Sales>({
  ttlMs: SALES_TTL_MS,
  errorBackoffMs: SALES_ERROR_BACKOFF_MS,
  onStale: (err, ageMs) =>
    console.error(
      `[sales] read failed, serving figures ${Math.round(ageMs / 1000)}s old: ${describeError(err)}`,
    ),
});

/**
 * Total sales to date. Never throws: callers render without Stripe. With no
 * earlier read to fall back on, a failure returns `available: false` and
 * the reason.
 */
export async function loadSales(env: Env): Promise<Sales> {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) return unavailable("no STRIPE_SECRET_KEY");
  try {
    return await memo.get(() => readSales(env, key));
  } catch (err) {
    return unavailable(describeError(err));
  }
}

/** Test hook: forget the cached read between tests. */
export function resetSalesCacheForTests(): void {
  memo.reset();
}
