import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  loadSales,
  resetSalesCacheForTests,
  SALES_ERROR_BACKOFF_MS,
  SALES_TTL_MS,
} from "../services/sales.js";
import type { Env } from "../types.js";

/**
 * Total sales to date on the admin page (engram#768): every successful
 * payment in Stripe, after refunds, with the owner's own accounts left out.
 * It is a number the owner reads as "all the money that has come in", so
 * what counts, what does not, and what happens when Stripe or D1 fails are
 * all pinned here.
 */

const KEY = "sk_test_sales_never_in_output_0123";

/** Seconds since the epoch, for a charge's `created`. */
const at = (iso: string) => Date.parse(iso) / 1000;

interface DbState {
  internal: string[];
  fail: boolean;
}

function db(state: DbState): D1Database {
  return {
    prepare: () => ({
      all: async () => {
        if (state.fail) throw new Error("D1_ERROR: Requests queued for too long");
        return { results: state.internal.map((c) => ({ stripe_customer_id: c })) };
      },
    }),
  } as unknown as D1Database;
}

function env(opts: { key?: string | null; internal?: string[]; state?: DbState } = {}): Env {
  const state = opts.state ?? { internal: opts.internal ?? [], fail: false };
  return {
    DB: db(state),
    STRIPE_SECRET_KEY: opts.key === null ? undefined : (opts.key ?? KEY),
  } as unknown as Env;
}

let seq = 0;

function charge(
  customer: string | null,
  o: {
    cents?: number;
    refunded?: number;
    status?: "succeeded" | "failed" | "pending";
    paid?: boolean;
    currency?: string;
    disputed?: boolean;
    created?: number;
    id?: string;
  } = {},
) {
  const cents = o.cents ?? 900;
  const status = o.status ?? "succeeded";
  return {
    id: o.id ?? `ch_${++seq}`,
    object: "charge",
    status,
    paid: o.paid ?? status === "succeeded",
    currency: o.currency ?? "usd",
    amount: cents,
    // A failed charge on the real account still reports the amount it tried.
    amount_captured: cents,
    amount_refunded: o.refunded ?? 0,
    disputed: !!o.disputed,
    customer,
    created: o.created ?? at("2026-09-01T00:00:00Z"),
  };
}

