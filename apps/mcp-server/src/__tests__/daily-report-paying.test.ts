import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildDailyReport } from "../services/daily-report.js";
import type { Env } from "../types.js";

/**
 * The daily report was contradicting itself: "14 paying" on the totals line
 * beside "$96/mo committed from 12 customers" on the revenue line, in the
 * same email. Two numbers, two sources — the totals came from a D1 column,
 * the revenue from Stripe with the owner's internal accounts excluded.
 *
 * Two things made the D1 count wrong, and both matter:
 *   1. It applied no internal exclusion, so the owner's own comped account
 *      counted as a customer.
 *   2. stripe_subscription_id OUTLIVES the subscription. Comping an account
 *      (POST /admin/comp-internal) deletes the Stripe subscription but
 *      leaves that column set, so the row looks like a payer forever.
 *
 * This is a number the owner makes decisions on, so it is pinned.
 */

const ORGS_WITH_SUB_ID = 14; // what the old query would have returned

/** One running prepaid plan, as services/annual-plans.ts reads it. */
function plan(org: string, customer: string | null, hasSubscriptionId = 0) {
  return {
    org_id: org,
    stripe_customer_id: customer,
    has_subscription_id: hasSubscriptionId,
    offer: "black-friday",
    amount_total: 2700,
    currency: "usd",
    ends_at: "2027-11-18 10:03:28",
  };
}

/** The fallback count of paying accounts, among the report's statements. */
const PAYING_FALLBACK = /AND stripe_subscription_id IS NOT NULL/;

function mockDb(payingFallback: number, plans: Array<ReturnType<typeof plan>> = []) {
  const statement = (sql: string) => {
    const stmt = {
      bind: () => stmt,
      first: async () => (PAYING_FALLBACK.test(sql) ? { n: payingFallback } : { n: 0, id: "org_x" }),
      all: async () => ({ results: /FROM prepaid_plans/.test(sql) ? plans : [] }),
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => {
      // The fallback must exclude internal accounts; if a future edit drops
      // that clause this throws rather than silently inflating the number.
      if (PAYING_FALLBACK.test(sql) && !/!= 'internal'/.test(sql)) {
        throw new Error("paying fallback query lost its internal exclusion");
      }
      return statement(sql);
    },
  } as unknown as D1Database;
}

function env(db: D1Database): Env {
  return { DB: db, STRIPE_SECRET_KEY: "sk_test" } as unknown as Env;
}

/** Stripe: `subs` active subscriptions, `internalCustomer` excluded by MRR. */
function mockStripe(subs: Array<{ customer: string; cancelling?: boolean }>) {
  return vi.fn(async (url: string) => {
    if (String(url).includes("/v1/subscriptions")) {
      return new Response(
        JSON.stringify({
          data: subs.map((s, i) => ({
            id: `sub_${i}`,
            customer: s.customer,
            cancel_at_period_end: !!s.cancelling,
            items: { data: [{ price: { unit_amount: 900, recurring: { interval: "month" } }, quantity: 1 }] },
          })),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
}

beforeEach(() => vi.stubGlobal("fetch", mockStripe([])));
afterEach(() => vi.unstubAllGlobals());

describe("daily report — paying count", () => {
  it("counts real external subscriptions, not rows with a subscription id", async () => {
    vi.stubGlobal("fetch", mockStripe([
      { customer: "cus_a" },
      { customer: "cus_b" },
      { customer: "cus_c" },
    ]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID)));
    expect(r.totals.paying).toBe(3);
    expect(r.totals.paying).not.toBe(ORGS_WITH_SUB_ID);
  });

  it("agrees with the revenue line in the same email", async () => {
    // One of the three is already cancelling: still paying today, not
    // committed for next month. Both numbers must stay explainable.
    vi.stubGlobal("fetch", mockStripe([
      { customer: "cus_a" },
      { customer: "cus_b" },
      { customer: "cus_c", cancelling: true },
    ]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID)));
    expect(r.totals.paying).toBe(3);
    expect(r.paying_source).toBe("stripe");
    const revenue = r.revenue!;
    expect(revenue).not.toBeNull();
    expect(revenue.committed_subscriptions).toBe(2);
    expect(revenue.at_risk_subscriptions).toBe(1);
    expect(r.totals.paying).toBe(
      revenue.committed_subscriptions + revenue.at_risk_subscriptions,
    );
  });

  it("falls back to the database when Stripe is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(7)));
    expect(r.totals.paying).toBe(7);
    // And says so, so the email can label the count.
    expect(r.paying_source).toBe("database");
  });

  it("never reports zero payers just because Stripe failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(11)));
    expect(r.totals.paying).toBeGreaterThan(0);
  });
});

/**
 * engram#768: an account that paid once for a year holds no subscription,
 * so the count above never saw it and the report showed a customer who had
 * paid as nobody. The plans travel in a field of their own; totals.paying
 * stays the subscriber count the revenue line can be checked against, and
 * the email adds the two with `also_monthly` taken off.
 */
describe("daily report — prepaid plans", () => {
  it("reports them beside the subscriber count, which stays what Stripe says", async () => {
    vi.stubGlobal("fetch", mockStripe([{ customer: "cus_a" }, { customer: "cus_b" }]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID, [plan("org_p", "cus_p")])));
    expect(r.totals.paying).toBe(2);
    expect(r.annual).toEqual({
      plans: 1,
      also_monthly: 0,
      cents: 2700,
      by_offer: { "black-friday": 1 },
      next_end: "2027-11-18 10:03:28",
      other_currency_payments: 0,
    });
  });

  it("marks a plan holder who also subscribes as already counted, cancelling or not", async () => {
    // totals.paying counts a cancelling subscription, so its holder is
    // already in it; adding their plan would count them twice.
    vi.stubGlobal("fetch", mockStripe([
      { customer: "cus_a" },
      { customer: "cus_both" },
      { customer: "cus_leaving", cancelling: true },
    ]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID, [
      plan("org_p", "cus_p"),
      plan("org_no_customer", null),
      plan("org_both", "cus_both", 1),
      plan("org_leaving", "cus_leaving", 1),
    ])));
    expect(r.totals.paying).toBe(3);
    expect(r.annual.plans).toBe(4);
    expect(r.annual.also_monthly).toBe(2);
    // Five customers in all: the three subscribers, and the two plan
    // holders who are none of them.
    expect(r.totals.paying + r.annual.plans - r.annual.also_monthly).toBe(5);
  });

  it("does not take a leftover subscription id for a subscription when Stripe answered", async () => {
    // The column outlives the subscription. This account cancelled its
    // subscription and later bought the plan: one customer, through the plan.
    vi.stubGlobal("fetch", mockStripe([{ customer: "cus_a" }]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID, [plan("org_old", "cus_old", 1)])));
    expect(r.totals.paying).toBe(1);
    expect(r.annual.plans).toBe(1);
    expect(r.annual.also_monthly).toBe(0);
  });

  it("measures against the database's subscription ids when Stripe is unreachable", async () => {
    // totals.paying is then the count of rows with a subscription id, so a
    // plan holder with one is already in it.
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(7, [
      plan("org_p", "cus_p"),
      plan("org_both", "cus_both", 1),
    ])));
    expect(r.paying_source).toBe("database");
    expect(r.totals.paying).toBe(7);
    expect(r.annual.plans).toBe(2);
    expect(r.annual.also_monthly).toBe(1);
  });

  it("reports zeros when nobody is on a prepaid plan", async () => {
    vi.stubGlobal("fetch", mockStripe([{ customer: "cus_a" }]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID)));
    expect(r.annual).toEqual({
      plans: 0,
      also_monthly: 0,
      cents: 0,
      by_offer: {},
      next_end: null,
      other_currency_payments: 0,
    });
  });

  it("never sends a Stripe customer id in the report", async () => {
    vi.stubGlobal("fetch", mockStripe([{ customer: "cus_both" }]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID, [plan("org_both", "cus_both", 1)])));
    expect(JSON.stringify(r)).not.toMatch(/cus_/);
  });
});

