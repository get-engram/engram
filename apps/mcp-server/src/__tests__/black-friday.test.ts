import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import {
  BLACK_FRIDAY,
  BLACK_FRIDAY_ENDS_AT_MS,
  blackFridayState,
  offerSessionExpiry,
} from "../services/black-friday.js";
import { createCheckoutSession, createRecurringPrice, priceToTier } from "../services/stripe.js";
import { offerSig, offerSigValid, unsubscribeSig } from "../services/secrets.js";
import type { Env } from "../types.js";

/**
 * Black Friday 2026 (engram#763): Pro for $27 a year until 00:00 Eastern on
 * November 28. The pieces with no database: the deadline, the Checkout
 * Session's expiry, the price's tier, the signed link and what is sent to
 * Stripe.
 */

const ENV = { STRIPE_PRICE_ID_PRO: "price_pro", STRIPE_PRICE_ID_TEAM: "price_team", STRIPE_PRICE_ID_PRO_ANNUAL_BF: "price_bf" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the deadline", () => {
  it("is midnight Eastern at the start of Saturday November 28, 2026", () => {
    expect(new Date(BLACK_FRIDAY_ENDS_AT_MS).toISOString()).toBe("2026-11-28T05:00:00.000Z");
    const eastern = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date(BLACK_FRIDAY_ENDS_AT_MS));
    expect(eastern).toBe("Saturday, November 28, 2026 at 12:00:00 AM EST");
  });

  it("sells the offer up to the last millisecond, and not at the deadline or after", () => {
    expect(blackFridayState(ENV, BLACK_FRIDAY_ENDS_AT_MS - 1)).toEqual({ open: true, priceId: "price_bf" });
    expect(blackFridayState(ENV, BLACK_FRIDAY_ENDS_AT_MS)).toEqual({ open: false, reason: "offer_ended" });
    expect(blackFridayState(ENV, BLACK_FRIDAY_ENDS_AT_MS + 86_400_000)).toEqual({ open: false, reason: "offer_ended" });
  });

  it("does not sell it while the price is not configured", () => {
    const before = BLACK_FRIDAY_ENDS_AT_MS - 86_400_000;
    expect(blackFridayState({}, before)).toEqual({ open: false, reason: "offer_unavailable" });
    expect(blackFridayState({ STRIPE_PRICE_ID_PRO_ANNUAL_BF: "" }, before)).toEqual({ open: false, reason: "offer_unavailable" });
  });
});

describe("the Checkout Session's expiry", () => {
  const deadlineSec = BLACK_FRIDAY_ENDS_AT_MS / 1000;

  it("keeps Stripe's own 24 hours while the deadline is further away than that", () => {
    expect(offerSessionExpiry(BLACK_FRIDAY_ENDS_AT_MS - 3 * 86_400_000)).toBeUndefined();
    expect(offerSessionExpiry(BLACK_FRIDAY_ENDS_AT_MS - 86_400_000)).toBeUndefined();
  });

  it("expires at the deadline for a session started in the last day", () => {
    expect(offerSessionExpiry(BLACK_FRIDAY_ENDS_AT_MS - 12 * 3_600_000)).toBe(deadlineSec);
    expect(offerSessionExpiry(BLACK_FRIDAY_ENDS_AT_MS - 40 * 60_000)).toBe(deadlineSec);
  });

  it("never asks Stripe for less than its 30-minute minimum", () => {
    const now = BLACK_FRIDAY_ENDS_AT_MS - 10 * 60_000;
    const expiry = offerSessionExpiry(now)!;
    expect(expiry - now / 1000).toBeGreaterThanOrEqual(30 * 60);
    expect(expiry - now / 1000).toBeLessThanOrEqual(35 * 60);
  });

  it("always falls inside Stripe's 30 minutes to 24 hours", () => {
    for (let minutes = 1; minutes <= 3 * 24 * 60; minutes += 7) {
      const now = BLACK_FRIDAY_ENDS_AT_MS - minutes * 60_000;
      const expiry = offerSessionExpiry(now);
      if (expiry === undefined) continue;
      const ahead = expiry - now / 1000;
      expect(ahead).toBeGreaterThan(30 * 60);
      expect(ahead).toBeLessThan(24 * 60 * 60);
    }
  });
});

describe("the offer price's tier", () => {
  it("grants Pro, so the webhook and the sync do not leave a buyer on Free", () => {
    expect(priceToTier(ENV, "price_bf")).toBe("pro");
  });

  it("grants nothing for an unset price id", () => {
    const unset = { STRIPE_PRICE_ID_PRO: "price_pro", STRIPE_PRICE_ID_TEAM: "price_team" };
    expect(priceToTier(unset, undefined)).toBeNull();
    expect(priceToTier(unset, "price_bf")).toBeNull();
  });
});

