import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import app from "../index.js";
import {
  BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS,
  TEST_RECIPIENT,
  type CampaignError,
  type CampaignResult,
} from "../services/black-friday-campaign.js";
import {
  BLACK_FRIDAY_CHECKOUT,
  BLACK_FRIDAY_REMINDERS,
  BLACK_FRIDAY_UNPAID,
  BLACK_FRIDAY_UNPAID_LATE,
  BLACK_FRIDAY_UNUSED,
  LATE_CUTOFF_MS,
  REMINDER_CUTOFF_MS,
  UNUSED_FROM,
  blackFridayReminderRefusal,
  runBlackFridayReminder,
  type BlackFridayReminder,
} from "../services/black-friday-reminders.js";
import { runCampaignTick, startCampaignRun } from "../services/campaign-runs.js";
import { BLACK_FRIDAY_ENDS_AT_MS } from "../services/black-friday.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The Black Friday reminders (engram#787, engram#789), against real SQLite
 * with the real migrations and a fake Stripe: who each one goes to, one
 * email per person across them, when they may be sent, the cron that sends
 * them, the /admin switch for each (a start time included), the test copy,
 * crediting an unsubscribe, and how their statements read D1.
 */

const KEY = "link-key-787-test";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
const HOUR = 3_600_000;
/** The cron's interval. */
const TICK = 120_000;
const DAY_S = 86_400;
const CUTOFF = REMINDER_CUTOFF_MS;
/** The cutoff in Stripe's seconds. */
const CUTOFF_S = CUTOFF / 1000;
/** Two hours before the cutoff: they can be counted, tested and given a start time, not sent. */
const BEFORE = CUTOFF - 2 * HOUR;
/** 14:00 UTC on November 25. */
const SEND_AT = Date.UTC(2026, 10, 25, 14, 0, 0);
const LAST_DAY = BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS;
/** When an account in the unused reminder's window was made, as D1 writes a time. */
const NEW = "2026-11-20 12:00:00";
const MINUTE = 60_000;
/** The late unpaid reminder's cutoff, and the same in Stripe's seconds. */
const LATE_CUTOFF = LATE_CUTOFF_MS;
const LATE_CUTOFF_S = LATE_CUTOFF / 1000;
/** 14:00 UTC on November 26. */
const LATE_SEND_AT = Date.UTC(2026, 10, 26, 14, 0, 0);

const TOO_EARLY = "The reminders go out from 2026-11-25T06:00:00.000Z, once who gets them is fixed; nothing was sent.";
const LATE_TOO_EARLY = "The reminders go out from 2026-11-26T01:00:00.000Z, once who gets them is fixed; nothing was sent.";
const TOO_LATE = "The reminders are not sent on the offer's last day, from 2026-11-27T05:00:00.000Z; nothing was sent.";
const BAD_BODY = "Send exactly one of: start: true, pause: true, test_to: <address> or schedule_at: <UTC time>.";
const BAD_TIME = "schedule_at must be a UTC time like 2026-11-25T14:00:00Z.";

const offerSig = (org: string) => createHmac("sha256", KEY).update(`offer:black-friday:${org}`).digest("hex");
const unsubscribeSig = (org: string) => createHmac("sha256", KEY).update(`digest:${org}`).digest("hex");

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

const iso = (ms: number) => new Date(ms).toISOString();

interface Mail {
  to: string;
  name: string | null;
  org_id: string;
  unsubscribe_url: string;
  offer_url: string;
  test?: boolean;
  /** Which reminder's route it went through. */
  route: string;
  /** When engram-web was asked to send it. */
  at: number;
}

interface OrgOpts {
  email?: string | null;
  tier?: string;
  optOut?: boolean;
  deleted?: boolean;
  source?: string;
  /** When the account was made. Before the unused reminder's window unless told otherwise. */
  created?: string;
}

interface StripeSession {
  id: string;
  status: string;
  created: number;
  metadata: Record<string, string> | null;
}

interface StripeSubscription {
  id: string;
  canceled_at: number | null;
  cancellation_details: { reason: string | null } | null;
  metadata: Record<string, string> | null;
}

interface RunRow {
  state: string;
  note: string | null;
  failed_ticks: number;
  start_at: number | null;
  finished_at: string | null;
}

/** EXPLAIN QUERY PLAN takes as many values as the statement has parameters. */
function paramCount(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  return numbered.length > 0 ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
}

const ok = (r: CampaignResult | CampaignError) => {
  if ("error" in r) throw new Error(`refused: ${r.error}`);
  return r;
};

