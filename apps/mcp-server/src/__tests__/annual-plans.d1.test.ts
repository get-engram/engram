import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import { admin } from "../routes/admin.js";
import {
  annualPlansStatement,
  holdsSubscription,
  summarizeAnnualPlans,
  type AnnualPlanRow,
} from "../services/annual-plans.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * Prepaid plans in the admin figures (engram#768), against real SQLite with
 * the real migrations: which purchases count as a paying customer, how an
 * account that also subscribes is kept from being counted twice, and what
 * GET /admin/users says about each account.
 */

interface OrgSeed {
  tier?: string;
  customer?: string;
  subscription?: string;
  internal?: boolean;
  deleted?: boolean;
}

interface PlanSeed {
  /** A SQLite datetime modifier from now: "+300 days", "-1 minute". */
  ends?: string;
  cents?: number | null;
  currency?: string | null;
  tier?: string;
  offer?: string;
}

/** One line per plan step, as EXPLAIN QUERY PLAN prints them. */
async function planOf(db: D1Database, sql: string): Promise<string[]> {
  const params = (sql.match(/\?/g) ?? []).map(() => 1);
  const { results } = await db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...params)
    .all<{ detail: string }>();
  return results.map((r) => r.detail);
}

/** The same database, remembering every statement prepared on it. */
function recording(db: D1Database): { db: D1Database; sql: string[] } {
  const sql: string[] = [];
  const wrapped = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (query: string) => {
          sql.push(query);
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped, sql };
}

