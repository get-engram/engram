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

function mockDb(payingFallback: number) {
  let lastSql = "";
  const stmt = {
    bind: () => stmt,
    first: async () => {
      if (/stripe_subscription_id IS NOT NULL/.test(lastSql)) return { n: payingFallback };
      return { n: 0, id: "org_x" };
    },
    all: async () => ({ results: [] }),
  };
  return {
    prepare: (sql: string) => {
      lastSql = sql;
      // The fallback must exclude internal accounts; if a future edit drops
      // that clause this throws rather than silently inflating the number.
      if (/stripe_subscription_id IS NOT NULL/.test(sql) && !/!= 'internal'/.test(sql)) {
        throw new Error("paying fallback query lost its internal exclusion");
      }
      return stmt;
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
    expect(r.revenue.committed_subscriptions).toBe(2);
    expect(r.revenue.at_risk_subscriptions).toBe(1);
    expect(r.totals.paying).toBe(
      r.revenue.committed_subscriptions + r.revenue.at_risk_subscriptions,
    );
  });

  it("falls back to the database when Stripe is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(7)));
    // Zero subscriptions from Stripe means "unavailable", not "nobody pays".
    expect(r.totals.paying).toBe(7);
  });

  it("never reports zero payers just because Stripe failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("stripe down"); }));
    const r = await buildDailyReport(env(mockDb(11)));
    expect(r.totals.paying).toBeGreaterThan(0);
  });
});
