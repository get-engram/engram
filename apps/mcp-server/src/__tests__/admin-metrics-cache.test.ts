import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { admin } from "../routes/admin.js";
import {
  resetAdminMetricsCacheForTests,
  SLOW_METRICS_TTL_MS,
  SLOW_METRICS_ERROR_BACKOFF_MS,
} from "../services/admin-metrics.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * GET /admin/metrics after engram#551: the cheap figures reach D1 as one
 * batch, the activation funnel + chunk count come from a ten-minute cache
 * that serves its last good figures when D1 refuses the recompute, and the
 * JSON shape the admin page / daily report / stats skill read is unchanged.
 * engram#768 added two fields beside `mrr`: `annual` and `sales`.
 */

const MRR = { total_cents: 900, external_cents: 0, at_risk_cents: 0, customers: 1 };
vi.mock("../services/mrr.js", () => ({
  readSubscriptions: vi.fn(async () => ({
    mrr: MRR,
    // cus_both subscribes and is staying; cus_leaving subscribes and is
    // scheduled to cancel, so the page's monthly count has dropped it.
    externalCustomers: new Set(["cus_both", "cus_leaving"]),
    committedCustomers: new Set(["cus_both"]),
  })),
}));

const SALES = {
  available: true,
  external_cents: 12_300,
  external_payments: 9,
  external_customers: 5,
  refunded_cents: 900,
  internal_cents: 1_800,
  internal_payments: 1,
  first_paid_at: "2026-07-01T00:00:00.000Z",
  disputed_payments: 0,
  disputed_cents: 0,
  other_currency_payments: 0,
  computed_at: "2026-11-18T12:00:00.000Z",
};
vi.mock("../services/sales.js", () => ({
  loadSales: vi.fn(async () => SALES),
}));

/** One running prepaid plan, as services/annual-plans.ts reads it. */
const plan = (org: string, customer: string, hasSubscriptionId: number, ends: string) => ({
  org_id: org,
  stripe_customer_id: customer,
  has_subscription_id: hasSubscriptionId,
  offer: "black-friday",
  amount_total: 2700,
  currency: "usd",
  ends_at: ends,
});

type Stmt = { sql: string; bind: () => Stmt };

interface DbState {
  total: number;
  funnelRuns: number;
  failFunnel: boolean;
  log: string[];
  inFlight: number;
  maxInFlight: number;
}

function state(): DbState {
  return { total: 10, funnelRuns: 0, failFunnel: false, log: [], inFlight: 0, maxInFlight: 0 };
}

/**
 * A D1 stand-in that only speaks batch(): records every statement, counts
 * how many requests are in flight at once, and can refuse the funnel the way
 * an overloaded D1 does (the whole batch rejects).
 */
function fakeDb(st: DbState): D1Database {
  const rowsFor = (sql: string): unknown[] => {
    if (/AS connected/.test(sql)) {
      if (st.failFunnel) throw new Error("D1_ERROR: Requests queued for too long");
      st.funnelRuns++;
      return [
        {
          connected: 8 + st.funnelRuns,
          first_memory_saved: 5,
          first_search: 4,
          first_successful_recall: 3,
          second_session: 2,
          returned_after_7_days: 1,
        },
      ];
    }
    if (/FROM conversation_chunks/.test(sql)) return [{ chunks: 1_054_509 }];
    if (/FROM prepaid_plans/.test(sql)) {
      return [
        plan("org_plan", "cus_plan", 0, "2027-11-18 10:03:28"),
        plan("org_both", "cus_both", 1, "2027-11-20 08:00:00"),
        plan("org_leaving", "cus_leaving", 1, "2027-11-21 08:00:00"),
      ];
    }
    if (/COUNT\(\*\) as total/.test(sql)) return [{ total: st.total, last_1d: 1, last_7d: 3, last_30d: 7 }];
    if (/as active\b/.test(sql)) return [{ active: 4 }];
    if (/GROUP BY tier/.test(sql)) return [{ tier: "free", count: 8 }, { tier: "pro", count: 2 }];
    if (/as conversations/.test(sql)) return [{ conversations: 100, messages: 5000 }];
    if (/FROM api_keys/.test(sql)) return [{ api_keys: 12 }];
    if (/GROUP BY referral_source/.test(sql)) return [{ source: "claude", count: 6 }, { source: "unknown", count: 4 }];
    if (/ORDER BY created_at DESC/.test(sql)) {
      return [{ id: "org_1", name: "Ada", email: null, tier: "free", referral_source: "claude", created_at: "2026-11-05T12:00:00Z" }];
    }
    throw new Error(`unexpected statement: ${sql.trim().slice(0, 60)}`);
  };

  const db = {
    prepare(sql: string): Stmt {
      const s: Stmt = { sql, bind: () => s };
      return s;
    },
    async batch(stmts: Stmt[]) {
      st.inFlight++;
      st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
      await new Promise((r) => setTimeout(r, 2));
      try {
        return stmts.map((s) => {
          st.log.push(s.sql);
          return { results: rowsFor(s.sql), success: true, meta: {} };
        });
      } finally {
        st.inFlight--;
      }
    },
  };
  return db as unknown as D1Database;
}