function page(data: unknown[], has_more = false): Response {
  return new Response(JSON.stringify({ object: "list", data, has_more }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers each call with the next item; a string throws. */
function stripe(...answers: Array<Response | string>) {
  let i = 0;
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const a = answers[Math.min(i++, answers.length - 1)];
    if (typeof a === "string") throw new Error(a);
    return a.clone();
  });
}

beforeEach(() => {
  resetSalesCacheForTests();
  seq = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loadSales — figures", () => {
  it("adds up the successful payments of real customers, after refunds", async () => {
    vi.stubGlobal(
      "fetch",
      stripe(
        page([
          charge("cus_a", { created: at("2026-07-10T00:00:00Z") }),
          charge("cus_a", { created: at("2026-08-10T00:00:00Z") }),
          // A plan paid for once.
          charge("cus_b", { cents: 2700, created: at("2026-11-18T10:03:28Z") }),
          // Part of it went back.
          charge("cus_c", { refunded: 400, created: at("2026-07-05T00:00:00Z") }),
          // All of it went back: no sale, and not the first sale either.
          charge("cus_d", { refunded: 900, created: at("2026-06-20T00:00:00Z") }),
          // The card was declined.
          charge("cus_e", { status: "failed", created: at("2026-06-18T00:00:00Z") }),
          // The owner trying the checkout.
          charge("cus_owner", { cents: 3800, created: at("2026-06-17T07:08:29Z") }),
        ]),
      ),
    );

    const s = await loadSales(env({ internal: ["cus_owner"] }));
    expect(s).toEqual({
      available: true,
      external_cents: 900 + 900 + 2700 + 500,
      external_payments: 4,
      external_customers: 3,
      refunded_cents: 400 + 900,
      internal_cents: 3800,
      internal_payments: 1,
      first_paid_at: "2026-07-05T00:00:00.000Z",
      disputed_payments: 0,
      disputed_cents: 0,
      other_currency_payments: 0,
      computed_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
  });

  it("never counts the owner's own payments as sales", async () => {
    vi.stubGlobal("fetch", stripe(page([charge("cus_owner", { cents: 1500 }), charge("cus_owner", { cents: 2000 })])));
    const s = await loadSales(env({ internal: ["cus_owner"] }));
    expect(s.available).toBe(true);
    expect(s.external_cents).toBe(0);
    expect(s.external_payments).toBe(0);
    expect(s.external_customers).toBe(0);
    expect(s.first_paid_at).toBeNull();
    expect(s.internal_cents).toBe(3500);
    expect(s.internal_payments).toBe(2);
  });

  it("counts only charges Stripe marks succeeded and paid, whatever amount they carry", async () => {
    vi.stubGlobal(
      "fetch",
      stripe(
        page([
          charge("cus_a", { status: "failed" }),
          charge("cus_b", { status: "pending" }),
          charge("cus_c", { status: "succeeded", paid: false }),
          charge("cus_d"),
        ]),
      ),
    );
    const s = await loadSales(env());
    expect(s.external_cents).toBe(900);
    expect(s.external_payments).toBe(1);
    expect(s.external_customers).toBe(1);
  });

  it("counts a payment with no customer attached as a sale, without inventing a customer", async () => {
    vi.stubGlobal("fetch", stripe(page([charge(null, { cents: 500 }), charge("cus_a")])));
    const s = await loadSales(env());
    expect(s.external_cents).toBe(1400);
    expect(s.external_payments).toBe(2);
    expect(s.external_customers).toBe(1);
  });

  it("keeps a disputed payment in the total and reports it beside it", async () => {
    vi.stubGlobal("fetch", stripe(page([charge("cus_a"), charge("cus_b", { cents: 2700, disputed: true })])));
    const s = await loadSales(env());
    expect(s.external_cents).toBe(3600);
    expect(s.external_payments).toBe(2);
    expect(s.disputed_payments).toBe(1);
    expect(s.disputed_cents).toBe(2700);
  });

  it("keeps a payment in another currency out of the dollar figures and says so", async () => {
    vi.stubGlobal("fetch", stripe(page([charge("cus_a"), charge("cus_b", { cents: 2500, currency: "eur" })])));
    const s = await loadSales(env());
    expect(s.external_cents).toBe(900);
    expect(s.external_payments).toBe(1);
    expect(s.external_customers).toBe(1);
    expect(s.other_currency_payments).toBe(1);
  });

  it("reports a real zero when Stripe answers with no payments", async () => {
    vi.stubGlobal("fetch", stripe(page([])));
    const s = await loadSales(env());
    expect(s.available).toBe(true);
    expect(s.external_cents).toBe(0);
    expect(s.first_paid_at).toBeNull();
    expect(s.error).toBeUndefined();
  });

  it("asks for every charge, a full page at a time, with the key as a bearer token", async () => {
    const f = stripe(page([]));
    vi.stubGlobal("fetch", f);
    await loadSales(env());
    const url = new URL(f.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.stripe.com/v1/charges");
    expect([...url.searchParams.keys()]).toEqual(["limit"]);
    expect(url.searchParams.get("limit")).toBe("100");
    expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("loadSales — pages", () => {
  it("reads every page, continuing after the last charge even when that one failed", async () => {
    const f = stripe(
      page([charge("cus_a", { id: "ch_1" }), charge("cus_b", { id: "ch_2", status: "failed" })], true),
      page([charge("cus_c", { id: "ch_3" })], false),
    );
    vi.stubGlobal("fetch", f);
    const s = await loadSales(env());
    expect(s.available).toBe(true);
    expect(s.external_payments).toBe(2);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new URL(f.mock.calls[0][0]).searchParams.has("starting_after")).toBe(false);
    expect(new URL(f.mock.calls[1][0]).searchParams.get("starting_after")).toBe("ch_2");
  });

  it("is unavailable past its page cap, rather than a total of part of the list", async () => {
    let n = 0;
    const f = vi.fn(async () => page([charge("cus_a", { id: `ch_cap_${n++}` })], true));
    vi.stubGlobal("fetch", f);
    const s = await loadSales(env());
    expect(s.available).toBe(false);
    expect(s.error).toBe("more than 2000 payment attempts");
    expect(s.external_cents).toBe(0);
    expect(f).toHaveBeenCalledTimes(20);
  });

  it("is unavailable when a later page fails, rather than a total of part of the list", async () => {
    vi.stubGlobal("fetch", stripe(page([charge("cus_a")], true), "stripe down"));
    const s = await loadSales(env());
    expect(s.available).toBe(false);
    expect(s.external_cents).toBe(0);
    expect(s.external_payments).toBe(0);
  });
});

describe("loadSales — failures", () => {
  it("retries a 500 once", async () => {
    const f = stripe(new Response("oops", { status: 500 }), page([charge("cus_a")]));
    vi.stubGlobal("fetch", f);
    const s = await loadSales(env());
    expect(s.available).toBe(true);
    expect(s.external_payments).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("says so, with the reason and every figure zero, when the key may not read payments", async () => {
    const f = stripe(new Response('{"error":{}}', { status: 403 }));
    vi.stubGlobal("fetch", f);
    const s = await loadSales(env());
    expect(s).toEqual({
      available: false,
      error: "Stripe answered 403",
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
    });
    // A refusal is not retried.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is unavailable without a key, and does not call Stripe", async () => {
    const f = stripe(page([charge("cus_a")]));
    vi.stubGlobal("fetch", f);
    const s = await loadSales(env({ key: null }));
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/STRIPE_SECRET_KEY/);
    expect(f).not.toHaveBeenCalled();
  });

  it("is unavailable when the owner's accounts cannot be looked up", async () => {
    // Without the exclusion the owner's own payments would be reported as sales.
    vi.stubGlobal("fetch", stripe(page([charge("cus_owner", { cents: 3800 }), charge("cus_a")])));
    const s = await loadSales(env({ state: { internal: ["cus_owner"], fail: true } }));
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/^internal-account lookup failed/);
    expect(s.external_cents).toBe(0);
  });

  it("never puts the key in its result", async () => {
    vi.stubGlobal("fetch", stripe(new Response("{}", { status: 401 })));
    expect(JSON.stringify(await loadSales(env()))).not.toContain(KEY);
    vi.stubGlobal("fetch", stripe("boom", "boom"));
    expect(JSON.stringify(await loadSales(env()))).not.toContain(KEY);
  });
});

describe("loadSales — one read a minute", () => {
  const START = Date.parse("2026-11-18T12:00:00Z");

  beforeEach(() => {
    // Only the clock: the retry pause between two Stripe attempts stays real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
  });

  it("serves a read for a minute, then asks Stripe again", async () => {
    const f = stripe(page([charge("cus_a")]), page([charge("cus_a"), charge("cus_b")]));
    vi.stubGlobal("fetch", f);
    const e = env();

    const first = await loadSales(e);
    expect(first.computed_at).toBe("2026-11-18T12:00:00.000Z");

    vi.setSystemTime(START + SALES_TTL_MS - 1);
    expect(await loadSales(e)).toEqual(first);
    expect(f).toHaveBeenCalledTimes(1);

    vi.setSystemTime(START + SALES_TTL_MS);
    const next = await loadSales(e);
    expect(f).toHaveBeenCalledTimes(2);
    expect(next.external_payments).toBe(2);
    expect(next.computed_at).toBe("2026-11-18T12:01:00.000Z");
  });

  it("shares one read between requests that arrive together", async () => {
    const f = stripe(page([charge("cus_a")]));
    vi.stubGlobal("fetch", f);
    const e = env();
    const all = await Promise.all([loadSales(e), loadSales(e), loadSales(e)]);
    expect(f).toHaveBeenCalledTimes(1);
    for (const s of all) expect(s.external_payments).toBe(1);
  });

  it("serves the last good figures, with the time they were read, when Stripe stops answering", async () => {
    const f = stripe(
      page([charge("cus_a")]),
      "stripe down",
      "stripe down",
      page([charge("cus_a"), charge("cus_b")]),
    );
    vi.stubGlobal("fetch", f);
    const e = env();

    const good = await loadSales(e);

    vi.setSystemTime(START + SALES_TTL_MS);
    const stale = await loadSales(e);
    expect(stale).toEqual(good);
    expect(stale.available).toBe(true);
    expect(stale.computed_at).toBe("2026-11-18T12:00:00.000Z");
    expect(f).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("serving figures 60s old"));

    // Within the backoff Stripe is not asked again...
    vi.setSystemTime(START + SALES_TTL_MS + SALES_ERROR_BACKOFF_MS - 1);
    expect(await loadSales(e)).toEqual(good);
    expect(f).toHaveBeenCalledTimes(3);

    // ...and once it has passed, a recovered Stripe replaces the old figures.
    vi.setSystemTime(START + SALES_TTL_MS + SALES_ERROR_BACKOFF_MS);
    const fresh = await loadSales(e);
    expect(f).toHaveBeenCalledTimes(4);
    expect(fresh.external_payments).toBe(2);
  });

  it("serves the last good figures when the owner's accounts cannot be looked up", async () => {
    const state: DbState = { internal: ["cus_owner"], fail: false };
    vi.stubGlobal("fetch", stripe(page([charge("cus_owner", { cents: 3800 }), charge("cus_a")])));
    const e = env({ state });

    const good = await loadSales(e);
    expect(good.external_cents).toBe(900);

    state.fail = true;
    vi.setSystemTime(START + SALES_TTL_MS);
    const stale = await loadSales(e);
    expect(stale).toEqual(good);
    expect(stale.external_cents).toBe(900);
  });

  it("does not keep a failure when there is nothing to fall back on", async () => {
    const f = stripe(new Response("{}", { status: 403 }), page([charge("cus_a")]));
    vi.stubGlobal("fetch", f);
    const e = env();

    expect((await loadSales(e)).available).toBe(false);
    const next = await loadSales(e);
    expect(next.available).toBe(true);
    expect(next.external_payments).toBe(1);
  });
});
