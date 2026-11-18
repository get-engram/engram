import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import app from "../index.js";
import { billing } from "../routes/billing.js";
import { createCheckoutSession, createOrGetCustomer, createPortalSession } from "../services/stripe.js";
import { runBlackFridayCampaign, type CampaignResult } from "../services/black-friday-campaign.js";
import { BLACK_FRIDAY_CHECKOUT_NOTE, BLACK_FRIDAY_ENDS_AT_MS } from "../services/black-friday.js";
import { expireGracePeriods } from "../cron/expire-grace.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { AuthContext, Env } from "../types.js";

/**
 * Black Friday 2026 (engram#763), against real SQLite with the real
 * migrations: checkout from the emailed link, checkout when signed in, and
 * the email itself.
 */

vi.mock("../services/stripe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stripe.js")>();
  return {
    ...actual,
    // One Stripe customer per org, as in production.
    createOrGetCustomer: vi.fn(async (_key: string, email: string, orgId: string) => ({ id: `cus_${orgId}`, email })),
    createCheckoutSession: vi.fn(async () => ({ id: "cs_bf", url: "https://checkout.stripe.test/cs_bf" })),
    createPortalSession: vi.fn(async () => ({ id: "bps_1", url: "https://billing.stripe.test/bps_1" })),
  };
});

const KEY = "link-key-763-test";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
/** Ten days before the deadline: the offer is on sale. */
const DURING = BLACK_FRIDAY_ENDS_AT_MS - 10 * 86_400_000;
let clock = DURING;

const offerSig = (org: string) => createHmac("sha256", KEY).update(`offer:black-friday:${org}`).digest("hex");
const unsubscribeSig = (org: string) => createHmac("sha256", KEY).update(`digest:${org}`).digest("hex");

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

interface Mail {
  to: string;
  name: string | null;
  org_id: string;
  unsubscribe_url: string;
  offer_url: string;
  test?: boolean;
}