describe("the signed offer link", () => {
  const env = { UNSUBSCRIBE_HMAC_KEY: "link-key-763" } as unknown as Env;
  const expected = (org: string) => createHmac("sha256", "link-key-763").update(`offer:black-friday:${org}`).digest("hex");

  it("signs the offer and the org with the link key", async () => {
    expect(await offerSig(env, BLACK_FRIDAY, "org_a")).toBe(expected("org_a"));
    expect(await offerSigValid(env, BLACK_FRIDAY, "org_a", expected("org_a"))).toBe(true);
  });

  it("is for one org and one offer", async () => {
    expect(await offerSigValid(env, BLACK_FRIDAY, "org_b", expected("org_a"))).toBe(false);
    expect(await offerSigValid(env, "another-offer", "org_a", expected("org_a"))).toBe(false);
  });

  it("is not interchangeable with the org's unsubscribe link", async () => {
    const unsubscribe = await unsubscribeSig("org_a", "link-key-763");
    expect(await offerSigValid(env, BLACK_FRIDAY, "org_a", unsubscribe)).toBe(false);
  });

  it("refuses anything that is not 64 hex characters, and everything without a key", async () => {
    for (const bad of ["", "abc", expected("org_a").toUpperCase(), `${expected("org_a")}0`]) {
      expect(await offerSigValid(env, BLACK_FRIDAY, "org_a", bad)).toBe(false);
    }
    const noKey = {} as unknown as Env;
    expect(await offerSig(noKey, BLACK_FRIDAY, "org_a")).toBeNull();
    expect(await offerSigValid(noKey, BLACK_FRIDAY, "org_a", expected("org_a"))).toBe(false);
  });
});

describe("what is sent to Stripe", () => {
  /** Every Stripe call's path and form fields. */
  function stripe() {
    const calls: Array<{ path: string; form: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          path: new URL(url).pathname,
          form: Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))),
        });
        return new Response(JSON.stringify({ id: "obj_1", url: "https://checkout.stripe.test/s" }), { status: 200 });
      }),
    );
    return calls;
  }

  const session = { customerId: "cus_1", priceId: "price_bf", successUrl: "https://a/ok", cancelUrl: "https://a/no", organizationId: "org_a" };

  it("an offer session carries its expiry and its name, and takes no promotion codes", async () => {
    const calls = stripe();
    await createCheckoutSession("sk", { ...session, expiresAt: 1795755600, allowPromotionCodes: false, offer: BLACK_FRIDAY });
    expect(calls).toHaveLength(1);
    const form = calls[0].form;
    expect(form.expires_at).toBe("1795755600");
    expect(form["metadata[offer]"]).toBe("black-friday");
    expect(form["subscription_data[metadata][offer]"]).toBe("black-friday");
    expect(form).not.toHaveProperty("allow_promotion_codes");
    expect(form["line_items[0][price]"]).toBe("price_bf");
    expect(form["metadata[organization_id]"]).toBe("org_a");
  });

  it("a regular session is unchanged: promotion codes on, no expiry, no offer", async () => {
    const calls = stripe();
    await createCheckoutSession("sk", session);
    const form = calls[0].form;
    expect(form.allow_promotion_codes).toBe("true");
    expect(form).not.toHaveProperty("expires_at");
    expect(form).not.toHaveProperty("metadata[offer]");
  });

  it("a yearly price on an existing product creates no new product", async () => {
    const calls = stripe();
    await createRecurringPrice("sk", {
      productId: "prod_pro",
      productName: "Engram Pro",
      productDescription: "",
      tier: "pro",
      unitAmount: 2700,
      interval: "year",
      lookupKey: "pro_annual_bf2026",
      nickname: "Pro annual, Black Friday 2026",
    });
    expect(calls.map((c) => c.path)).toEqual(["/v1/prices"]);
    expect(calls[0].form).toMatchObject({
      product: "prod_pro",
      unit_amount: "2700",
      currency: "usd",
      "recurring[interval]": "year",
      lookup_key: "pro_annual_bf2026",
      "metadata[tier]": "pro",
    });
  });

  it("a price with no interval is still monthly, on a product of its own", async () => {
    const calls = stripe();
    await createRecurringPrice("sk", {
      productName: "Engram Student",
      productDescription: "d",
      tier: "student",
      unitAmount: 300,
      lookupKey: "student_monthly",
      nickname: "Student monthly",
    });
    expect(calls.map((c) => c.path)).toEqual(["/v1/products", "/v1/prices"]);
    expect(calls[1].form["recurring[interval]"]).toBe("month");
  });
});