/**
 * engram#569: a morning Stripe did not answer, the report printed
 * "Revenue: $0/mo committed from 0 customers" beside a paying count of 14.
 * The revenue read returned zeros on failure and the report could not tell
 * them from a real zero. A failed read must reach the email as "unavailable".
 */
describe("daily report — revenue when Stripe fails", () => {
  it("sends no revenue figures, and the reason, when Stripe does not answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(14)));
    expect(r.revenue).toBeNull();
    expect(r.revenue_unavailable).toMatch(/stripe down/);
  });

  it("sends no revenue figures when Stripe refuses the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const r = await buildDailyReport(env(mockDb(14)));
    expect(r.revenue).toBeNull();
    expect(r.revenue_unavailable).toMatch(/401/);
    expect(r.paying_source).toBe("database");
  });

  it("sends no revenue figures when there is no Stripe key", async () => {
    const r = await buildDailyReport({ DB: mockDb(14) } as unknown as Env);
    expect(r.revenue).toBeNull();
    expect(r.revenue_unavailable).toMatch(/STRIPE_SECRET_KEY/);
  });

  it("reports a real zero when Stripe answers with no subscriptions", async () => {
    // Stripe answering is authoritative, zero included: the D1 column
    // outlives subscriptions, so falling back here would inflate the count.
    vi.stubGlobal("fetch", mockStripe([]));
    const r = await buildDailyReport(env(mockDb(ORGS_WITH_SUB_ID)));
    expect(r.totals.paying).toBe(0);
    expect(r.paying_source).toBe("stripe");
    expect(r.revenue).toEqual({
      committed_cents: 0,
      committed_subscriptions: 0,
      at_risk_cents: 0,
      at_risk_subscriptions: 0,
      external_cents: 0,
    });
    expect(r.revenue_unavailable).toBeUndefined();
  });

  it("never sends the Stripe key in the report", async () => {
    const key = "sk_live_do_not_leak_0123456789";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    const r = await buildDailyReport({ DB: mockDb(1), STRIPE_SECRET_KEY: key } as unknown as Env);
    expect(JSON.stringify(r)).not.toContain(key);
  });
});