describe("prepaid plans in the admin figures (engram#768), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "annual-plans" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await db.batch([db.prepare("DELETE FROM prepaid_plans"), db.prepare("DELETE FROM organizations")]);
  });

  async function org(id: string, o: OrgSeed = {}): Promise<void> {
    await db
      .prepare(
        `INSERT INTO organizations (id, name, tier, stripe_customer_id, stripe_subscription_id, referral_source, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ${o.deleted ? "datetime('now')" : "NULL"})`,
      )
      .bind(id, id, o.tier ?? "pro", o.customer ?? null, o.subscription ?? null, o.internal ? "internal" : null)
      .run();
  }

  async function plan(session: string, orgId: string, p: PlanSeed = {}): Promise<void> {
    await db
      .prepare(
        `INSERT INTO prepaid_plans (session_id, org_id, offer, tier, amount_total, currency, ends_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))`,
      )
      .bind(
        session,
        orgId,
        p.offer ?? "black-friday",
        p.tier ?? "pro",
        p.cents === undefined ? 2700 : p.cents,
        p.currency === undefined ? "usd" : p.currency,
        p.ends ?? "+300 days",
      )
      .run();
  }

  async function rows(): Promise<AnnualPlanRow[]> {
    return (await annualPlansStatement(db).all<AnnualPlanRow>()).results;
  }

  const nobody = () => false;

  describe("which plans count", () => {
    it("counts an account on a plan that has not run out", async () => {
      await org("org_a", { customer: "cus_a" });
      await plan("cs_a", "org_a");

      const found = await rows();
      expect(found).toEqual([
        {
          org_id: "org_a",
          stripe_customer_id: "cus_a",
          has_subscription_id: 0,
          offer: "black-friday",
          amount_total: 2700,
          currency: "usd",
          ends_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        },
      ]);
      expect(summarizeAnnualPlans(found, nobody)).toEqual({
        plans: 1,
        also_monthly: 0,
        cents: 2700,
        by_offer: { "black-friday": 1 },
        next_end: found[0].ends_at,
        other_currency_payments: 0,
      });
    });

    it("leaves out a plan that has run out", async () => {
      await org("org_a");
      await plan("cs_a", "org_a", { ends: "-1 minute" });
      expect(await rows()).toEqual([]);
    });

    it("leaves out a deleted account", async () => {
      await org("org_a", { deleted: true });
      await plan("cs_a", "org_a");
      expect(await rows()).toEqual([]);
    });

    it("leaves out the owner's own accounts", async () => {
      await org("org_owner", { internal: true });
      await plan("cs_owner", "org_owner");
      expect(await rows()).toEqual([]);
    });

    it("leaves out an account that is no longer on the plan it bought", async () => {
      // Set back to Free after a refund, and moved to Team on a subscription.
      await org("org_refunded", { tier: "free" });
      await plan("cs_refunded", "org_refunded");
      await org("org_team", { tier: "team", customer: "cus_team", subscription: "sub_team" });
      await plan("cs_team", "org_team");
      expect(await rows()).toEqual([]);
    });

    it("leaves out a plan whose account no longer exists", async () => {
      await plan("cs_orphan", "org_gone");
      expect(await rows()).toEqual([]);
    });

    it("reports nothing at all when no plan has been sold", async () => {
      await org("org_a");
      expect(summarizeAnnualPlans(await rows(), nobody)).toEqual({
        plans: 0,
        also_monthly: 0,
        cents: 0,
        by_offer: {},
        next_end: null,
        other_currency_payments: 0,
      });
    });
  });

  describe("adding them up", () => {
    it("counts an account that bought twice once, with both payments and its later end date", async () => {
      await org("org_twice");
      await plan("cs_first", "org_twice", { ends: "+100 days" });
      await plan("cs_second", "org_twice", { ends: "+200 days" });
      await org("org_once");
      await plan("cs_once", "org_once", { ends: "+150 days" });

      const found = await rows();
      expect(found.map((r) => r.org_id)).toEqual(["org_twice", "org_once", "org_twice"]);
      const summary = summarizeAnnualPlans(found, nobody);
      expect(summary.plans).toBe(2);
      expect(summary.cents).toBe(3 * 2700);
      expect(summary.by_offer).toEqual({ "black-friday": 2 });
      // org_twice is covered until its second plan ends, so the first
      // account to come off a plan is org_once.
      expect(summary.next_end).toBe(found[1].ends_at);
    });

    it("keeps a payment in another currency out of the dollar figure and says so", async () => {
      await org("org_usd");
      await plan("cs_usd", "org_usd");
      await org("org_eur");
      await plan("cs_eur", "org_eur", { currency: "eur", cents: 2500 });

      const summary = summarizeAnnualPlans(await rows(), nobody);
      expect(summary.plans).toBe(2);
      expect(summary.cents).toBe(2700);
      expect(summary.other_currency_payments).toBe(1);
    });

    it("reads a payment recorded without a currency or an amount as usd, adding nothing it does not know", async () => {
      await org("org_bare");
      await plan("cs_bare", "org_bare", { currency: null, cents: null });

      const found = await rows();
      expect(found[0]).toMatchObject({ amount_total: null, currency: null });
      expect(summarizeAnnualPlans(found, nobody)).toMatchObject({
        plans: 1,
        cents: 0,
        other_currency_payments: 0,
      });
    });

    it("names the offer each account bought", async () => {
      await org("org_bf");
      await plan("cs_bf", "org_bf");
      await org("org_other");
      await plan("cs_other", "org_other", { offer: "spring-sale" });
      expect(summarizeAnnualPlans(await rows(), nobody).by_offer).toEqual({
        "black-friday": 1,
        "spring-sale": 1,
      });
    });
  });

  describe("an account that also subscribes is counted once", () => {
    beforeEach(async () => {
      await org("org_plan_only", { customer: "cus_plan_only" });
      await plan("cs_plan_only", "org_plan_only");
      await org("org_both", { customer: "cus_both", subscription: "sub_both" });
      await plan("cs_both", "org_both");
      // No Stripe customer on the row: it cannot be among Stripe's subscribers.
      await org("org_no_customer");
      await plan("cs_no_customer", "org_no_customer");
    });

    it("against Stripe's subscribers, by Stripe customer", async () => {
      const summary = summarizeAnnualPlans(
        await rows(),
        holdsSubscription(new Set(["cus_both", "cus_someone_else"])),
      );
      expect(summary.plans).toBe(3);
      expect(summary.also_monthly).toBe(1);
      // What a caller adds to its subscriber count.
      expect(summary.plans - summary.also_monthly).toBe(2);
    });

    it("counts nobody twice when no plan holder subscribes", async () => {
      const summary = summarizeAnnualPlans(await rows(), holdsSubscription(new Set(["cus_someone_else"])));
      expect(summary.also_monthly).toBe(0);
    });

    it("against the database's subscription ids, when Stripe did not answer", async () => {
      const summary = summarizeAnnualPlans(await rows(), (r) => r.has_subscription_id === 1);
      expect(summary.plans).toBe(3);
      expect(summary.also_monthly).toBe(1);
    });

    it("counts an account with two plans and a subscription once", async () => {
      await plan("cs_both_again", "org_both", { ends: "+320 days" });
      const summary = summarizeAnnualPlans(await rows(), holdsSubscription(new Set(["cus_both"])));
      expect(summary.plans).toBe(3);
      expect(summary.also_monthly).toBe(1);
    });
  });

  describe("the query plan", () => {
    it("starts from the purchases and looks each account up by its primary key", async () => {
      const recorded = recording(db);
      annualPlansStatement(recorded.db);
      const steps = await planOf(db, recorded.sql[0]);
      expect(steps.join(" | ")).toMatch(/SCAN p\b/);
      expect(steps.join(" | ")).toMatch(/SEARCH o USING INDEX sqlite_autoindex_organizations_1 \(id=\?\)/);
      expect(steps.filter((s) => /^SCAN o\b/.test(s))).toEqual([]);
    });
  });

  describe("GET /admin/users", () => {
    function app(database: D1Database) {
      const a = new Hono<{ Bindings: Env }>();
      a.route("/admin", admin);
      const env = createMockEnv(database) as unknown as Env;
      return (query = "") => a.request(`/admin/users${query}`, { method: "GET" }, env);
    }

    interface UsersBody {
      users: Array<{ id: string; tier: string; annual_ends_at: string | null }>;
      total: number;
    }

    it("says when each account's prepaid plan ends, and nothing for everyone else", async () => {
      await org("org_plan");
      await plan("cs_plan_1", "org_plan", { ends: "+100 days" });
      await plan("cs_plan_2", "org_plan", { ends: "+200 days" });
      await org("org_subscriber", { customer: "cus_s", subscription: "sub_s" });
      await org("org_expired");
      await plan("cs_expired", "org_expired", { ends: "-1 day" });
      await org("org_refunded", { tier: "free" });
      await plan("cs_refunded", "org_refunded");

      const res = await app(db)("?limit=50");
      expect(res.status).toBe(200);
      const body = (await res.json()) as UsersBody;
      expect(body.total).toBe(4);
      const ends = Object.fromEntries(body.users.map((u) => [u.id, u.annual_ends_at]));

      const later = await db
        .prepare("SELECT ends_at FROM prepaid_plans WHERE session_id = 'cs_plan_2'")
        .first<{ ends_at: string }>();
      expect(ends).toEqual({
        org_plan: later!.ends_at,
        org_subscriber: null,
        org_expired: null,
        org_refunded: null,
      });
    });

    it("reads each account's plans through the index on the account, never the whole table", async () => {
      const recorded = recording(db);
      expect((await app(recorded.db)()).status).toBe(200);
      const users = recorded.sql.find((s) => /annual_ends_at/.test(s));
      expect(users, "no users statement").toBeDefined();
      const steps = await planOf(db, users!);
      expect(steps.join(" | ")).toMatch(/SEARCH p USING INDEX idx_prepaid_plans_org \(org_id=\?\)/);
      expect(steps.filter((s) => /^SCAN p\b/.test(s))).toEqual([]);
    });
  });
});
