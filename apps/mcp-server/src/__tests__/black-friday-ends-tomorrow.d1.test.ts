import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { Miniflare } from "miniflare";
import app from "../index.js";
import {
  BLACK_FRIDAY_ENDS_TOMORROW,
  BLACK_FRIDAY_LAST_DAY,
  BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS,
  TEST_RECIPIENT,
} from "../services/black-friday-campaign.js";
import { runCampaignTick, startCampaignRun } from "../services/campaign-runs.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The "ends tomorrow" Black Friday email (engram#793), against real SQLite
 * with the real migrations: it goes to the addresses the resends go to
 * (opened no Black Friday email, could still buy), through its own route on
 * engram-web, and only before the offer's last day begins.
 */

const KEY = "link-key-793-test";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
const ROUTE = "/api/email/black-friday-ends-tomorrow";
const LAST_DAY = BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS;
/** 20:30 UTC the day before the last day: when it is meant to go. */
const TODAY = LAST_DAY - 8.5 * 3_600_000;
const TICK = 120_000;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

interface Mail {
  to: string;
  name: string | null;
  org_id: string;
  unsubscribe_url: string;
  offer_url: string;
  test?: boolean;
}

describe('The "ends tomorrow" Black Friday email (engram#793), against real SQLite', () => {
  let mf: Miniflare;
  let db: D1Database;
  let clock: number;
  /** Emails engram-web sent through the ends-tomorrow route. */
  let mails: Mail[];
  /** Requests to any other route. */
  let otherRoutes: string[];
  let logId = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "black-friday-ends-tomorrow" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await db.batch(
      ["campaign_runs", "campaign_sends", "email_log", "email_opt_outs", "prepaid_plans", "organizations"].map((t) =>
        db.prepare(`DELETE FROM ${t}`),
      ),
    );
    mails = [];
    otherRoutes = [];
    clock = TODAY;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.origin === WEB && url.pathname === ROUTE) {
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer web-bearer");
          mails.push(JSON.parse(String(init?.body)) as Mail);
          return new Response("{}", { status: 200 });
        }
        otherRoutes.push(url.pathname);
        return new Response("{}", { status: 200 });
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function env(): Env {
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
    } as unknown as Env;
  }

  const orgInsert = (id: string, o: { email?: string; tier?: string; optOut?: boolean } = {}) =>
    db
      .prepare(
        `INSERT INTO organizations (id, name, email, tier, digest_opt_out, referral_source, created_at)
         VALUES (?, ?, ?, ?, ?, 'chatgpt', '2026-10-01 00:00:00')`,
      )
      .bind(id, `Name ${id}`, o.email ?? `${id}@example.test`, o.tier ?? "free", o.optOut ? 1 : 0);
  const sendInsert = (campaign: string, address: string, orgId: string) =>
    db
      .prepare("INSERT INTO campaign_sends (campaign, email, org_id, status) VALUES (?, ?, ?, 'sent')")
      .bind(campaign, address, orgId);
  const openInsert = (recipient: string) =>
    db
      .prepare("INSERT INTO email_log (id, org_id, recipient, type, opened_at) VALUES (?, NULL, ?, 'black-friday', '2026-11-18 06:00:00')")
      .bind(`el_${++logId}`, recipient);

  /** An account the first email went to. */
  async function got(id: string, o: { tier?: string; optOut?: boolean; opened?: boolean } = {}) {
    const address = `${id}@example.test`;
    await db.batch([
      orgInsert(id, o),
      sendInsert("black-friday", address, id),
      ...(o.opened ? [openInsert(address)] : []),
    ]);
  }

  async function admin(method: "GET" | "POST", body?: unknown) {
    const res = await app.fetch(
      new Request(`${WORKER}/admin/campaigns/${BLACK_FRIDAY_ENDS_TOMORROW}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: "Bearer admin-test" },
        body: method === "GET" ? undefined : JSON.stringify(body),
      }),
      env(),
      ctx,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  const runState = async () =>
    db
      .prepare("SELECT state, note FROM campaign_runs WHERE campaign = ?")
      .bind(BLACK_FRIDAY_ENDS_TOMORROW)
      .first<{ state: string; note: string | null }>();

  async function tick() {
    clock += TICK;
    return runCampaignTick(env());
  }

  it("goes only to addresses that opened no Black Friday email and could still buy, through its own route, once each", async () => {
    await got("org_unopened_1");
    await got("org_unopened_2");
    await got("org_opened", { opened: true });
    await got("org_paid", { tier: "pro" });
    await got("org_optout", { optOut: true });
    await got("org_bought");
    await db
      .prepare(
        "INSERT INTO prepaid_plans (session_id, org_id, offer, tier, ends_at) VALUES ('cs_1', 'org_bought', 'black-friday', 'pro', '2027-11-19 00:00:00')",
      )
      .run();
    await orgInsert("org_never_got").run();

    expect((await admin("GET")).body).toMatchObject({ campaign: BLACK_FRIDAY_ENDS_TOMORROW, owed: 2, recorded: {}, run: null });

    expect((await admin("POST", { start: true })).status).toBe(200);
    await tick();
    expect(mails.map((m) => m.to).sort()).toEqual(["org_unopened_1@example.test", "org_unopened_2@example.test"]);
    for (const m of mails) {
      expect(m.offer_url).toContain(`/black-friday?org=${m.org_id}&sig=`);
      expect(m.unsubscribe_url).toBeTruthy();
      expect(m.test).toBeUndefined();
    }
    expect(otherRoutes).toEqual([]);
    await tick();
    expect(await runState()).toMatchObject({ state: "done" });
    expect(mails).toHaveLength(2);
    expect((await admin("GET")).body).toMatchObject({ owed: 0, recorded: { sent: 2 } });

    // The last-day email still counts these addresses as owed: its own campaign.
    const lastDay = await app.fetch(
      new Request(`${WORKER}/admin/campaigns/${BLACK_FRIDAY_LAST_DAY}`, { headers: { Authorization: "Bearer admin-test" } }),
      env(),
      ctx,
    );
    expect(((await lastDay.json()) as { owed: number }).owed).toBe(3);
  });

  it("is refused from the moment the last day begins: start, schedule and test copy", async () => {
    await got("org_1");
    await orgInsert("org_hello", { email: TEST_RECIPIENT }).run();
    clock = LAST_DAY;
    for (const body of [{ start: true }, { test_to: TEST_RECIPIENT }]) {
      const res = await admin("POST", body);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("too_late");
    }
    clock = TODAY;
    const sched = await admin("POST", { schedule_at: new Date(LAST_DAY).toISOString() });
    expect(sched.status).toBe(409);
    expect(sched.body.error).toBe("too_late");
    expect(mails).toEqual([]);
  });

  it("a run still going when the last day begins stops without sending more", async () => {
    await got("org_1");
    const started = await startCampaignRun(env(), BLACK_FRIDAY_ENDS_TOMORROW);
    expect("error" in started).toBe(false);
    clock = LAST_DAY - 1;
    await tick();
    expect(mails).toEqual([]);
    expect((await runState())?.state).not.toBe("running");
  });

  it("sends one test copy to hello@ through its route, records nothing, and refuses any other address", async () => {
    await orgInsert("org_hello", { email: TEST_RECIPIENT }).run();
    await got("org_1");
    expect((await admin("POST", { test_to: "someone@example.test" })).status).toBe(400);
    const res = await admin("POST", { test_to: TEST_RECIPIENT });
    expect(res).toEqual({ status: 200, body: { sent: true } });
    expect(mails).toEqual([expect.objectContaining({ to: TEST_RECIPIENT, org_id: "org_hello", test: true })]);
    expect((await admin("GET")).body).toMatchObject({ owed: 1, recorded: {}, run: null });
  });
});
