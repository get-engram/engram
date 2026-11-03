import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { priceToTier } from "../services/stripe.js";
import { syncOrganizationFromStripe } from "../services/stripe-sync.js";
import type { Env } from "../types.js";

/**
 * The 10-minute reconcile cron had its own copy of the price->tier logic that
 * knew only about Team, so every other price fell through to "pro". A real
 * $3/month student subscriber was therefore rewritten from "student" to "pro"
 * within ten minutes of every correction, which is why the admin dashboard
 * never showed a student plan. These pin the single shared mapping.
 */
const ENV = {
  STRIPE_PRICE_ID_PRO: "price_pro",
  STRIPE_PRICE_ID_TEAM: "price_team",
  STRIPE_PRICE_ID_STUDENT: "price_student",
  STRIPE_SECRET_KEY: "sk_test",
};

describe("priceToTier", () => {
  it("maps every configured price, including student", () => {
    expect(priceToTier(ENV, "price_pro")).toBe("pro");
    expect(priceToTier(ENV, "price_team")).toBe("team");
    expect(priceToTier(ENV, "price_student")).toBe("student");
  });
  it("returns null rather than guessing for an unknown or missing price", () => {
    expect(priceToTier(ENV, "price_legacy")).toBeNull();
    expect(priceToTier(ENV, undefined)).toBeNull();
  });
});

function envWith(writes: Array<{ sql: string; args: unknown[] }>): Env {
  const db = {
    prepare: (sql: string) => {
      let args: unknown[] = [];
      const stmt = {
        bind: (...a: unknown[]) => {
          args = a;
          return stmt;
        },
        run: async () => {
          writes.push({ sql, args });
          return { success: true, meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { ...ENV, DB: db } as unknown as Env;
}

/**
 * What Stripe says about the one customer these tests use. The sync asks for
 * the customer before its subscriptions (engram#443) and only syncs from one
 * stamped for the org being synced.
 */
type CustomerAnswer = { ownedBy: string } | "unstamped" | "deleted" | "unknown" | "outage";

function stubStripe(priceId: string, customer: CustomerAnswer = { ownedBy: "org_1" }) {
  const urls: string[] = [];
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (/\/v1\/customers\//.test(url)) {
        if (customer === "unknown") return reply(404, { error: { message: "No such customer" } });
        if (customer === "outage") return reply(500, { error: { message: "upstream" } });
        if (customer === "deleted") return reply(200, { id: "cus_1", deleted: true });
        if (customer === "unstamped") return reply(200, { id: "cus_1", email: null, metadata: {} });
        return reply(200, {
          id: "cus_1",
          email: null,
          metadata: { organization_id: customer.ownedBy },
        });
      }
      return reply(200, {
        data: [
          {
            id: "sub_1",
            status: "active",
            items: { data: [{ quantity: 1, price: { id: priceId } }] },
            cancel_at_period_end: false,
            cancel_at: null,
            canceled_at: null,
          },
        ],
      });
    }),
  );
  return urls;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const tierOf = (writes: Array<{ sql: string; args: unknown[] }>) =>
  writes.find((w) => /UPDATE organizations SET tier/.test(w.sql))?.args[0];

describe("the reconcile cron and the student tier", () => {
  it("keeps a student subscriber on 'student' instead of rewriting them to pro", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_student");
    const res = await syncOrganizationFromStripe(envWith(writes), {
      id: "org_1",
      tier: "student",
      stripe_customer_id: "cus_1",
      grace_ends_at: null,
    });
    expect(res.tier).toBe("student");
    expect(tierOf(writes)).toBe("student");
  });

  it("promotes a student-priced subscriber whose tier drifted to pro back to student", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_student", { ownedBy: "org_drifted" });
    const res = await syncOrganizationFromStripe(envWith(writes), {
      id: "org_drifted",
      tier: "pro", // what the old cron left behind
      stripe_customer_id: "cus_1",
      grace_ends_at: null,
    });
    expect(res.tier).toBe("student");
  });

  it("still maps pro and team correctly", async () => {
    for (const [price, want] of [["price_pro", "pro"], ["price_team", "team"]] as const) {
      const writes: Array<{ sql: string; args: unknown[] }> = [];
      stubStripe(price, { ownedBy: "org_x" });
      const res = await syncOrganizationFromStripe(envWith(writes), {
        id: "org_x",
        tier: "free",
        stripe_customer_id: "cus_1",
        grace_ends_at: null,
      });
      expect(res.tier).toBe(want);
    }
  });

  it("never silently downgrades a paid tier on an UNKNOWN price", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_some_legacy_thing", { ownedBy: "org_legacy" });
    const res = await syncOrganizationFromStripe(envWith(writes), {
      id: "org_legacy",
      tier: "team",
      stripe_customer_id: "cus_1",
      grace_ends_at: null,
    });
    // keeps what they hold rather than guessing "pro"
    expect(res.tier).toBe("team");
  });

  it("still entitles a free org paying on an unrecognised price", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_some_legacy_thing", { ownedBy: "org_new" });
    const res = await syncOrganizationFromStripe(envWith(writes), {
      id: "org_new",
      tier: "free",
      stripe_customer_id: "cus_1",
      grace_ends_at: null,
    });
    expect(res.tier).toBe("pro");
  });
});

