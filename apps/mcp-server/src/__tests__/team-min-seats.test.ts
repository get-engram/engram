import { describe, it, expect } from "vitest";
import { TEAM_MIN_SEATS, resolvePlanPrice } from "../services/stripe.js";
import { createCheckoutSession } from "../services/stripe.js";
import { vi, beforeEach, afterEach } from "vitest";

/**
 * Team's two-seat minimum.
 *
 * Both Team subscriptions ever sold bought ONE seat — $27 for what Pro gave
 * at $9 plus webhooks — and one cancelled after four days. At $9/seat a
 * single-seat team would also undercut Pro outright. The floor has to hold in
 * BOTH places: the quantity we send, and the picker Stripe shows, because a
 * customer can otherwise turn it back down to 1 inside Checkout.
 */
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ id: "cs_1", url: "https://checkout" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const sentBody = () =>
  new URLSearchParams((fetchMock.mock.calls[0][1] as RequestInit).body as string);

describe("team seat minimum", () => {
  it("is 2 — one seat is Pro with extra steps", () => {
    expect(TEAM_MIN_SEATS).toBe(2);
  });

  it("floors the Stripe quantity PICKER so it cannot be turned down to 1", async () => {
    await createCheckoutSession("sk", {
      customerId: "cus_1",
      priceId: "price_team",
      quantity: TEAM_MIN_SEATS,
      adjustableQuantity: true,
      minQuantity: TEAM_MIN_SEATS,
      successUrl: "https://s",
      cancelUrl: "https://c",
      organizationId: "org_1",
    });
    const b = sentBody();
    expect(b.get("line_items[0][quantity]")).toBe("2");
    expect(b.get("line_items[0][adjustable_quantity][minimum]")).toBe("2");
  });

  it("leaves single-seat plans alone — Pro must still be buyable at 1", async () => {
    await createCheckoutSession("sk", {
      customerId: "cus_1",
      priceId: "price_pro",
      quantity: 1,
      successUrl: "https://s",
      cancelUrl: "https://c",
      organizationId: "org_1",
    });
    const b = sentBody();
    expect(b.get("line_items[0][quantity]")).toBe("1");
    expect(b.get("line_items[0][adjustable_quantity][enabled]")).toBeNull();
  });
});

describe("resolvePlanPrice — education pricing is applied, not requested", () => {
  const ENV = {
    STRIPE_PRICE_ID_PRO: "price_pro",
    STRIPE_PRICE_ID_TEAM: "price_team",
    STRIPE_PRICE_ID_STUDENT: "price_student",
    STRIPE_PRICE_ID_EDU_TEAM: "price_edu_team",
  };

  it("gives a verified academic org the education price on Team", () => {
    const r = resolvePlanPrice(ENV, "team", { academicallyVerified: true });
    expect(r.priceId).toBe("price_edu_team");
    expect(r.academic).toBe(true);
    expect(r.minSeats).toBe(2);
  });

  it("gives an unverified org the standard Team price", () => {
    const r = resolvePlanPrice(ENV, "team", { academicallyVerified: false });
    expect(r.priceId).toBe("price_team");
    expect(r.academic).toBe(false);
    expect(r.minSeats).toBe(2);
  });

  it("cannot be talked into the discount — only verification grants it", () => {
    // there is no caller-supplied "edu" plan to ask for
    expect(resolvePlanPrice(ENV, "team").priceId).toBe("price_team");
    expect(resolvePlanPrice(ENV, "pro", { academicallyVerified: true }).priceId).toBe("price_pro");
  });

  it("falls back to the standard price when no education price is configured", () => {
    const r = resolvePlanPrice({ ...ENV, STRIPE_PRICE_ID_EDU_TEAM: undefined }, "team", {
      academicallyVerified: true,
    });
    expect(r.priceId).toBe("price_team");
    expect(r.academic).toBe(false);
  });

  it("keeps single-seat plans at a floor of one", () => {
    expect(resolvePlanPrice(ENV, "pro").minSeats).toBe(1);
    expect(resolvePlanPrice(ENV, "student").minSeats).toBe(1);
  });
});