describe("Black Friday 2026 (engram#763), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  /** Emails engram-web was asked to send. */
  let mails: Mail[];
  /** What engram-web answers: a status, or "throw" for no answer at all. */
  let webAnswer: (mail: Mail) => number | "throw";
  /** Customers Stripe reports a live subscription for. */
  let subscribed: Set<string>;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "black-friday" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM campaign_sends"), db.prepare("DELETE FROM organizations")]);
    mails = [];
    webAnswer = () => 200;
    subscribed = new Set();
    vi.mocked(createCheckoutSession).mockClear();
    vi.mocked(createOrGetCustomer).mockClear();
    vi.mocked(createPortalSession).mockClear();
    // Each test starts two minutes after the last, so the per-account
    // throttle on the emailed link (kept in module memory) starts full.
    clock += 120_000;
    vi.spyOn(Date, "now").mockReturnValue(clock);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.origin === "https://api.stripe.com" && url.pathname === "/v1/subscriptions") {
          const live = subscribed.has(url.searchParams.get("customer") ?? "") && url.searchParams.get("status") === "active";
          return new Response(JSON.stringify({ data: live ? [{ id: "sub_1" }] : [] }), { status: 200 });
        }
        // A second try finds the customer saved by the first and re-reads it.
        const customer = /^\/v1\/customers\/cus_(.+)$/.exec(url.pathname);
        if (url.origin === "https://api.stripe.com" && customer) {
          return new Response(
            JSON.stringify({ id: `cus_${customer[1]}`, metadata: { organization_id: customer[1] } }),
            { status: 200 },
          );
        }
        if (url.origin === WEB && url.pathname === "/api/email/black-friday") {
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer web-bearer");
          const mail = JSON.parse(String(init?.body)) as Mail;
          const answer = webAnswer(mail);
          if (answer === "throw") throw new Error("connection reset");
          if (answer === 200) mails.push(mail);
          return new Response("{}", { status: answer });
        }
        throw new Error(`unexpected request to ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function env(over: Partial<Env> = {}): Env {
    return {
      ...createMockEnv(db),
      APP_URL: WEB,
      ADMIN_SECRET: "admin-test",
      INTERNAL_CRON_SECRET: "web-bearer",
      UNSUBSCRIBE_HMAC_KEY: KEY,
      STRIPE_SECRET_KEY: "sk_test_fake",
      STRIPE_PRICE_ID_PRO: "price_pro",
      STRIPE_PRICE_ID_TEAM: "price_team",
      STRIPE_PRICE_ID_PRO_YEAR_BF: "price_bf",
      ...over,
    } as unknown as Env;
  }

  /**
   * An org. Free, with an email, subscribed to email, unless told otherwise.
   * organizations.email is unique as typed, so one person's second account
   * can only differ in case or spacing; that is what the tests use.
   */
  async function org(
    id: string,
    o: { email?: string | null; tier?: string; optOut?: boolean; deleted?: boolean; source?: string; created?: string } = {},
  ) {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, email, tier, digest_opt_out, deleted_at, referral_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `Name ${id}`,
        o.email === undefined ? `${id}@example.test` : o.email,
        o.tier ?? "free",
        o.optOut ? 1 : 0,
        o.deleted ? "2026-11-01 00:00:00" : null,
        o.source ?? "chatgpt",
        o.created ?? "2026-10-01 00:00:00",
      )
      .run();
  }

  const sends = async () =>
    (
      await db
        .prepare("SELECT email, org_id, status FROM campaign_sends WHERE campaign = 'black-friday' ORDER BY email")
        .all<{ email: string; org_id: string; status: string }>()
    ).results;

  // -------------------------------------------------------------------------
  describe("POST /offers/black-friday/checkout, the emailed link", () => {
    async function take(body: unknown, e: Env = env()) {
      const res = await app.fetch(
        new Request(`${WORKER}/offers/black-friday/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
        e,
        ctx,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("starts a one-time $27 checkout for the account the link was signed for, without a sign-in", async () => {
      await org("org_a");
      const res = await take({ org: "org_a", sig: offerSig("org_a") });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: "https://checkout.stripe.test/cs_bf", session_id: "cs_bf", plan: "pro", offer: "black-friday" });
      expect(createCheckoutSession).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createCheckoutSession).mock.calls[0][1]).toEqual({
        customerId: "cus_org_a",
        priceId: "price_bf",
        quantity: undefined,
        adjustableQuantity: undefined,
        minQuantity: undefined,
        successUrl: `${WEB}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
        // Back from Stripe lands on the page with the same link, still usable.
        cancelUrl: `${WEB}/black-friday?org=org_a&sig=${offerSig("org_a")}&upgrade=cancelled`,
        organizationId: "org_a",
        expiresAt: undefined,
        allowPromotionCodes: false,
        offer: "black-friday",
        // One payment, not a subscription: nothing is left that can renew.
        mode: "payment",
        submitMessage: BLACK_FRIDAY_CHECKOUT_NOTE,
      });
      const row = await db.prepare("SELECT stripe_customer_id AS c, tier FROM organizations WHERE id = 'org_a'").first();
      // Starting a checkout grants nothing: the tier changes only on Stripe's webhook.
      expect(row).toEqual({ c: "cus_org_a", tier: "free" });
    });

    it("takes its return addresses from the server, never from the request", async () => {
      await org("org_a");
      await take({ org: "org_a", sig: offerSig("org_a"), success_url: "https://evil.example/ok", cancel_url: "https://evil.example/no" });
      const params = vi.mocked(createCheckoutSession).mock.calls[0][1];
      expect(params.successUrl.startsWith(WEB)).toBe(true);
      expect(params.cancelUrl.startsWith(WEB)).toBe(true);
    });

    it("expires the session at the deadline when started in the last day", async () => {
      await org("org_a");
      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS - 2 * 3_600_000);
      await take({ org: "org_a", sig: offerSig("org_a") });
      expect(vi.mocked(createCheckoutSession).mock.calls[0][1].expiresAt).toBe(BLACK_FRIDAY_ENDS_AT_MS / 1000);
    });

    it("refuses a link that is not signed for that account, and touches nothing", async () => {
      await org("org_a");
      await org("org_b");
      const refused = [
        { org: "org_a" },
        { org: "org_a", sig: "" },
        { org: "org_a", sig: offerSig("org_b") },
        // The account's own unsubscribe link is a different signature.
        { org: "org_a", sig: unsubscribeSig("org_a") },
        { sig: offerSig("org_a") },
        { org: ["org_a"], sig: offerSig("org_a") },
        "not an object",
      ];
      for (const body of refused) {
        const res = await take(body);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe("invalid_link");
      }
      expect(createOrGetCustomer).not.toHaveBeenCalled();
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("refuses once the deadline has passed, to the millisecond", async () => {
      await org("org_a");
      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS - 1);
      expect((await take({ org: "org_a", sig: offerSig("org_a") })).status).toBe(200);
      vi.mocked(createCheckoutSession).mockClear();

      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS);
      const res = await take({ org: "org_a", sig: offerSig("org_a") });
      expect(res.status).toBe(410);
      expect(res.body.error).toBe("offer_ended");
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("is not sold while the price is not configured", async () => {
      await org("org_a");
      const res = await take({ org: "org_a", sig: offerSig("org_a") }, env({ STRIPE_PRICE_ID_PRO_YEAR_BF: undefined }));
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("offer_unavailable");
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("does not sell a second plan to a paying account, or hand its billing portal to a link", async () => {
      await org("org_pro", { tier: "pro" });
      const paid = await take({ org: "org_pro", sig: offerSig("org_pro") });
      expect(paid.status).toBe(409);
      expect(paid.body.error).toBe("already_subscribed");
      expect(createOrGetCustomer).not.toHaveBeenCalled();

      // Free in our database, but Stripe already has a live subscription.
      await org("org_a");
      subscribed.add("cus_org_a");
      const live = await take({ org: "org_a", sig: offerSig("org_a") });
      expect(live.status).toBe(409);
      expect(live.body).not.toHaveProperty("url");
      expect(createPortalSession).not.toHaveBeenCalled();
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("answers 404 for a deleted account or one that never existed", async () => {
      await org("org_gone", { deleted: true });
      expect((await take({ org: "org_gone", sig: offerSig("org_gone") })).status).toBe(404);
      expect((await take({ org: "org_never", sig: offerSig("org_never") })).status).toBe(404);
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("allows five tries a minute per account, however many accounts share one address", async () => {
      // The website makes this call, so every buyer comes from its address.
      for (const id of ["org_a", "org_b", "org_c", "org_d", "org_e", "org_f", "org_g"]) await org(id);
      for (let i = 0; i < 5; i++) {
        expect((await take({ org: "org_a", sig: offerSig("org_a") })).status).toBe(200);
      }
      const sixth = await take({ org: "org_a", sig: offerSig("org_a") });
      expect(sixth.status).toBe(429);
      expect(sixth.body.error).toBe("rate_limited");
      expect(createCheckoutSession).toHaveBeenCalledTimes(5);
      for (const id of ["org_b", "org_c", "org_d", "org_e", "org_f", "org_g"]) {
        expect((await take({ org: id, sig: offerSig(id) })).status).toBe(200);
      }
      // A minute later the account can try again.
      vi.mocked(Date.now).mockReturnValue(clock + 60_000);
      expect((await take({ org: "org_a", sig: offerSig("org_a") })).status).toBe(200);
    });

    it("spends none of an account's tries on a bad signature", async () => {
      await org("org_a");
      for (let i = 0; i < 20; i++) {
        expect((await take({ org: "org_a", sig: "0".repeat(64) })).status).toBe(403);
      }
      expect((await take({ org: "org_a", sig: offerSig("org_a") })).status).toBe(200);
    });

    it("does nothing on a GET, which is what a mail scanner sends", async () => {
      await org("org_a");
      const res = await app.fetch(
        new Request(`${WORKER}/offers/black-friday/checkout?org=org_a&sig=${offerSig("org_a")}`),
        env(),
        ctx,
      );
      expect(res.status).toBe(404);
      expect(createOrGetCustomer).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /api/billing/checkout with the offer, signed in", () => {
    async function checkout(body: unknown, e: Env = env()) {
      const authed = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
      authed.use("*", async (c, next) => {
        c.set("auth", { organizationId: "org_a", apiKeyId: "key_a", tier: "free", scopes: ["read", "write", "search", "delete"] } as AuthContext);
        await next();
      });
      authed.route("/api/billing", billing);
      const res = await authed.request(
        "/api/billing/checkout",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
        e,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("sells the offer price, with no promotion codes", async () => {
      await org("org_a");
      const res = await checkout({ plan: "pro", offer: "black-friday" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ plan: "pro", offer: "black-friday", session_id: "cs_bf" });
      expect(vi.mocked(createCheckoutSession).mock.calls[0][1]).toMatchObject({
        priceId: "price_bf",
        allowPromotionCodes: false,
        offer: "black-friday",
        organizationId: "org_a",
        mode: "payment",
        submitMessage: BLACK_FRIDAY_CHECKOUT_NOTE,
      });
    });

    it("does not sell the year twice: an account already on a paid plan is refused before Stripe is asked", async () => {
      // Someone who bought the year has no subscription for the usual guard
      // to find, so the plan itself has to stop a second $27.
      await org("org_a", { tier: "pro" });
      const res = await checkout({ offer: "black-friday" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("already_subscribed");
      expect(createOrGetCustomer).not.toHaveBeenCalled();
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("sells Pro only: a team or student request with the offer still gets the offer price, one seat", async () => {
      await org("org_a");
      await checkout({ plan: "team", quantity: 9, offer: "black-friday" });
      expect(vi.mocked(createCheckoutSession).mock.calls[0][1]).toMatchObject({ priceId: "price_bf", quantity: undefined });
    });

    it("refuses after the deadline, and refuses an offer it does not know", async () => {
      await org("org_a");
      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS + 1000);
      const late = await checkout({ offer: "black-friday" });
      expect(late.status).toBe(410);
      expect(late.body.error).toBe("offer_ended");

      vi.spyOn(Date, "now").mockReturnValue(clock);
      const unknown = await checkout({ offer: "cyber-monday" });
      expect(unknown.status).toBe(400);
      expect(unknown.body.error).toBe("unknown_offer");
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("sends an owner who already subscribes to the billing portal", async () => {
      await org("org_a");
      subscribed.add("cus_org_a");
      const res = await checkout({ offer: "black-friday" });
      expect(res.body).toMatchObject({ already_subscribed: true, url: "https://billing.stripe.test/bps_1" });
      expect(createCheckoutSession).not.toHaveBeenCalled();
    });

    it("leaves regular Pro checkout as it was: the monthly price, promotion codes on, after the deadline too", async () => {
      await org("org_a");
      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS + 86_400_000);
      const res = await checkout({ plan: "pro" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: "https://checkout.stripe.test/cs_bf", session_id: "cs_bf", plan: "pro" });
      const params = vi.mocked(createCheckoutSession).mock.calls[0][1];
      expect(params).toMatchObject({ priceId: "price_pro", quantity: 1, cancelUrl: `${WEB}/pricing?upgrade=cancelled` });
      expect(params.allowPromotionCodes).toBeUndefined();
      expect(params.expiresAt).toBeUndefined();
      expect(params.offer).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("the payment: one year of Pro, and no renewal", () => {
    const WEBHOOK_SECRET = "whsec_bf_test";

    /** Deliver a Stripe event to the real webhook route, signed as Stripe signs. */
    async function deliver(id: string, type: string, object: Record<string, unknown>) {
      const raw = JSON.stringify({ id, type, data: { object } });
      const t = Math.floor(Date.now() / 1000);
      const v1 = createHmac("sha256", WEBHOOK_SECRET).update(`${t}.${raw}`).digest("hex");
      const res = await app.fetch(
        new Request(`${WORKER}/billing/webhook`, {
          method: "POST",
          headers: { "stripe-signature": `t=${t},v1=${v1}`, "Content-Type": "application/json" },
          body: raw,
        }),
        env({ STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET }),
        ctx,
      );
      return res.status;
    }

    /** A completed Checkout Session for the offer, paid unless told otherwise. */
    const paidSession = (orgId: string, over: Record<string, unknown> = {}) => ({
      id: `cs_${orgId}`,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      status: "complete",
      amount_total: 2700,
      currency: "usd",
      customer: `cus_${orgId}`,
      subscription: null,
      metadata: { organization_id: orgId, offer: "black-friday" },
      ...over,
    });

    const state = (id: string) =>
      db
        .prepare(
          `SELECT tier, stripe_subscription_id AS sub,
                  grace_ends_at > datetime('now', '+364 days') AND grace_ends_at <= datetime('now', '+366 days') AS a_year_out,
                  grace_ends_at AS until
             FROM organizations WHERE id = ?`,
        )
        .bind(id)
        .first<{ tier: string; sub: string | null; a_year_out: number | null; until: string | null }>();
    const plans = async () =>
      (
        await db
          .prepare("SELECT session_id, org_id, offer, tier, amount_total, currency, ends_at FROM prepaid_plans ORDER BY session_id")
          .all<Record<string, unknown>>()
      ).results;

    beforeEach(async () => {
      await db.batch([db.prepare("DELETE FROM prepaid_plans"), db.prepare("DELETE FROM stripe_webhook_events")]);
    });

    it("a paid session gives Pro until a year from now, with no subscription", async () => {
      await org("org_a");
      expect(await deliver("evt_1", "checkout.session.completed", paidSession("org_a"))).toBe(200);
      const after = await state("org_a");
      expect(after).toMatchObject({ tier: "pro", sub: null, a_year_out: 1 });
      expect(await plans()).toEqual([
        { session_id: "cs_org_a", org_id: "org_a", offer: "black-friday", tier: "pro", amount_total: 2700, currency: "usd", ends_at: after!.until },
      ]);
    });

    it("the same payment delivered again grants one year, and the end date does not move", async () => {
      await org("org_a");
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a"));
      // Move the end date back by hand: a second delivery must read the
      // recorded date, not start a fresh year.
      await db.batch([
        db.prepare("UPDATE prepaid_plans SET ends_at = '2027-06-01 00:00:00' WHERE session_id = 'cs_org_a'"),
        db.prepare("UPDATE organizations SET grace_ends_at = '2027-06-01 00:00:00' WHERE id = 'org_a'"),
      ]);
      // Stripe's own retry carries the same event id; a second event for the
      // same session (it sends more than one kind) carries a new one.
      expect(await deliver("evt_1", "checkout.session.completed", paidSession("org_a"))).toBe(200);
      expect(await deliver("evt_2", "checkout.session.completed", paidSession("org_a"))).toBe(200);
      expect(await plans()).toHaveLength(1);
      expect(await state("org_a")).toMatchObject({ tier: "pro", until: "2027-06-01 00:00:00" });
    });

    it("grants nothing until the money is in", async () => {
      await org("org_a");
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a", { payment_status: "unpaid" }));
      expect(await state("org_a")).toMatchObject({ tier: "free", until: null });
      expect(await plans()).toEqual([]);
    });

    it("grants nothing for a session that is not this offer's single payment", async () => {
      await org("org_a");
      await org("org_b");
      // A regular subscription checkout: its plan comes from the subscription events.
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a", { mode: "subscription", metadata: { organization_id: "org_a" } }));
      // A single payment for something else.
      await deliver("evt_2", "checkout.session.completed", paidSession("org_b", { metadata: { organization_id: "org_b", offer: "something-else" } }));
      expect(await state("org_a")).toMatchObject({ tier: "free", until: null });
      expect(await state("org_b")).toMatchObject({ tier: "free", until: null });
      expect(await plans()).toEqual([]);
    });

    it("leaves a Team or Student account's plan alone, and a deleted or unknown account untouched", async () => {
      await org("org_team", { tier: "team" });
      await org("org_student", { tier: "student" });
      await org("org_gone", { deleted: true });
      for (const id of ["org_team", "org_student", "org_gone", "org_never"]) {
        expect(await deliver(`evt_${id}`, "checkout.session.completed", paidSession(id))).toBe(200);
      }
      expect(await state("org_team")).toMatchObject({ tier: "team", until: null });
      expect(await state("org_student")).toMatchObject({ tier: "student", until: null });
      expect(await state("org_gone")).toMatchObject({ tier: "free", until: null });
      expect(await plans()).toEqual([]);
    });

    it("never shortens a later end date already on the account", async () => {
      await org("org_a");
      await db.prepare("UPDATE organizations SET tier = 'pro', grace_ends_at = '2126-01-01 00:00:00' WHERE id = 'org_a'").run();
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a"));
      expect(await state("org_a")).toMatchObject({ tier: "pro", until: "2126-01-01 00:00:00" });
      expect(await plans()).toHaveLength(1);
    });

    it("a stray cancellation event during the year does not take Pro away", async () => {
      await org("org_a");
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a"));
      // 200 also says no "your plan was cancelled" email was attempted for
      // someone who paid: the fetch stub throws on any request it does not
      // expect, and the webhook would answer 500.
      expect(
        await deliver("evt_2", "customer.subscription.deleted", {
          id: "sub_old",
          status: "canceled",
          customer: "cus_org_a",
          metadata: { organization_id: "org_a" },
          items: { data: [{ price: { id: "price_pro" }, quantity: 1 }] },
        }),
      ).toBe(200);
      expect(await state("org_a")).toMatchObject({ tier: "pro", a_year_out: 1 });
    });

    it("when the year is over the account goes back to Free and is told its paid year ended", async () => {
      await org("org_a");
      await org("org_gift");
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a"));
      // A year later. org_gift was given Pro by an admin and never paid.
      await db.batch([
        db.prepare("UPDATE prepaid_plans SET ends_at = datetime('now', '-1 minute')"),
        db.prepare("UPDATE organizations SET grace_ends_at = datetime('now', '-1 minute') WHERE id = 'org_a'"),
        db.prepare("UPDATE organizations SET tier = 'pro', grace_ends_at = datetime('now', '-1 minute') WHERE id = 'org_gift'"),
      ]);
      const told: Array<Record<string, unknown>> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          expect(String(input)).toBe(`${WEB}/api/email/payment-reminder`);
          told.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
          return new Response("{}", { status: 200 });
        }),
      );
      expect(await expireGracePeriods(env())).toBe(2);
      expect(await state("org_a")).toMatchObject({ tier: "free", until: null, sub: null });
      expect(await state("org_gift")).toMatchObject({ tier: "free", until: null });
      expect(told.sort((a, b) => String(a.to).localeCompare(String(b.to)))).toEqual([
        { to: "org_a@example.test", name: "Name org_a", tier: "pro", reason: "prepaid_ended" },
        { to: "org_gift@example.test", name: "Name org_gift", tier: "pro" },
      ]);
      // Nothing is left that could charge or re-grant: the next run finds nobody.
      expect(await expireGracePeriods(env())).toBe(0);
    });

    it("the year is not ended early: an account still inside it is left on Pro", async () => {
      await org("org_a");
      await deliver("evt_1", "checkout.session.completed", paidSession("org_a"));
      expect(await expireGracePeriods(env())).toBe(0);
      expect(await state("org_a")).toMatchObject({ tier: "pro", a_year_out: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("the email", () => {
    const run = async (opts: Parameters<typeof runBlackFridayCampaign>[1], e: Env = env()) =>
      runBlackFridayCampaign(e, opts);
    const ok = (r: Awaited<ReturnType<typeof run>>) => {
      if ("error" in r) throw new Error(`campaign refused: ${r.error}`);
      return r as CampaignResult;
    };

    /** Two accounts that should get it, and one of every kind that should not. */
    async function everyone() {
      await org("org_a", { email: "ann@example.test", created: "2026-10-01 00:00:00" });
      // Ann's second account: same address, typed differently.
      await org("org_a2", { email: " Ann@Example.test ", created: "2026-10-02 00:00:00" });
      await org("org_j", { email: "jo@example.test", created: "2026-10-03 00:00:00" });
      await org("org_out", { email: "out@example.test", optOut: true });
      // Same person as the one who unsubscribed, on an account that did not.
      await org("org_out2", { email: "OUT@example.test" });
      // Unsubscribed, then deleted the account, then signed up again.
      await org("org_left", { email: "left@example.test", optOut: true, deleted: true });
      await org("org_back", { email: "Left@example.test" });
      await org("org_internal", { email: "team@example.test", source: "internal" });
      await org("org_deleted", { email: "gone@example.test", deleted: true });
      await org("org_pro", { email: "pro@example.test", tier: "pro" });
      await org("org_student", { email: "student@example.test", tier: "student" });
      // A customer's second, free account.
      await org("org_pro_free", { email: "Pro@example.test" });
      await org("org_noemail", { email: null });
      await org("org_blank", { email: "  " });
    }

    it("a dry run counts who is owed the email and sends nothing", async () => {
      await everyone();
      const r = ok(await run({ dryRun: true }));
      expect(r).toEqual({ dry_run: true, owed: 2, sent: 0, skipped: 0, failed: 0, stopped: false, recorded: {} });
      expect(mails).toEqual([]);
      expect(await sends()).toEqual([]);
    });

    it("goes once to each free account's address, and to nobody else", async () => {
      await everyone();
      const r = ok(await run({ limit: 50 }));
      expect(r).toMatchObject({ dry_run: false, owed: 2, sent: 2, failed: 0, stopped: false, recorded: { sent: 2 } });
      expect(mails.map((m) => [m.to, m.org_id, m.name])).toEqual([
        ["ann@example.test", "org_a", "Name org_a"],
        ["jo@example.test", "org_j", "Name org_j"],
      ]);
      expect(mails.every((m) => m.test === undefined)).toBe(true);
      expect(await sends()).toEqual([
        { email: "ann@example.test", org_id: "org_a", status: "sent" },
        { email: "jo@example.test", org_id: "org_j", status: "sent" },
      ]);
    });

    it("carries a working unsubscribe link and an offer link signed for that account", async () => {
      await org("org_a");
      ok(await run({}));
      const [mail] = mails;
      expect(mail.unsubscribe_url).toBe(
        `https://mcp.getengram.app/email/unsubscribe?org=org_a&sig=${unsubscribeSig("org_a")}`,
      );
      const offer = new URL(mail.offer_url);
      expect(offer.origin + offer.pathname).toBe(`${WEB}/black-friday`);
      expect(Object.fromEntries(offer.searchParams)).toEqual({
        org: "org_a",
        sig: offerSig("org_a"),
        utm_source: "email",
        utm_campaign: "blackfriday",
      });
    });

    it("never sends twice: a second run, and a run after someone was added, send only what is new", async () => {
      await everyone();
      ok(await run({ limit: 50 }));
      const again = ok(await run({ limit: 50 }));
      expect(again).toMatchObject({ owed: 0, sent: 0, skipped: 0 });
      expect(mails).toHaveLength(2);

      await org("org_new", { email: "new@example.test" });
      // And one more account for an address that already has the email.
      await org("org_a3", { email: "ANN@example.test" });
      const third = ok(await run({ limit: 50 }));
      expect(third).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.to)).toEqual(["ann@example.test", "jo@example.test", "new@example.test"]);
    });

    it("sends at most the batch size, oldest accounts first, and the next batch carries on", async () => {
      for (let i = 1; i <= 5; i++) await org(`org_${i}`, { created: `2026-10-0${i} 00:00:00` });
      expect(ok(await run({ limit: 2 }))).toMatchObject({ owed: 5, sent: 2 });
      expect(ok(await run({ limit: 2 }))).toMatchObject({ owed: 3, sent: 2 });
      expect(ok(await run({ limit: 2 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2", "org_3", "org_4", "org_5"]);
    });

    it("caps a batch at 50 and treats a silly limit as 1", async () => {
      for (let i = 0; i < 53; i++) await org(`org_${String(i).padStart(2, "0")}`);
      expect(ok(await run({ limit: 5000 })).sent).toBe(50);
      expect(ok(await run({ limit: -4 })).sent).toBe(1);
    });

    it("skips an address a concurrent batch already claimed", async () => {
      await org("org_a");
      await org("org_j");
      // The other batch claims org_a's address after this one has selected it.
      const realPrepare = db.prepare.bind(db);
      let raced = false;
      const racing = {
        ...env(),
        DB: new Proxy(db, {
          get(target, prop) {
            if (prop !== "prepare") return Reflect.get(target, prop);
            return (sql: string) => {
              const stmt = realPrepare(sql);
              if (!raced && sql.includes("ORDER BY o.created_at")) {
                raced = true;
                return new Proxy(stmt, {
                  get(s, p) {
                    if (p !== "bind") return Reflect.get(s, p);
                    return (...args: unknown[]) => {
                      const bound = s.bind(...args);
                      return new Proxy(bound, {
                        get(b, q) {
                          if (q !== "all") return Reflect.get(b, q);
                          return async () => {
                            const rows = await b.all();
                            await realPrepare(
                              "INSERT INTO campaign_sends (campaign, email, org_id) VALUES ('black-friday', 'org_a@example.test', 'org_a')",
                            ).run();
                            return rows;
                          };
                        },
                      });
                    };
                  },
                });
              }
              return stmt;
            };
          },
        }),
      } as unknown as Env;
      const r = ok(await run({ limit: 50 }, racing));
      expect(r).toMatchObject({ sent: 1, skipped: 1, failed: 0 });
      expect(mails.map((m) => m.to)).toEqual(["org_j@example.test"]);
    });

    it("releases the claim when engram-web refuses before sending, so a later batch retries", async () => {
      await org("org_a");
      webAnswer = () => 401;
      const refused = ok(await run({}));
      expect(refused).toMatchObject({ sent: 0, failed: 1, recorded: {} });
      expect(await sends()).toEqual([]);

      webAnswer = () => 200;
      expect(ok(await run({}))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails).toHaveLength(1);
    });

    it("keeps the claim when there is no clear answer, because the email may have gone out", async () => {
      await org("org_a", { created: "2026-10-01 00:00:00" });
      await org("org_j", { created: "2026-10-02 00:00:00" });
      webAnswer = (m) => (m.org_id === "org_a" ? 500 : "throw");
      const r = ok(await run({}));
      expect(r).toMatchObject({ sent: 0, failed: 2, recorded: { unknown: 2 } });

      webAnswer = () => 200;
      expect(ok(await run({}))).toMatchObject({ owed: 0, sent: 0 });
      expect(mails).toEqual([]);
    });

    it("stops a batch after three failures in a row", async () => {
      for (let i = 1; i <= 6; i++) await org(`org_${i}`, { created: `2026-10-0${i} 00:00:00` });
      let asked = 0;
      webAnswer = () => {
        asked++;
        return 503;
      };
      const r = ok(await run({ limit: 50 }));
      expect(r).toMatchObject({ sent: 0, failed: 3, stopped: true });
      expect(asked).toBe(3);
    });

    it("a failure between successes does not stop the batch", async () => {
      for (let i = 1; i <= 5; i++) await org(`org_${i}`, { created: `2026-10-0${i} 00:00:00` });
      webAnswer = (m) => (["org_2", "org_4"].includes(m.org_id) ? 500 : 200);
      expect(ok(await run({ limit: 50 }))).toMatchObject({ sent: 3, failed: 2, stopped: false });
    });

    it("a test goes to the given address with the test account's link, and records nothing", async () => {
      await everyone();
      const r = ok(await run({ testTo: "owner@example.test", testOrg: "org_internal" }));
      expect(r).toMatchObject({ sent: 1, owed: 2, recorded: {} });
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: "owner@example.test", org_id: "org_internal", name: "Name org_internal", test: true });
      expect(new URL(mails[0].offer_url).searchParams.get("sig")).toBe(offerSig("org_internal"));
      expect(await sends()).toEqual([]);
      // The real send is untouched by it.
      expect(ok(await run({ limit: 50 })).sent).toBe(2);
    });

    it("a test needs both an address and an account", async () => {
      await org("org_a");
      expect(await run({ testTo: "owner@example.test" })).toMatchObject({ error: "bad_request" });
      expect(await run({ testOrg: "org_a" })).toMatchObject({ error: "bad_request" });
      expect(await run({ testTo: "owner@example.test", testOrg: "org_never" })).toMatchObject({ error: "organization_not_found" });
      expect(mails).toEqual([]);
    });

    it("sends nothing once the offer has ended, or while it cannot be bought, or without a link key", async () => {
      await org("org_a");
      vi.spyOn(Date, "now").mockReturnValue(BLACK_FRIDAY_ENDS_AT_MS);
      expect(await run({})).toMatchObject({ error: "offer_ended", status: 410 });
      vi.spyOn(Date, "now").mockReturnValue(clock);
      expect(await run({}, env({ STRIPE_PRICE_ID_PRO_YEAR_BF: undefined }))).toMatchObject({ error: "offer_unavailable" });
      expect(await run({}, env({ UNSUBSCRIBE_HMAC_KEY: undefined, ADMIN_SECRET: undefined, INTERNAL_CRON_SECRET: "web-bearer" }))).toMatchObject({
        error: "mail_not_configured",
      });
      expect(mails).toEqual([]);
      expect(await sends()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("POST /admin/campaigns/black-friday", () => {
    async function admin(body: unknown, bearer = "admin-test") {
      const res = await app.fetch(
        new Request(`${WORKER}/admin/campaigns/black-friday`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }),
        env(),
        ctx,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("needs the admin secret", async () => {
      await org("org_a");
      expect((await admin({ send: true }, "wrong")).status).toBe(401);
      expect(mails).toEqual([]);
    });

    it("sends nothing for an empty, mistyped or ambiguous body", async () => {
      await org("org_a");
      for (const body of [{}, "", "{", { limit: 50 }, { send: "true" }, { dry_run: 1 }, { send: true, dry_run: true }, { send: true, test_to: "x@example.test", test_org: "org_a" }]) {
        const res = await admin(body);
        expect(res.status).toBe(400);
      }
      expect(mails).toEqual([]);
      expect(await sends()).toEqual([]);
    });

    it("counts on dry_run, sends a batch on send, and one copy on a test", async () => {
      await org("org_a");
      await org("org_j");
      expect((await admin({ dry_run: true })).body).toMatchObject({ dry_run: true, owed: 2, sent: 0 });
      expect((await admin({ test_to: "owner@example.test", test_org: "org_a" })).body).toMatchObject({ sent: 1, owed: 2 });
      expect((await admin({ test_to: "owner@example.test" })).status).toBe(400);
      expect((await admin({ send: true, limit: 1 })).body).toMatchObject({ sent: 1, owed: 2 });
      expect((await admin({ send: true })).body).toMatchObject({ sent: 1, owed: 1 });
      expect(mails.map((m) => m.to)).toEqual(["owner@example.test", "org_a@example.test", "org_j@example.test"]);
    });
  });
});