describe("The Black Friday reminders (engram#787), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let clock: number;
  /** Reminder emails engram-web sent. */
  let mails: Mail[];
  /** What engram-web answers on a reminder route: a status, or "throw" for no answer at all. */
  let webAnswer: () => number | "throw";
  /** Stripe's checkout sessions and cancelled subscriptions, in the order it lists them. */
  let sessions: StripeSession[];
  let subscriptions: StripeSubscription[];
  /** Every request made to Stripe. */
  let stripeCalls: URL[];
  /** What Stripe answers: 200 with the list, or this status. */
  let stripeAnswer: number;
  let stripeId: number;
  let convoId: number;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "black-friday-reminders" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  /** One page of a Stripe list: two rows, after `starting_after` when it is given. */
  function page<T extends { id: string }>(rows: T[], url: URL): Response {
    expect(url.searchParams.get("limit")).toBe("100");
    const after = url.searchParams.get("starting_after");
    const from = after === null ? 0 : rows.findIndex((r) => r.id === after) + 1;
    if (after !== null) expect(from).toBeGreaterThan(0);
    const data = rows.slice(from, from + 2);
    return new Response(JSON.stringify({ object: "list", data, has_more: from + 2 < rows.length }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(async () => {
    await db.batch(
      [
        "campaign_runs",
        "campaign_sends",
        "email_log",
        "email_opt_outs",
        "prepaid_plans",
        "conversations",
        "organizations",
      ].map((t) => db.prepare(`DELETE FROM ${t}`)),
    );
    mails = [];
    webAnswer = () => 200;
    sessions = [];
    subscriptions = [];
    stripeCalls = [];
    stripeAnswer = 200;
    stripeId = 0;
    convoId = 0;
    clock = BEFORE;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const headers = init?.headers as Record<string, string>;
        if (url.origin === "https://api.stripe.com") {
          expect(headers.Authorization).toBe("Bearer sk_test_fake");
          stripeCalls.push(url);
          if (stripeAnswer !== 200) {
            return new Response('{"error":{"type":"invalid_request_error"}}', { status: stripeAnswer });
          }
          if (url.pathname === "/v1/checkout/sessions") return page(sessions, url);
          if (url.pathname === "/v1/subscriptions") {
            expect(url.searchParams.get("status")).toBe("canceled");
            return page(subscriptions, url);
          }
        }
        const route = url.pathname.replace(/^\/api\/email\//, "");
        if (url.origin === WEB && (BLACK_FRIDAY_REMINDERS as readonly string[]).includes(route)) {
          expect(headers.Authorization).toBe("Bearer web-bearer");
          const mail = JSON.parse(String(init?.body)) as Mail;
          const answer = webAnswer();
          if (answer === "throw") throw new Error("connection reset");
          if (answer === 200) mails.push({ ...mail, route, at: clock });
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

  const orgInsert = (id: string, o: OrgOpts = {}) =>
    db
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
        o.deleted ? "2026-11-19 00:00:00" : null,
        o.source ?? "chatgpt",
        o.created ?? "2026-10-01 00:00:00",
      );

  /** An account. Free, with an email, subscribed to email, made in October, unless told otherwise. */
  async function org(id: string, o: OrgOpts = {}) {
    await orgInsert(id, o).run();
  }

  const sendInsert = (campaign: string, address: string, orgId: string) =>
    db
      .prepare("INSERT INTO campaign_sends (campaign, email, org_id, status) VALUES (?, ?, ?, 'sent')")
      .bind(campaign, address, orgId);

  /** A checkout Stripe lists, made at `created` (seconds), naming the account in its metadata. */
  function checkout(orgId: string | null, created: number, status: "expired" | "open" | "complete") {
    sessions.push({ id: `cs_${++stripeId}`, status, created, metadata: orgId === null ? {} : { organization_id: orgId } });
  }

  /** A subscription Stripe cancelled at `at` (seconds), for `reason`. */
  function cancelled(orgId: string, at: number, reason: string | null = "payment_failed") {
    subscriptions.push({
      id: `sub_${++stripeId}`,
      canceled_at: at,
      cancellation_details: reason === null ? null : { reason },
      metadata: { organization_id: orgId },
    });
  }

  /** A conversation of the account's, holding `messages` messages. */
  async function convo(orgId: string, messages: number) {
    await db
      .prepare("INSERT INTO conversations (id, organization_id, message_count) VALUES (?, ?, ?)")
      .bind(`conv_${++convoId}`, orgId, messages)
      .run();
  }

  /** An account in all three groups: made in the window, saved nothing, left a checkout, and lost its plan to a failed payment. */
  async function inAll(id: string, o: OrgOpts = {}) {
    await org(id, { created: NEW, ...o });
    checkout(id, CUTOFF_S - DAY_S, "expired");
    cancelled(id, CUTOFF_S - DAY_S);
  }

  /** The account bought the offer. */
  const bought = (orgId: string, session: string) =>
    db
      .prepare(
        "INSERT INTO prepaid_plans (session_id, org_id, offer, tier, ends_at) VALUES (?, ?, 'black-friday', 'pro', '2027-11-19 00:00:00')",
      )
      .bind(session, orgId)
      .run();

  /**
   * Who `campaign` goes to, in the order it is sent: counted, then sent in
   * one batch at SEND_AT, which must reach everyone the count said.
   */
  async function whoGets(campaign: BlackFridayReminder): Promise<string[]> {
    clock = SEND_AT;
    const count = ok(await runBlackFridayReminder(env(), { campaign, dryRun: true }));
    const before = mails.length;
    const sent = ok(await runBlackFridayReminder(env(), { campaign, limit: 50 }));
    expect(sent).toMatchObject({ owed: count.owed, sent: count.owed, skipped: 0, failed: 0, stopped: false });
    const got = mails.slice(before);
    expect(got.every((m) => m.route === campaign)).toBe(true);
    return got.map((m) => m.org_id);
  }

  /** How many each reminder is owed to now. */
  async function owedCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const campaign of BLACK_FRIDAY_REMINDERS) {
      out[campaign] = ok(await runBlackFridayReminder(env(), { campaign, dryRun: true })).owed;
    }
    return out;
  }

  const runRow = (campaign: string) =>
    db
      .prepare("SELECT state, note, failed_ticks, start_at, finished_at FROM campaign_runs WHERE campaign = ?")
      .bind(campaign)
      .first<RunRow>();

  /** The next cron tick, two minutes after the last. */
  async function tick() {
    clock += TICK;
    return runCampaignTick(env());
  }

  /** The two-minute cron itself, firing at `at`. */
  async function cron(at: number) {
    clock = at;
    await app.scheduled(
      { cron: "*/2 * * * *", scheduledTime: at, type: "scheduled", noRetry() {} } as unknown as ScheduledEvent,
      env(),
      ctx,
    );
  }

  async function admin(method: "GET" | "POST", campaign: string, body?: unknown, bearer = "admin-test") {
    const res = await app.fetch(
      new Request(`${WORKER}/admin/campaigns/${campaign}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      env(),
      ctx,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  /** A database that writes down every statement prepared on it. */
  function recording(sql: string[]): D1Database {
    return new Proxy(db, {
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
  }

  // -------------------------------------------------------------------------
  describe("who each one goes to", () => {
    it("checkout: an account whose checkout before the cutoff expired, or was still open three hours before it", async () => {
      for (const id of ["org_expired", "org_stale", "org_fresh", "org_late", "org_done"]) await org(id);
      checkout("org_expired", CUTOFF_S - DAY_S, "expired");
      // Open since exactly three hours before the cutoff: left.
      checkout("org_stale", CUTOFF_S - 3 * 3600, "open");
      // Open for less than that: perhaps still being filled in.
      checkout("org_fresh", CUTOFF_S - 3 * 3600 + 1, "open");
      // Left, but begun at the cutoff, once the group was fixed.
      checkout("org_late", CUTOFF_S, "expired");
      checkout("org_done", CUTOFF_S - DAY_S, "complete");
      // Checkouts that name no account.
      checkout(null, CUTOFF_S - DAY_S, "expired");
      sessions.push({ id: "cs_no_metadata", status: "expired", created: CUTOFF_S - DAY_S, metadata: null });

      expect(await whoGets(BLACK_FRIDAY_CHECKOUT)).toEqual(["org_expired", "org_stale"]);
    });

    it("checkout: not an account that finished a checkout when or after it left its latest one, at any time", async () => {
      const at = CUTOFF_S - DAY_S;
      for (const id of ["org_later", "org_same", "org_after_cutoff", "org_before", "org_again"]) await org(id);
      checkout("org_later", at, "expired");
      checkout("org_later", at + 60, "complete");
      checkout("org_same", at, "expired");
      checkout("org_same", at, "complete");
      checkout("org_after_cutoff", at, "expired");
      checkout("org_after_cutoff", CUTOFF_S + DAY_S, "complete");
      // Finished one, then left a later one.
      checkout("org_before", at - 60, "complete");
      checkout("org_before", at, "expired");
      // Left one, finished one, then left another: the latest one counts.
      checkout("org_again", at - 120, "expired");
      checkout("org_again", at - 60, "complete");
      checkout("org_again", at, "expired");

      expect(await whoGets(BLACK_FRIDAY_CHECKOUT)).toEqual(["org_again", "org_before"]);
    });

    it("checkout: reads every page of Stripe's list, and sends one email per address, to its oldest account", async () => {
      await org("org_a", { email: "pair@example.test", created: "2026-10-05 00:00:00" });
      await org("org_b", { email: " Pair@Example.test", created: "2026-10-01 00:00:00" });
      for (const id of ["org_c", "org_d", "org_e"]) await org(id);
      for (const id of ["org_a", "org_b", "org_c", "org_d", "org_e"]) checkout(id, CUTOFF_S - DAY_S, "expired");

      expect(await whoGets(BLACK_FRIDAY_CHECKOUT)).toEqual(["org_c", "org_d", "org_e", "org_b"]);
      expect(mails.at(-1)?.to).toBe("Pair@Example.test");
      // Pages of two, each after the last row of the page before: the count, then the send.
      const read = [
        ["/v1/checkout/sessions", null],
        ["/v1/checkout/sessions", "cs_2"],
        ["/v1/checkout/sessions", "cs_4"],
      ];
      expect(stripeCalls.map((u) => [u.pathname, u.searchParams.get("starting_after")])).toEqual([...read, ...read]);
    });

    it("unpaid: an account whose plan Stripe cancelled for a failed payment before the cutoff, on the Free plan now", async () => {
      for (const id of ["org_failed", "org_asked", "org_no_reason", "org_late"]) await org(id);
      await org("org_back", { tier: "pro" });
      cancelled("org_failed", CUTOFF_S - DAY_S);
      cancelled("org_asked", CUTOFF_S - DAY_S, "cancellation_requested");
      cancelled("org_no_reason", CUTOFF_S - DAY_S, null);
      cancelled("org_late", CUTOFF_S);
      // On a paid plan again since.
      cancelled("org_back", CUTOFF_S - 2 * DAY_S);

      expect(await whoGets(BLACK_FRIDAY_UNPAID)).toEqual(["org_failed"]);
      // Cancelled subscriptions only, every page.
      expect(stripeCalls.map((u) => [u.pathname, u.searchParams.get("starting_after")])).toEqual([
        ["/v1/subscriptions", null],
        ["/v1/subscriptions", "sub_2"],
        ["/v1/subscriptions", "sub_4"],
        ["/v1/subscriptions", null],
        ["/v1/subscriptions", "sub_2"],
        ["/v1/subscriptions", "sub_4"],
      ]);
    });

    it("unused: an account made from the first email until the cutoff that has saved nothing", async () => {
      await org("org_none", { created: NEW });
      await org("org_one", { created: NEW });
      await convo("org_one", 1);
      await org("org_empty", { created: NEW });
      await convo("org_empty", 0);
      await org("org_two", { created: NEW });
      await convo("org_two", 1);
      await convo("org_two", 1);
      await org("org_long", { created: NEW });
      await convo("org_long", 2);
      await org("org_first", { created: UNUSED_FROM });
      await org("org_older", { created: "2026-11-18 04:25:59" });
      await org("org_last", { created: "2026-11-25 05:59:59" });
      await org("org_cutoff", { created: "2026-11-25 06:00:00" });

      expect(await whoGets(BLACK_FRIDAY_UNUSED)).toEqual(["org_empty", "org_first", "org_last", "org_none", "org_one"]);
      // It reads no Stripe.
      expect(stripeCalls).toEqual([]);
    });

    it("unused: counted by address, so an address with any used account is left out, and the oldest unused one gets it", async () => {
      // Used and unused accounts at one address, however it is written.
      await org("org_shared_new", { email: "Shared@Example.test", created: NEW });
      await org("org_shared_used", { email: " shared@example.test", created: "2026-11-21 00:00:00" });
      await convo("org_shared_used", 1);
      await convo("org_shared_used", 1);
      // A used account at the address from before the window.
      await org("org_old_used", { email: "old@example.test" });
      await convo("org_old_used", 5);
      // organizations.email is unique as written, so a second account at an
      // address spells it differently.
      await org("org_old_new", { email: "Old@example.test", created: NEW });
      // Two unused ones.
      await org("org_pair_later", { email: "pair@example.test", created: "2026-11-21 00:00:00" });
      await org("org_pair_first", { email: "Pair@example.test", created: "2026-11-20 00:00:00" });

      expect(await whoGets(BLACK_FRIDAY_UNUSED)).toEqual(["org_pair_first"]);
      expect(mails[0].to).toBe("Pair@example.test");
    });

    it("unused: not an address the first Black Friday email or a finish-sign-up email went to", async () => {
      for (const id of ["org_first_email", "org_finish", "org_finish_again", "org_ok"]) await org(id, { created: NEW });
      await db.batch([
        sendInsert("black-friday", "org_first_email@example.test", "org_first_email"),
        sendInsert("finish-signup", "org_finish@example.test", "org_finish"),
        sendInsert("finish-signup-resend", "org_finish_again@example.test", "org_finish_again"),
      ]);

      expect(await whoGets(BLACK_FRIDAY_UNUSED)).toEqual(["org_ok"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("who none of them goes to", () => {
    it("an account in all three groups is owed all three until one is sent", async () => {
      await inAll("org_1");
      await inAll("org_2");
      expect(await owedCounts()).toEqual({ [BLACK_FRIDAY_UNPAID]: 2, [BLACK_FRIDAY_CHECKOUT]: 2, [BLACK_FRIDAY_UNUSED]: 2 });
    });

    const excluded: [string, (id: string) => Promise<void>][] = [
      ["a deleted account", (id) => inAll(id, { deleted: true })],
      ["an account on a paid plan", (id) => inAll(id, { tier: "pro" })],
      ["an account without an email address", (id) => inAll(id, { email: null })],
      ["an account whose email address is blank", (id) => inAll(id, { email: "  " })],
      ["an account that unsubscribed", (id) => inAll(id, { optOut: true })],
      ["an internal account", (id) => inAll(id, { source: "internal" })],
      [
        "an address that also has a paid account",
        async (id) => {
          await inAll(id);
          await org(`${id}_paid`, { email: ` ${id.toUpperCase()}@example.test`, tier: "team" });
        },
      ],
      [
        "an address that also has an account that unsubscribed",
        async (id) => {
          await inAll(id);
          await org(`${id}_out`, { email: `${id.toUpperCase()}@Example.test`, optOut: true });
        },
      ],
      [
        "an account that bought the offer",
        async (id) => {
          await inAll(id);
          await bought(id, "cs_bought");
        },
      ],
      [
        "an address that also has an account that bought the offer",
        async (id) => {
          await inAll(id);
          await org(`${id}_buyer`, { email: ` ${id}@example.test ` });
          await bought(`${id}_buyer`, "cs_bought");
        },
      ],
      [
        "an address that opted out of all Engram email",
        async (id) => {
          await inAll(id);
          await db
            .prepare("INSERT INTO email_opt_outs (email, source) VALUES (?, 'unsubscribe-link')")
            .bind(`${id}@example.test`)
            .run();
        },
      ],
      [
        "an address one of the reminders has gone to",
        async (id) => {
          await inAll(id);
          await sendInsert(BLACK_FRIDAY_CHECKOUT, `${id}@example.test`, id).run();
        },
      ],
    ];

    it.each(excluded)("%s", async (_, make) => {
      await inAll("org_2");
      await make("org_1");
      expect(await owedCounts()).toEqual({ [BLACK_FRIDAY_UNPAID]: 1, [BLACK_FRIDAY_CHECKOUT]: 1, [BLACK_FRIDAY_UNUSED]: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("when they may be sent", () => {
    it.each(BLACK_FRIDAY_REMINDERS)(
      "%s: from the cutoff until the offer's last day begins, with mail and Stripe set up; counted at any time",
      async (campaign) => {
        await inAll("org_1");
        const send = (e = env()) => runBlackFridayReminder(e, { campaign, limit: 50 });

        clock = BEFORE;
        expect(ok(await runBlackFridayReminder(env(), { campaign, dryRun: true })).owed).toBe(1);
        vi.mocked(fetch).mockClear();
        clock = CUTOFF - 1;
        expect(await send()).toEqual({ error: "too_early", message: TOO_EARLY, status: 409 });
        clock = LAST_DAY;
        expect(await send()).toEqual({ error: "too_late", message: TOO_LATE, status: 409 });
        clock = BLACK_FRIDAY_ENDS_AT_MS;
        expect(await send()).toMatchObject({ error: "offer_ended", status: 410 });
        clock = CUTOFF;
        expect(await send(env({ INTERNAL_CRON_SECRET: "", ADMIN_SECRET: "" }))).toMatchObject({
          error: "mail_not_configured",
        });
        if (campaign !== BLACK_FRIDAY_UNUSED) {
          expect(await send(env({ STRIPE_SECRET_KEY: "" }))).toMatchObject({ error: "stripe_not_configured", status: 500 });
          expect(await runBlackFridayReminder(env({ STRIPE_SECRET_KEY: "" }), { campaign, dryRun: true })).toMatchObject({
            error: "stripe_not_configured",
          });
        }
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
        expect(mails).toEqual([]);

        expect(blackFridayReminderRefusal(env(), campaign, LAST_DAY - 1)).toBeNull();
        expect(ok(await send())).toMatchObject({ owed: 1, sent: 1 });
        expect(mails.map((m) => [m.route, m.org_id])).toEqual([[campaign, "org_1"]]);
      },
    );
  });

  // -------------------------------------------------------------------------
  describe("the cron", () => {
    it("sends a started run fifty at a time, and ends it once nobody is left", async () => {
      const ids = Array.from({ length: 55 }, (_, i) => `org_${String(i).padStart(3, "0")}`);
      await db.batch(ids.map((id) => orgInsert(id, { created: NEW })));
      clock = SEND_AT;
      const started = await startCampaignRun(env(), BLACK_FRIDAY_UNUSED);
      expect(started).toMatchObject({ run: { state: "running" } });

      await cron(SEND_AT + TICK);
      expect(mails).toHaveLength(50);
      await cron(SEND_AT + 2 * TICK);
      expect(mails).toHaveLength(55);
      expect(await runRow(BLACK_FRIDAY_UNUSED)).toMatchObject({ state: "running" });
      await cron(SEND_AT + 3 * TICK);
      expect(mails.map((m) => m.org_id)).toEqual(ids);
      expect(await runRow(BLACK_FRIDAY_UNUSED)).toMatchObject({ state: "done", note: "Sent to everyone it was owed to." });
    });

    it("when Stripe refuses the key, says so without the key, asks only once a tick, and pauses after three ticks", async () => {
      await inAll("org_1");
      clock = SEND_AT;
      await startCampaignRun(env(), BLACK_FRIDAY_CHECKOUT);
      stripeAnswer = 401;

      await tick();
      expect(await runRow(BLACK_FRIDAY_CHECKOUT)).toMatchObject({
        state: "running",
        failed_ticks: 1,
        note: "The batch failed: Stripe answered 401",
      });
      await tick();
      await tick();
      const row = await runRow(BLACK_FRIDAY_CHECKOUT);
      expect(row).toMatchObject({ state: "paused", note: "The batch failed: Stripe answered 401 (3 ticks in a row)" });
      expect(row?.note).not.toContain("sk_test");
      expect(stripeCalls).toHaveLength(3);
      expect(mails).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("/admin", () => {
    it("is for the admin only", async () => {
      for (const campaign of BLACK_FRIDAY_REMINDERS) {
        expect((await admin("GET", campaign, undefined, "wrong")).status).toBe(401);
        expect((await admin("POST", campaign, { start: true }, "wrong")).status).toBe(401);
      }
      expect(await runRow(BLACK_FRIDAY_UNPAID)).toBeNull();
    });

    it("GET says who is owed it, what was sent, the cutoff and the run; or why it cannot say", async () => {
      await inAll("org_1");
      for (const campaign of BLACK_FRIDAY_REMINDERS) {
        expect(await admin("GET", campaign)).toEqual({
          status: 200,
          body: { campaign, owed: 1, cutoff: "2026-11-25T06:00:00.000Z", recorded: {}, run: null },
        });
      }
      stripeAnswer = 401;
      expect(await admin("GET", BLACK_FRIDAY_UNPAID)).toEqual({
        status: 502,
        body: { error: "list_failed", message: "Stripe answered 401" },
      });
      expect((await admin("GET", BLACK_FRIDAY_UNUSED)).status).toBe(200);
    });

    it("POST takes exactly one of start, pause, test_to or schedule_at, and a schedule_at that is a UTC time", async () => {
      await inAll("org_1");
      const bodies: unknown[] = [
        {},
        "not json",
        { start: 1 },
        { start: "true" },
        { pause: "yes" },
        { test_to: 5 },
        { schedule_at: Date.UTC(2026, 10, 25, 14) },
        { start: true, pause: true },
        { test_to: TEST_RECIPIENT, start: 1 },
        { schedule_at: "2026-11-25T14:00:00Z", start: true },
        { schedule_at: "2026-11-25T14:00:00Z", pause: false },
      ];
      for (const body of bodies) {
        expect(await admin("POST", BLACK_FRIDAY_UNPAID, body), JSON.stringify(body)).toEqual({
          status: 400,
          body: { error: "bad_request", message: BAD_BODY },
        });
      }
      for (const at of ["tomorrow", "2026-11-25T14:00:00", "2026-11-25T14:00:00+00:00", "2026-11-25 14:00:00Z", "2026-02-30T14:00:00Z"]) {
        expect(await admin("POST", BLACK_FRIDAY_UNPAID, { schedule_at: at }), at).toEqual({
          status: 400,
          body: { error: "bad_request", message: BAD_TIME },
        });
      }
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await runRow(BLACK_FRIDAY_UNPAID)).toBeNull();
    });

    it("POST schedule_at gives the run a start time, or moves it; refused for a past time, before the cutoff, on the last day, and while it runs", async () => {
      await inAll("org_1");
      const schedule = (at: string) => admin("POST", BLACK_FRIDAY_UNPAID, { schedule_at: at });

      expect(await schedule("2026-11-25T03:59:00Z")).toEqual({
        status: 400,
        body: { error: "bad_request", message: "The start time must be a time in the future." },
      });
      expect(await schedule("2026-11-25T05:58:00Z")).toEqual({
        status: 409,
        body: { error: "too_early", message: TOO_EARLY },
      });
      expect(await schedule("2026-11-27T05:00:00Z")).toEqual({
        status: 409,
        body: { error: "too_late", message: TOO_LATE },
      });
      expect(await runRow(BLACK_FRIDAY_UNPAID)).toBeNull();

      expect(await schedule("2026-11-25T14:00:00Z")).toMatchObject({
        status: 200,
        body: { owed: 1, run: { campaign: BLACK_FRIDAY_UNPAID, state: "scheduled", start_at: "2026-11-25T14:00:00.000Z" } },
      });
      expect(await schedule("2026-11-25T14:30:00Z")).toMatchObject({
        status: 200,
        body: { run: { state: "scheduled", start_at: "2026-11-25T14:30:00.000Z" } },
      });
      expect(await admin("POST", BLACK_FRIDAY_UNPAID, { pause: true })).toMatchObject({
        status: 200,
        body: { paused: true, run: { state: "paused", start_at: null, note: "Scheduled start cancelled from /admin." } },
      });

      clock = SEND_AT;
      expect(await admin("POST", BLACK_FRIDAY_UNPAID, { start: true })).toMatchObject({
        status: 200,
        body: { owed: 1, run: { state: "running", start_at: null } },
      });
      expect(await schedule("2026-11-25T15:00:00Z")).toMatchObject({
        status: 409,
        body: { error: "already_running" },
      });
      expect(mails).toEqual([]);
    });

    it("POST start is refused before the cutoff; POST pause stops a run", async () => {
      await inAll("org_1");
      expect(await admin("POST", BLACK_FRIDAY_CHECKOUT, { start: true })).toEqual({
        status: 409,
        body: { error: "too_early", message: TOO_EARLY },
      });
      clock = SEND_AT;
      expect(await admin("POST", BLACK_FRIDAY_CHECKOUT, { start: true })).toMatchObject({
        status: 200,
        body: { owed: 1, run: { campaign: BLACK_FRIDAY_CHECKOUT, state: "running" } },
      });
      expect(await admin("POST", BLACK_FRIDAY_CHECKOUT, { pause: true })).toMatchObject({
        status: 200,
        body: { paused: true, run: { state: "paused", note: "Paused from /admin." } },
      });
      await tick();
      expect(mails).toEqual([]);
    });

    it("POST test_to sends a test copy of each to hello@getengram.app only, through its own route, before the cutoff too", async () => {
      await org("org_hello", { email: "Hello@GetEngram.app" });
      await inAll("org_1");
      const copy = (route: string) => ({
        to: TEST_RECIPIENT,
        name: "Name org_hello",
        org_id: "org_hello",
        unsubscribe_url: `https://mcp.getengram.app/email/unsubscribe?org=org_hello&sig=${unsubscribeSig("org_hello")}`,
        offer_url: `${WEB}/black-friday?org=org_hello&sig=${offerSig("org_hello")}&utm_source=email&utm_campaign=blackfriday`,
        test: true,
        route,
        at: BEFORE,
      });
      for (const campaign of BLACK_FRIDAY_REMINDERS) {
        expect(await admin("POST", campaign, { test_to: " hello@getengram.app " })).toEqual({
          status: 200,
          body: { sent: true },
        });
        expect(await admin("POST", campaign, { test_to: "org_1@example.test" })).toEqual({
          status: 400,
          body: { error: "bad_request", message: "A test copy goes to hello@getengram.app only." },
        });
      }
      expect(mails).toEqual(BLACK_FRIDAY_REMINDERS.map(copy));
      // Nothing written: nobody is left out of the send, and there is no run.
      const sends = await db.prepare("SELECT COUNT(*) AS n FROM campaign_sends").first<{ n: number }>();
      expect(sends?.n).toBe(0);
      for (const campaign of BLACK_FRIDAY_REMINDERS) expect(await runRow(campaign)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  it("given start times in their order, each starts at its time, and nobody gets two", async () => {
    // In all three groups.
    await inAll("org_all");
    // Unpaid and checkout.
    await org("org_both");
    cancelled("org_both", CUTOFF_S - DAY_S);
    checkout("org_both", CUTOFF_S - DAY_S, "expired");
    // One address, an account in unpaid and another in checkout.
    await org("org_x_unpaid", { email: "x@example.test" });
    cancelled("org_x_unpaid", CUTOFF_S - DAY_S);
    await org("org_x_checkout", { email: "X@Example.test" });
    checkout("org_x_checkout", CUTOFF_S - DAY_S, "expired");
    // One group each.
    await org("org_checkout");
    checkout("org_checkout", CUTOFF_S - DAY_S, "expired");
    await org("org_unused", { created: NEW });

    // Given their times two hours before the cutoff, as they will be.
    const plan: [BlackFridayReminder, string, number][] = [
      [BLACK_FRIDAY_UNPAID, "2026-11-25T14:00:00Z", 3],
      [BLACK_FRIDAY_CHECKOUT, "2026-11-25T14:10:00Z", 4],
      [BLACK_FRIDAY_UNUSED, "2026-11-25T14:20:00Z", 2],
    ];
    for (const [campaign, at, owed] of plan) {
      expect(await admin("POST", campaign, { schedule_at: at })).toMatchObject({
        status: 200,
        body: { owed, run: { state: "scheduled", start_at: iso(Date.parse(at)) } },
      });
    }

    for (let at = SEND_AT - TICK; at <= SEND_AT + 30 * MINUTE; at += TICK) await cron(at);

    expect(mails.map((m) => [m.route, m.org_id, iso(m.at)])).toEqual([
      [BLACK_FRIDAY_UNPAID, "org_all", "2026-11-25T14:00:00.000Z"],
      [BLACK_FRIDAY_UNPAID, "org_both", "2026-11-25T14:00:00.000Z"],
      [BLACK_FRIDAY_UNPAID, "org_x_unpaid", "2026-11-25T14:00:00.000Z"],
      [BLACK_FRIDAY_CHECKOUT, "org_checkout", "2026-11-25T14:10:00.000Z"],
      [BLACK_FRIDAY_UNUSED, "org_unused", "2026-11-25T14:20:00.000Z"],
    ]);
    for (const campaign of BLACK_FRIDAY_REMINDERS) {
      expect(await runRow(campaign), campaign).toMatchObject({ state: "done", note: "Sent to everyone it was owed to." });
    }
  });

  // -------------------------------------------------------------------------
  it.each(BLACK_FRIDAY_REMINDERS)("an unsubscribe from %s is credited to it", async (campaign) => {
    await org("org_1");
    await db.batch([
      db.prepare(
        "INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES ('el_first', 'org_1', 'org_1@example.test', 'black-friday', '2026-11-18 05:00:00')",
      ),
      db
        .prepare(
          "INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES ('el_reminder', 'org_1', 'org_1@example.test', ?, '2026-11-25 14:00:05')",
        )
        .bind(campaign),
    ]);
    const res = await app.fetch(
      new Request(`${WORKER}/email/unsubscribe?org=org_1&sig=${unsubscribeSig("org_1")}`, { method: "POST" }),
      env(),
      ctx,
    );
    expect(res.status).toBe(200);
    const rows = await db
      .prepare("SELECT id, unsubscribed_at IS NOT NULL AS credited FROM email_log ORDER BY id")
      .all<{ id: string; credited: number }>();
    expect(rows.results).toEqual([
      { id: "el_first", credited: 0 },
      { id: "el_reminder", credited: 1 },
    ]);
  });

  // -------------------------------------------------------------------------
  describe("the late unpaid reminder (engram#789)", () => {
    const campaign = BLACK_FRIDAY_UNPAID_LATE;

    /**
     * Who it goes to, in the order it is sent: counted, then sent in one
     * batch at LATE_SEND_AT, through the unpaid reminder's route.
     */
    async function lateGets(): Promise<string[]> {
      clock = LATE_SEND_AT;
      const count = ok(await runBlackFridayReminder(env(), { campaign, dryRun: true }));
      const before = mails.length;
      const sent = ok(await runBlackFridayReminder(env(), { campaign, limit: 50 }));
      expect(sent).toMatchObject({ owed: count.owed, sent: count.owed, skipped: 0, failed: 0, stopped: false });
      const got = mails.slice(before);
      expect(got.every((m) => m.route === BLACK_FRIDAY_UNPAID)).toBe(true);
      return got.map((m) => m.org_id);
    }

    /** An account whose plan Stripe cancelled for a failed payment a minute after the first cutoff. */
    async function lateUnpaid(id: string, o: OrgOpts = {}) {
      await org(id, o);
      cancelled(id, CUTOFF_S + 60);
    }

    it("goes to a plan Stripe cancelled for a failed payment from the first cutoff until its own, on the Free plan now", async () => {
      for (const id of ["org_at_cutoff", "org_last_second", "org_early", "org_after", "org_asked"]) await org(id);
      await org("org_back", { tier: "pro" });
      cancelled("org_at_cutoff", CUTOFF_S);
      cancelled("org_last_second", LATE_CUTOFF_S - 1);
      // The unpaid reminder's.
      cancelled("org_early", CUTOFF_S - 1);
      // Once its group was fixed.
      cancelled("org_after", LATE_CUTOFF_S);
      cancelled("org_asked", CUTOFF_S + 60, "cancellation_requested");
      // On a paid plan again since.
      cancelled("org_back", CUTOFF_S + 60);

      expect(await whoGets(BLACK_FRIDAY_UNPAID)).toEqual(["org_early"]);
      expect(await lateGets()).toEqual(["org_at_cutoff", "org_last_second"]);
    });

    it.each(BLACK_FRIDAY_REMINDERS)("leaves out an address %s has gone to", async (other) => {
      await lateUnpaid("org_1");
      await lateUnpaid("org_2");
      await sendInsert(other, "org_1@example.test", "org_1").run();
      expect(await lateGets()).toEqual(["org_2"]);
    });

    it("the other reminders leave out an address it has gone to", async () => {
      // In the checkout and unused groups too.
      await lateUnpaid("org_1", { created: NEW });
      checkout("org_1", CUTOFF_S - DAY_S, "expired");
      expect(await owedCounts()).toEqual({ [BLACK_FRIDAY_UNPAID]: 0, [BLACK_FRIDAY_CHECKOUT]: 1, [BLACK_FRIDAY_UNUSED]: 1 });
      expect(await lateGets()).toEqual(["org_1"]);
      expect(await owedCounts()).toEqual({ [BLACK_FRIDAY_UNPAID]: 0, [BLACK_FRIDAY_CHECKOUT]: 0, [BLACK_FRIDAY_UNUSED]: 0 });
    });

    it("is sent from its own cutoff until the offer's last day begins, with mail and Stripe set up; counted at any time", async () => {
      await lateUnpaid("org_1");
      const send = (e = env()) => runBlackFridayReminder(e, { campaign, limit: 50 });

      clock = CUTOFF;
      expect(ok(await runBlackFridayReminder(env(), { campaign, dryRun: true })).owed).toBe(1);
      vi.mocked(fetch).mockClear();
      // The first three may go from here; this one may not.
      expect(await send()).toEqual({ error: "too_early", message: LATE_TOO_EARLY, status: 409 });
      clock = LATE_CUTOFF - 1;
      expect(await send()).toEqual({ error: "too_early", message: LATE_TOO_EARLY, status: 409 });
      clock = LAST_DAY;
      expect(await send()).toEqual({ error: "too_late", message: TOO_LATE, status: 409 });
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await send()).toMatchObject({ error: "offer_ended", status: 410 });
      clock = LATE_CUTOFF;
      expect(await send(env({ INTERNAL_CRON_SECRET: "", ADMIN_SECRET: "" }))).toMatchObject({
        error: "mail_not_configured",
      });
      expect(await send(env({ STRIPE_SECRET_KEY: "" }))).toMatchObject({ error: "stripe_not_configured", status: 500 });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(mails).toEqual([]);

      expect(blackFridayReminderRefusal(env(), campaign, LAST_DAY - 1)).toBeNull();
      expect(ok(await send())).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => [m.route, m.org_id])).toEqual([[BLACK_FRIDAY_UNPAID, "org_1"]]);
    });

    it("/admin: for the admin only; GET shows its cutoff; the test copy goes through the unpaid route; a start time before its cutoff is refused; the cron sends it once at its time", async () => {
      await org("org_hello", { email: "Hello@GetEngram.app" });
      await lateUnpaid("org_1");
      clock = CUTOFF + HOUR;

      expect((await admin("GET", campaign, undefined, "wrong")).status).toBe(401);
      expect((await admin("POST", campaign, { start: true }, "wrong")).status).toBe(401);
      expect(await admin("GET", campaign)).toEqual({
        status: 200,
        body: { campaign, owed: 1, cutoff: "2026-11-26T01:00:00.000Z", recorded: {}, run: null },
      });
      expect(await admin("POST", campaign, { test_to: "hello@getengram.app" })).toEqual({
        status: 200,
        body: { sent: true },
      });
      expect(mails.map((m) => [m.route, m.to, m.org_id, m.test])).toEqual([
        [BLACK_FRIDAY_UNPAID, TEST_RECIPIENT, "org_hello", true],
      ]);
      expect(await admin("POST", campaign, { start: true })).toEqual({
        status: 409,
        body: { error: "too_early", message: LATE_TOO_EARLY },
      });
      expect(await admin("POST", campaign, { schedule_at: "2026-11-26T00:58:00Z" })).toEqual({
        status: 409,
        body: { error: "too_early", message: LATE_TOO_EARLY },
      });
      expect(await admin("POST", campaign, { schedule_at: "2026-11-26T14:00:00Z" })).toMatchObject({
        status: 200,
        body: { owed: 1, run: { campaign, state: "scheduled", start_at: "2026-11-26T14:00:00.000Z" } },
      });

      for (let at = LATE_SEND_AT - 2 * TICK; at <= LATE_SEND_AT + 10 * MINUTE; at += TICK) await cron(at);
      expect(mails.slice(1).map((m) => [m.route, m.org_id, iso(m.at)])).toEqual([
        [BLACK_FRIDAY_UNPAID, "org_1", "2026-11-26T14:00:00.000Z"],
      ]);
      expect(await runRow(campaign)).toMatchObject({ state: "done", note: "Sent to everyone it was owed to." });
      expect(await admin("GET", campaign)).toMatchObject({ status: 200, body: { owed: 0 } });
    });
  });

  // -------------------------------------------------------------------------
  it("its statements never walk campaign_sends, email_opt_outs or conversations", async () => {
    const sql: string[] = [];
    const e = env({ DB: recording(sql) });
    await inAll("org_1");
    await inAll("org_2");
    await convo("org_2", 1);
    await inAll("org_3");
    await convo("org_3", 1);
    await convo("org_3", 1);
    clock = SEND_AT;
    for (const campaign of BLACK_FRIDAY_REMINDERS) {
      ok(await runBlackFridayReminder(e, { campaign, dryRun: true }));
      ok(await runBlackFridayReminder(e, { campaign, limit: 50 }));
    }
    expect(mails.map((m) => [m.route, m.org_id])).toEqual([
      [BLACK_FRIDAY_UNPAID, "org_1"],
      [BLACK_FRIDAY_UNPAID, "org_2"],
      [BLACK_FRIDAY_UNPAID, "org_3"],
    ]);

    const touching = [...new Set(sql)].filter((q) => /\b(campaign_sends|email_opt_outs|conversations)\b/.test(q));
    expect(touching.some((q) => /\bconversations\b/.test(q))).toBe(true);
    expect(touching.some((q) => /\bemail_opt_outs\b/.test(q))).toBe(true);
    for (const q of touching) {
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${q}`)
          .bind(...Array.from({ length: paramCount(q) }, () => "x"))
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      expect(plan.filter((line) => /^SCAN (campaign_sends|email_opt_outs|conversations|c)\b/.test(line)), q).toEqual([]);
      if (/\bconversations\b/.test(q)) {
        expect(plan.filter((line) => /^SEARCH c USING (COVERING )?INDEX idx_conversations_/.test(line)), q).toHaveLength(2);
      }
    }
  });
});
