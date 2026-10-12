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

function stubStripe(priceId: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
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
      }),
    }),
  );
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
    stubStripe("price_student");
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
      stubStripe(price);
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
    stubStripe("price_some_legacy_thing");
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
    stubStripe("price_some_legacy_thing");
    const res = await syncOrganizationFromStripe(envWith(writes), {
      id: "org_new",
      tier: "free",
      stripe_customer_id: "cus_1",
      grace_ends_at: null,
    });
    expect(res.tier).toBe("pro");
  });
});
