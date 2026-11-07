import type { Env } from "../types.js";

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

/** Stripe's largest page. */
const PAGE_SIZE = 100;
/** Safety stop: 20 pages is 2,000 active subscriptions. */
const MAX_PAGES = 20;
/** Bounds a hung request. Stripe answers this list in well under a second. */
const STRIPE_TIMEOUT_MS = 10_000;
/** A transient failure (network, timeout, 429, 5xx) gets one more try. */
const STRIPE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

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

interface StripePage {
  data: StripeSubscription[];
  has_more?: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One page of active subscriptions. Retries a transient failure once; a
 * refusal such as 401 is not retried, since it would only be refused again.
 * Throws with a short reason.
 */
async function fetchPage(key: string, startingAfter: string | null): Promise<StripePage> {
  const url = new URL("https://api.stripe.com/v1/subscriptions");
  url.searchParams.set("status", "active");
  url.searchParams.set("limit", String(PAGE_SIZE));
  if (startingAfter) url.searchParams.set("starting_after", startingAfter);

  let reason = "";
  for (let attempt = 1; attempt <= STRIPE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
      });
    } catch (err) {
      reason = `Stripe request failed: ${describe(err)}`;
      continue;
    }
    if (res.ok) return (await res.json()) as StripePage;
    reason = `Stripe answered ${res.status}`;
    // Drain the body so the connection is released before any retry.
    await res.text().catch(() => "");
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(reason);
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

function unavailable(reason: string): Mrr {
  console.error(`[mrr] revenue unavailable: ${reason}`);
  return { ...zeros(), error: reason };
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
 * Never throws: callers render without Stripe. A failure returns
 * `available: false` with the reason, and is logged. It used to return bare
 * zeros, which the daily report printed as "$0/mo committed from 0
 * customers" on a morning Stripe failed to answer once (engram#569).
 */
export async function computeMrr(env: Env): Promise<Mrr> {
  if (!env.STRIPE_SECRET_KEY) return unavailable("no STRIPE_SECRET_KEY");

  const subs: StripeSubscription[] = [];
  try {
    let startingAfter: string | null = null;
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        return unavailable(`more than ${MAX_PAGES * PAGE_SIZE} active subscriptions`);
      }
      const batch = await fetchPage(env.STRIPE_SECRET_KEY, startingAfter);
      subs.push(...(batch.data ?? []));
      const last = batch.data?.[batch.data.length - 1];
      if (!batch.has_more || !last) break;
      startingAfter = last.id;
    }
  } catch (err) {
    return unavailable(describe(err));
  }

  // Owner's own accounts are tagged referral_source='internal' (see
  // POST /admin/comp-internal), so the exclusion stays data-driven and no
  // personal emails live in the code. Without it every figure would count
  // them as customers, so a failed lookup is a failed read.
  let internalCustomers: Set<string>;
  try {
    internalCustomers = new Set(
      (
        await env.DB.prepare(
          "SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL AND referral_source = 'internal'",
        ).all<{ stripe_customer_id: string }>()
      ).results?.map((r) => r.stripe_customer_id) ?? [],
    );
  } catch (err) {
    return unavailable(`internal-account lookup failed: ${describe(err)}`);
  }

  const mrr = zeros();
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
      const cancelling =
        Boolean(s.cancel_at_period_end) ||
        (typeof s.cancel_at === "number" && s.cancel_at > 0);
      if (cancelling) {
        mrr.at_risk_cents += Math.round(cents);
        mrr.at_risk_subscriptions += 1;
      }
    }
  }
  mrr.available = true;
  return mrr;
}