function app(db: D1Database) {
  const a = new Hono<{ Bindings: Env }>();
  a.route("/admin", admin);
  const env = createMockEnv(db) as unknown as Env;
  return () => a.request("/admin/metrics", { method: "GET" }, env);
}

const funnelAttempts = (st: DbState) => st.log.filter((s) => /AS connected/.test(s)).length;

interface MetricsBody {
  mrr: typeof MRR;
  annual: {
    plans: number;
    also_monthly: number;
    cents: number;
    by_offer: Record<string, number>;
    next_end: string | null;
    other_currency_payments: number;
  };
  sales: typeof SALES;
  signups: { total: number; last_1d: number; last_7d: number; last_30d: number };
  active_users_30d: number;
  activation: Record<string, number>;
  activation_computed_at: string;
  tiers: Record<string, number>;
  referrals: Record<string, number>;
  storage: { conversations: number; messages: number; chunks: number; api_keys: number };
  today_signups: Array<Record<string, unknown>>;
}
const body = async (res: Response) => (await res.json()) as MetricsBody;

describe("GET /admin/metrics (engram#551)", () => {
  let t: number;

  beforeEach(() => {
    resetAdminMetricsCacheForTests();
    t = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the response shape, with one D1 request in flight at a time", async () => {
    const st = state();
    const call = app(fakeDb(st));

    const res = await call();
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data).toMatchObject({
      mrr: MRR,
      signups: { total: 10, last_1d: 1, last_7d: 3, last_30d: 7 },
      active_users_30d: 4,
      activation: {
        connected: 9,
        first_memory_saved: 5,
        first_search: 4,
        first_successful_recall: 3,
        second_session: 2,
        returned_after_7_days: 1,
      },
      tiers: { free: 8, pro: 2 },
      referrals: { claude: 6, unknown: 4 },
      storage: { conversations: 100, messages: 5000, chunks: 1_054_509, api_keys: 12 },
      today_signups: [{ id: "org_1", referral_source: "claude" }],
    });
    expect(typeof data.activation_computed_at).toBe("string");

    // Eight cheap statements in one batch, then the two expensive ones in
    // another — never the old eight parallel requests.
    expect(st.log).toHaveLength(10);
    expect(st.maxInFlight).toBe(1);
  });

  it("reports prepaid plans beside MRR, marking the accounts the monthly count already holds (engram#768)", async () => {
    const st = state();
    const data = await body(await app(fakeDb(st))());

    expect(data.annual).toEqual({
      plans: 3,
      // org_both only. org_leaving's subscription is scheduled to cancel, so
      // the page's monthly count no longer holds it and its plan is what
      // makes it a paying customer.
      also_monthly: 1,
      cents: 3 * 2700,
      by_offer: { "black-friday": 3 },
      next_end: "2027-11-18 10:03:28",
      other_currency_payments: 0,
    });
    // Money paid once stays out of the recurring figure.
    expect(data.mrr).toEqual(MRR);
    // The plans ride in the cheap batch: no request of their own.
    expect(st.log.filter((s) => /FROM prepaid_plans/.test(s))).toHaveLength(1);
    expect(st.maxInFlight).toBe(1);
  });

  it("reports total sales to date as the sales reader gives them (engram#768)", async () => {
    const data = await body(await app(fakeDb(state()))());
    expect(data.sales).toEqual(SALES);
  });

  it("keeps Stripe customer ids inside the worker", async () => {
    const res = await app(fakeDb(state()))();
    expect(await res.text()).not.toMatch(/cus_/);
  });

  it("keeps the funnel one scan of organizations with per-org index probes (engram#553)", async () => {
    const st = state();
    await app(fakeDb(st))();
    const funnel = st.log.find((s) => /AS connected/.test(s)) ?? "";
    expect(funnel).not.toBe("");
    // The whole-table form (audit_log JOIN organizations, COUNT(DISTINCT …),
    // GROUP BY … HAVING) read 5.5M rows and held D1 for 2–13 s per run. Every
    // audit_log subquery must stay correlated on o.id so the
    // (organization_id, …) indexes answer it per org.
    expect(funnel).toMatch(/FROM organizations o\s+WHERE o\.deleted_at IS NULL/);
    expect(funnel).not.toMatch(/JOIN organizations/);
    expect(funnel).not.toMatch(/COUNT\(DISTINCT/);
    expect(funnel).not.toMatch(/GROUP BY/);
    const probes = funnel.match(/FROM audit_log a\s+WHERE a\.organization_id = o\.id/g) ?? [];
    expect(probes.length).toBeGreaterThanOrEqual(5);
  });

  it("reads each milestone's stamp before probing audit_log (engram#555)", async () => {
    const st = state();
    await app(fakeDb(st))();
    const funnel = st.log.find((s) => /AS connected/.test(s)) ?? "";
    // audit_log keeps 90 days. A milestone proved by rows that retention has
    // since deleted survives only as its stamp on organizations, so every
    // column must accept the stamp, and check it before the probe so a
    // stamped org never runs one. activation-milestones.d1.test.ts proves the
    // numbers; this keeps the funnel from quietly dropping the stamps.
    for (const stamp of ["first_search_at", "first_recall_at", "second_session_at", "returned_7d_at"]) {
      expect(funnel).toMatch(new RegExp(`WHEN o\\.${stamp} IS NOT NULL\\s+OR\\b`));
    }
    expect(funnel).toMatch(/COALESCE\(o\.first_activity_at,/);
  });

  it("computes the funnel once per TTL while the cheap figures stay live", async () => {
    const st = state();
    const call = app(fakeDb(st));

    const first = await body(await call());
    st.total = 11;
    const second = await body(await call());

    expect(st.funnelRuns).toBe(1);
    expect(st.log.filter((s) => /FROM conversation_chunks/.test(s))).toHaveLength(1);
    expect(second.signups.total).toBe(11);
    expect(second.activation).toEqual(first.activation);
    expect(second.activation_computed_at).toBe(first.activation_computed_at);

    t += SLOW_METRICS_TTL_MS;
    const third = await body(await call());
    expect(st.funnelRuns).toBe(2);
    expect(third.activation.connected).toBe(10);
  });

  it("shares one funnel run between concurrent cold requests", async () => {
    const st = state();
    const call = app(fakeDb(st));

    const all = await Promise.all([call(), call(), call()]);
    for (const r of all) expect(r.status).toBe(200);
    expect(st.funnelRuns).toBe(1);
  });

  it("serves the last good funnel when D1 refuses the recompute, and backs off", async () => {
    const st = state();
    const call = app(fakeDb(st));

    const good = await body(await call());

    t += SLOW_METRICS_TTL_MS;
    st.failFunnel = true;
    st.total = 12;
    const res = await call();
    expect(res.status).toBe(200);
    const stale = await body(res);
    expect(stale.activation).toEqual(good.activation);
    expect(stale.activation_computed_at).toBe(good.activation_computed_at);
    expect(stale.storage.chunks).toBe(1_054_509);
    expect(stale.signups.total).toBe(12); // the cheap group is still live
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("serving figures from 600s ago"));

    // Within the backoff the funnel is not attempted again…
    const attempts = funnelAttempts(st);
    t += SLOW_METRICS_ERROR_BACKOFF_MS - 1;
    expect((await call()).status).toBe(200);
    expect(funnelAttempts(st)).toBe(attempts);

    // …and once it has passed, a recovered D1 replaces the stale figures.
    t += 1;
    st.failFunnel = false;
    const fresh = await body(await call());
    expect(st.funnelRuns).toBe(2);
    expect(fresh.activation.connected).toBe(10);
  });

  it("fails the request when the cache is cold and D1 refuses the funnel, without caching the failure", async () => {
    const st = state();
    st.failFunnel = true;
    const call = app(fakeDb(st));

    // Hono's default handler; the worker's app.onError maps this to 503.
    expect((await call()).status).toBe(500);

    st.failFunnel = false;
    const res = await call();
    expect(res.status).toBe(200);
    expect((await body(res)).activation.connected).toBe(9);
  });
});