// ---------------------------------------------------------------------------
// Ownership of the cached customer (engram#443). The cron is the one path that
// runs unattended and fleet-wide, so it acts on positive evidence only: a
// customer stamped for another org is unlinked; one that is merely gone is
// reported and left for the org's next billing action.
// ---------------------------------------------------------------------------

const unlinkOf = (writes: Array<{ sql: string; args: unknown[] }>) =>
  writes.filter((w) =>
    /SET stripe_customer_id = NULL WHERE id = \? AND stripe_customer_id = \?/.test(w.sql),
  );

describe("the reconcile cron and customer ownership (engram#443)", () => {
  const org = { id: "org_1", tier: "free", stripe_customer_id: "cus_1", grace_ends_at: null };

  it("asks Stripe whose customer it is before reading its subscriptions", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const urls = stubStripe("price_pro", { ownedBy: "org_1" });
    const res = await syncOrganizationFromStripe(envWith(writes), org);
    expect(res.synced).toBe(true);
    expect(urls[0]).toBe("https://api.stripe.com/v1/customers/cus_1");
    expect(urls[1]).toMatch(/\/v1\/subscriptions\?customer=cus_1&/);
  });

  it("unlinks a customer stamped for another org and syncs nothing from it", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const urls = stubStripe("price_pro", { ownedBy: "org_victim" });
    const res = await syncOrganizationFromStripe(envWith(writes), org);
    expect(res).toMatchObject({ synced: false, reason: "foreign_customer", tier: "free" });
    expect(unlinkOf(writes).map((w) => w.args)).toEqual([["org_1", "cus_1"]]);
    expect(tierOf(writes)).toBeUndefined();
    expect(urls.some((u) => u.includes("/subscriptions"))).toBe(false);
  });

  it("leaves a vanished customer in place for the org's next billing action", async () => {
    for (const answer of ["unknown", "deleted"] as const) {
      const writes: Array<{ sql: string; args: unknown[] }> = [];
      stubStripe("price_pro", answer);
      const res = await syncOrganizationFromStripe(envWith(writes), org);
      expect(res, answer).toMatchObject({ synced: false, reason: "customer_missing" });
      expect(writes, answer).toHaveLength(0);
    }
  });

  it("treats a failed customer lookup as a Stripe error, not a verdict", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_pro", "outage");
    const res = await syncOrganizationFromStripe(envWith(writes), org);
    expect(res).toMatchObject({ synced: false, reason: "stripe_api_error" });
    expect(writes).toHaveLength(0);
  });

  it("tolerates an unstamped customer", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    stubStripe("price_pro", "unstamped");
    const res = await syncOrganizationFromStripe(envWith(writes), org);
    expect(res).toMatchObject({ synced: true, tier: "pro" });
    expect(unlinkOf(writes)).toHaveLength(0);
  });

  it("never asks Stripe for an enterprise org or one with nothing cached", async () => {
    const writes: Array<{ sql: string; args: unknown[] }> = [];
    const urls = stubStripe("price_pro", { ownedBy: "org_victim" });
    expect(
      await syncOrganizationFromStripe(envWith(writes), { ...org, tier: "enterprise" }),
    ).toMatchObject({ reason: "manual_tier" });
    expect(
      await syncOrganizationFromStripe(envWith(writes), { ...org, stripe_customer_id: null }),
    ).toMatchObject({ reason: "no_stripe_customer" });
    expect(urls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });
});
