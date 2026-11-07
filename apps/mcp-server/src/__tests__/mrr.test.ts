import { describe, it, expect, vi, afterEach } from "vitest";
import { computeMrr } from "../services/mrr.js";
import type { Env } from "../types.js";

/**
 * computeMrr feeds the daily report and the admin dashboard. It used to
 * read one page of subscriptions with no timeout and no retry, and to
 * return zeros on any failure — which the daily report printed as "$0/mo
 * committed from 0 customers" (engram#569). It now says whether Stripe
 * answered, retries a transient failure once, and reads every page.
 */

const KEY = "sk_test_mrr_never_in_output_0123";

function db(internal: string[] = [], fail = false): D1Database {
  return {
    prepare: () => ({
      all: async () => {
        if (fail) throw new Error("D1_ERROR: Requests queued for too long");
        return { results: internal.map((c) => ({ stripe_customer_id: c })) };
      },
    }),
  } as unknown as D1Database;
}

function env(opts: { key?: string | null; internal?: string[]; dbFails?: boolean } = {}): Env {
  return {
    DB: db(opts.internal, opts.dbFails),
    STRIPE_SECRET_KEY: opts.key === null ? undefined : (opts.key ?? KEY),
  } as unknown as Env;
}

function sub(
  id: string,
  customer: string,
  o: { cents?: number; interval?: string; cancelling?: boolean; cancelAt?: number } = {},
) {
  return {
    id,
    customer,
    cancel_at_period_end: !!o.cancelling,
    cancel_at: o.cancelAt ?? null,
    items: {
      data: [{ quantity: 1, price: { unit_amount: o.cents ?? 900, recurring: { interval: o.interval ?? "month" } } }],
    },
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

afterEach(() => vi.unstubAllGlobals());

describe("computeMrr — figures", () => {
  it("sums subscriptions, leaves the owner's accounts out, and normalizes yearly plans", async () => {
    vi.stubGlobal("fetch", stripe(page([
      sub("sub_1", "cus_a"),
      sub("sub_2", "cus_b", { cancelling: true }),
      sub("sub_3", "cus_c", { cents: 9600, interval: "year" }),
      sub("sub_4", "cus_owner"),
    ])));
    const m = await computeMrr(env({ internal: ["cus_owner"] }));
    expect(m).toEqual({
      available: true,
      total_cents: 900 + 900 + 800 + 900,
      external_cents: 900 + 900 + 800,
      subscriptions: 4,
      external_subscriptions: 3,
      at_risk_cents: 900,
      at_risk_subscriptions: 1,
    });
  });

  it("counts a scheduled cancel_at as at risk", async () => {
    vi.stubGlobal("fetch", stripe(page([sub("sub_1", "cus_a", { cancelAt: 1_900_000_000 })])));
    const m = await computeMrr(env());
    expect(m.at_risk_subscriptions).toBe(1);
  });

  it("reports a real zero when Stripe answers with no subscriptions", async () => {
    vi.stubGlobal("fetch", stripe(page([])));
    const m = await computeMrr(env());
    expect(m.available).toBe(true);
    expect(m.external_subscriptions).toBe(0);
  });

  it("asks for active subscriptions, a full page at a time, with the key as a bearer token", async () => {
    const f = stripe(page([]));
    vi.stubGlobal("fetch", f);
    await computeMrr(env());
    const url = new URL(f.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe("https://api.stripe.com/v1/subscriptions");
    expect(url.searchParams.get("status")).toBe("active");
    expect(url.searchParams.get("limit")).toBe("100");
    expect(new Headers(f.mock.calls[0][1]?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(f.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("computeMrr — pages", () => {
  it("reads every page, continuing after the last id", async () => {
    const f = stripe(
      page([sub("sub_1", "cus_a"), sub("sub_2", "cus_b")], true),
      page([sub("sub_3", "cus_c")], false),
    );
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m.available).toBe(true);
    expect(m.external_subscriptions).toBe(3);
    expect(f).toHaveBeenCalledTimes(2);
    expect(new URL(f.mock.calls[0][0]).searchParams.has("starting_after")).toBe(false);
    expect(new URL(f.mock.calls[1][0]).searchParams.get("starting_after")).toBe("sub_2");
  });

  it("stops on an empty page even if it claims more", async () => {
    const f = stripe(page([], true));
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m.available).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("gives up past its page cap instead of looping", async () => {
    let n = 0;
    const f = vi.fn(async () => page([sub(`sub_${n++}`, "cus_a")], true));
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m.available).toBe(false);
    expect(m.error).toMatch(/more than 2000/);
    expect(f).toHaveBeenCalledTimes(20);
  });
});

describe("computeMrr — failures", () => {
  it("retries a 500 once", async () => {
    const f = stripe(new Response("oops", { status: 500 }), page([sub("sub_1", "cus_a")]));
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m.available).toBe(true);
    expect(m.external_subscriptions).toBe(1);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 once", async () => {
    const f = stripe(new Response("slow down", { status: 429 }), page([sub("sub_1", "cus_a")]));
    vi.stubGlobal("fetch", f);
    expect((await computeMrr(env())).available).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries a request that never got an answer", async () => {
    const f = stripe("The operation was aborted due to timeout", page([sub("sub_1", "cus_a")]));
    vi.stubGlobal("fetch", f);
    expect((await computeMrr(env())).available).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not retry a refusal", async () => {
    const f = stripe(new Response('{"error":{}}', { status: 401 }));
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m.available).toBe(false);
    expect(m.error).toBe("Stripe answered 401");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is unavailable after a second failure, with every figure zero and the reason", async () => {
    const f = stripe("stripe down", "stripe down");
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env());
    expect(m).toEqual({
      available: false,
      error: "Stripe request failed: stripe down",
      total_cents: 0,
      external_cents: 0,
      subscriptions: 0,
      external_subscriptions: 0,
      at_risk_cents: 0,
      at_risk_subscriptions: 0,
    });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("is unavailable when a later page fails, rather than counting part of the list", async () => {
    vi.stubGlobal("fetch", stripe(page([sub("sub_1", "cus_a")], true), "stripe down"));
    const m = await computeMrr(env());
    expect(m.available).toBe(false);
    expect(m.external_subscriptions).toBe(0);
  });

  it("is unavailable without a key, and does not call Stripe", async () => {
    const f = stripe(page([]));
    vi.stubGlobal("fetch", f);
    const m = await computeMrr(env({ key: null }));
    expect(m.available).toBe(false);
    expect(m.error).toMatch(/STRIPE_SECRET_KEY/);
    expect(f).not.toHaveBeenCalled();
  });

  it("is unavailable when the owner's accounts cannot be looked up", async () => {
    // Without the exclusion every figure would count the owner as a customer.
    vi.stubGlobal("fetch", stripe(page([sub("sub_1", "cus_owner")])));
    const m = await computeMrr(env({ internal: ["cus_owner"], dbFails: true }));
    expect(m.available).toBe(false);
    expect(m.error).toMatch(/^internal-account lookup failed/);
    expect(m.external_subscriptions).toBe(0);
  });

  it("never puts the key in its result", async () => {
    vi.stubGlobal("fetch", stripe(new Response("{}", { status: 401 })));
    expect(JSON.stringify(await computeMrr(env()))).not.toContain(KEY);
    vi.stubGlobal("fetch", stripe("boom", "boom"));
    expect(JSON.stringify(await computeMrr(env()))).not.toContain(KEY);
  });
});
