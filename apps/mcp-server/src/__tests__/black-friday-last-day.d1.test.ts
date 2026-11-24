import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import app from "../index.js";
import {
  BLACK_FRIDAY_FOURTH,
  BLACK_FRIDAY_LAST_DAY,
  BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS,
  TEST_RECIPIENT,
  blackFridayOpens,
  runBlackFridayLastDay,
  type CampaignResult,
} from "../services/black-friday-campaign.js";
import {
  campaignRun,
  pauseCampaignRun,
  runCampaignTick,
  scheduleCampaignRun,
  startCampaignRun,
} from "../services/campaign-runs.js";
import { BLACK_FRIDAY_ENDS_AT_MS } from "../services/black-friday.js";
import { applyAllMigrations, applyMigration } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The last-day Black Friday email and the scheduled start (engram#785),
 * against real SQLite with the real migrations: who the email goes to, that
 * it goes on the offer's last day only and through its own route on
 * engram-web, a run that is given a time and started by the cron at that
 * time, the /admin switch for all of it, the test copy, and migration 0052
 * on a table that already holds runs.
 */

const KEY = "link-key-785-test";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
/** Ten days before the deadline: the offer is on sale, and it is not its last day. */
const BEFORE = BLACK_FRIDAY_ENDS_AT_MS - 10 * 86_400_000;
/** The first moment of the offer's last day. */
const LAST_DAY = BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS;
/** 14:00 UTC on the last day: a time the send can be scheduled for. */
const SEND_AT = LAST_DAY + 9 * 3_600_000;
const SEND_AT_TEXT = "2026-11-27T14:00:00Z";
const SEND_AT_ISO = "2026-11-27T14:00:00.000Z";
const HOUR = 3_600_000;
/** The cron's interval. */
const TICK = 120_000;

const TOO_EARLY = {
  error: "too_early",
  message: "The last-day email is sent only on the offer's last day, from 2026-11-27T05:00:00.000Z; nothing was sent.",
};
const waitingFor = (other: string) => `Waiting for ${other} to end; this one starts after it.`;

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

interface OrgOpts {
  email?: string | null;
  tier?: string;
  optOut?: boolean;
  deleted?: boolean;
  source?: string;
}

interface RunRow {
  state: string;
  note: string | null;
  lease_until: number | null;
  failed_ticks: number;
  start_at: number | null;
  updated_at: string;
  finished_at: string | null;
}

/** EXPLAIN QUERY PLAN takes as many values as the statement has parameters. */
function paramCount(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  return numbered.length > 0 ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
}

describe("The last-day Black Friday email and its scheduled start (engram#785), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  /** A database that stops at migration 0050, for migration 0052's own test. */
  let old: D1Database;
  let clock: number;
  /** Last-day emails engram-web sent. */
  let mails: Mail[];
  /** Emails engram-web sent through the first email's route, which the resends use. */
  let firstRouteMails: Mail[];
  /** What engram-web answers on the last-day route: a status, or "throw" for no answer at all. */
  let webAnswer: (mail: Mail) => number | "throw" | Promise<number | "throw">;
  /** How many times something was slipped in just as a tick went to start a scheduled run (see `meanwhile`). */
  let interrupted: number;
  let logId = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "black-friday-last-day", OLD: "campaign-runs-before-0052" },
    });
    db = await mf.getD1Database("DB");
    old = await mf.getD1Database("OLD");
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
    firstRouteMails = [];
    webAnswer = () => 200;
    interrupted = 0;
    clock = BEFORE;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const lastDay = url.pathname === "/api/email/black-friday-last-day";
        if (url.origin === WEB && (lastDay || url.pathname === "/api/email/black-friday")) {
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer web-bearer");
          const mail = JSON.parse(String(init?.body)) as Mail;
          if (!lastDay) {
            firstRouteMails.push(mail);
            return new Response("{}", { status: 200 });
          }
          const answer = await webAnswer(mail);
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

  const orgInsert = (id: string, o: OrgOpts = {}) =>
    db
      .prepare(
        `INSERT INTO organizations (id, name, email, tier, digest_opt_out, deleted_at, referral_source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-01 00:00:00')`,
      )
      .bind(
        id,
        `Name ${id}`,
        o.email === undefined ? `${id}@example.test` : o.email,
        o.tier ?? "free",
        o.optOut ? 1 : 0,
        o.deleted ? "2026-11-19 00:00:00" : null,
        o.source ?? "chatgpt",
      );

  const sendInsert = (campaign: string, address: string, orgId: string, status = "sent") =>
    db
      .prepare("INSERT INTO campaign_sends (campaign, email, org_id, status) VALUES (?, ?, ?, ?)")
      .bind(campaign, address, orgId, status);

  const logInsert = (recipient: string, o: { opened?: boolean; type?: string } = {}) =>
    db
      .prepare("INSERT INTO email_log (id, org_id, recipient, type, opened_at) VALUES (?, NULL, ?, ?, ?)")
      .bind(`el_${++logId}`, recipient, o.type ?? "black-friday", o.opened === false ? null : "2026-11-18 06:00:00");

  /** An account. Free, with an email, subscribed to email, unless told otherwise. */
  async function org(id: string, o: OrgOpts = {}) {
    await orgInsert(id, o).run();
  }

  /** An account the first email went to, at its address as it was then. It has opened nothing. */
  async function got(id: string, o: OrgOpts & { status?: string } = {}) {
    const email = o.email === undefined ? `${id}@example.test` : String(o.email);
    await db.batch([orgInsert(id, o), sendInsert("black-friday", email.trim().toLowerCase(), id, o.status)]);
  }

  /** An email engram-web logged, opened unless told otherwise. */
  async function logged(recipient: string, o: { opened?: boolean; type?: string } = {}) {
    await logInsert(recipient, o).run();
  }

  /** An account the first email went to that has opened a Black Friday email. */
  async function opened(id: string, o: OrgOpts & { status?: string } = {}) {
    const email = o.email === undefined ? `${id}@example.test` : String(o.email);
    const address = email.trim().toLowerCase();
    await db.batch([orgInsert(id, o), sendInsert("black-friday", address, id, o.status), logInsert(address)]);
  }

  /** `n` accounts the first email went to that have opened nothing, org_000 onwards. */
  async function gotMany(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `org_${String(i).padStart(3, "0")}`);
    await db.batch(ids.flatMap((id) => [orgInsert(id), sendInsert("black-friday", `${id}@example.test`, id)]));
    return ids;
  }

  /** `n` accounts the first email went to that have opened one, org_000 onwards. */
  async function openedMany(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `org_${String(i).padStart(3, "0")}`);
    await db.batch(
      ids.flatMap((id) => [
        orgInsert(id),
        sendInsert("black-friday", `${id}@example.test`, id),
        logInsert(`${id}@example.test`),
      ]),
    );
    return ids;
  }

  /** The account bought the offer. */
  const bought = (orgId: string, session: string) =>
    db
      .prepare(
        "INSERT INTO prepaid_plans (session_id, org_id, offer, tier, ends_at) VALUES (?, ?, 'black-friday', 'pro', '2027-11-19 00:00:00')",
      )
      .bind(session, orgId)
      .run();

  const sendsOf = async (campaign: string) =>
    (
      await db
        .prepare("SELECT email, org_id, status FROM campaign_sends WHERE campaign = ? ORDER BY email")
        .bind(campaign)
        .all<{ email: string; org_id: string; status: string }>()
    ).results;
  const lastDaySends = () => sendsOf(BLACK_FRIDAY_LAST_DAY);

  const runRow = (campaign = BLACK_FRIDAY_LAST_DAY) =>
    db
      .prepare(
        "SELECT state, note, lease_until, failed_ticks, start_at, updated_at, finished_at FROM campaign_runs WHERE campaign = ?",
      )
      .bind(campaign)
      .first<RunRow>();

  const ok = (r: Awaited<ReturnType<typeof runBlackFridayLastDay>>) => {
    if ("error" in r) throw new Error(`send refused: ${r.error}`);
    return r as CampaignResult;
  };

  /** The next cron tick, two minutes after the last. */
  async function tick(e: Env = env()) {
    clock += TICK;
    return runCampaignTick(e);
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

  async function start(e: Env = env()) {
    const r = await startCampaignRun(e, BLACK_FRIDAY_LAST_DAY);
    if ("error" in r) throw new Error(`start refused: ${r.error}`);
    return r.run;
  }

  async function schedule(at = SEND_AT, e: Env = env()) {
    const r = await scheduleCampaignRun(e, BLACK_FRIDAY_LAST_DAY, at);
    if ("error" in r) throw new Error(`schedule refused: ${r.error}`);
    return r.run;
  }

  async function admin(method: "GET" | "POST", body?: unknown, bearer = "admin-test") {
    const res = await app.fetch(
      new Request(`${WORKER}/admin/campaigns/black-friday-last-day`, {
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

  /**
   * A database on which `first` happens just as a tick goes to start a
   * scheduled run: after the tick has found the run due, before its one
   * statement that makes the run a running one. `interrupted` counts the
   * times it happened, so a test knows the moment really came.
   */
  function meanwhile(first: () => Promise<unknown>): D1Database {
    return new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") {
          return (query: string) => {
            const statement = target.prepare(query);
            if (!/SET state = 'running', start_at = NULL, note = NULL/.test(query)) return statement;
            return {
              bind: (...values: unknown[]) => ({
                run: async () => {
                  interrupted++;
                  await first();
                  return statement.bind(...values).run();
                },
              }),
            };
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  // -------------------------------------------------------------------------
  describe("who it goes to", () => {
    beforeEach(() => {
      clock = SEND_AT;
    });

    /**
     * Five people who should get it, and one of every kind that should not.
     * Everyone below has opened a Black Friday email unless it says not.
     */
    async function everyone() {
      await opened("org_open");
      // Typed with capitals and spaces; the first email went to it.
      await opened("org_mixed", { email: " Mixed@Example.test " });
      // engram-web logged the address as it was typed.
      await got("org_open_typed", { email: "Open_Typed@example.test" });
      await logged(" Open_Typed@Example.test ");
      // Opened one Black Friday email and left another unopened.
      await opened("org_two_logs");
      await logged("org_two_logs@example.test", { opened: false });
      // The first send never heard back; a later one was opened.
      await opened("org_unknown", { status: "unknown" });

      // Got the first email; no open of any email is on record.
      await got("org_never");
      // Logged by engram-web, never opened.
      await got("org_unopened");
      await logged("org_unopened@example.test", { opened: false });
      // Opened a weekly digest, not a Black Friday email.
      await got("org_digest");
      await logged("org_digest@example.test", { type: "weekly-digest" });
      // A customer now.
      await opened("org_paid", { tier: "pro" });
      // Still on Free, but the same person has a paid account.
      await opened("org_twin");
      await org("org_twin_pro", { email: "ORG_TWIN@example.test", tier: "team" });
      // Bought the offer, then a refund put the account back on Free.
      await opened("org_bought");
      await bought("org_bought", "cs_1");
      // The same person bought it on another account.
      await opened("org_bought_twin");
      await org("org_bought_twin_2", { email: "Org_Bought_Twin@example.test" });
      await bought("org_bought_twin_2", "cs_2");
      // Unsubscribed since.
      await opened("org_out", { optOut: true });
      // The same person unsubscribed on another account.
      await opened("org_out_twin");
      await org("org_out_twin_2", { email: "ORG_OUT_TWIN@example.test", optOut: true });
      // Unsubscribed through the finish-sign-up email's link.
      await opened("org_opted");
      await db
        .prepare("INSERT INTO email_opt_outs (email, user_id, source) VALUES ('org_opted@example.test', NULL, 'finish-signup')")
        .run();
      // Deleted since.
      await opened("org_deleted", { deleted: true });
      // Internal.
      await opened("org_internal", { source: "internal" });
      // Changed address since; the open was at the old one.
      await opened("org_moved");
      await db.prepare("UPDATE organizations SET email = 'new-address@example.test' WHERE id = 'org_moved'").run();
      // Signed up after the first email, so it never went to this address.
      await org("org_new");
      await logged("org_new@example.test");
      // Has the last-day email already, or may have.
      await opened("org_has_it");
      await sendInsert(BLACK_FRIDAY_LAST_DAY, "org_has_it@example.test", "org_has_it").run();
      await opened("org_may_have_it");
      await sendInsert(BLACK_FRIDAY_LAST_DAY, "org_may_have_it@example.test", "org_may_have_it", "unknown").run();
    }

    /** In the order it is sent: by address. */
    const OWED_TO = ["org_mixed", "org_open_typed", "org_open", "org_two_logs", "org_unknown"];

    it("a dry run counts the addresses owed it and sends nothing, on any day", async () => {
      await everyone();
      for (const day of [BEFORE, SEND_AT]) {
        clock = day;
        expect(ok(await runBlackFridayLastDay(env(), { dryRun: true }))).toEqual({
          dry_run: true,
          owed: OWED_TO.length,
          sent: 0,
          skipped: 0,
          failed: 0,
          stopped: false,
          recorded: { sent: 1, unknown: 1 },
        });
      }
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect((await lastDaySends()).map((s) => s.org_id)).toEqual(["org_has_it", "org_may_have_it"]);
    });

    it("goes only to people the first email went to who opened a Black Friday email and could still buy", async () => {
      await everyone();
      const before = await sendsOf("black-friday");
      const r = ok(await runBlackFridayLastDay(env(), { limit: 50 }));
      expect(r).toMatchObject({
        dry_run: false,
        owed: 5,
        sent: 5,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: { sent: 6, unknown: 1 },
      });
      expect(mails.map((m) => m.org_id)).toEqual(OWED_TO);
      expect((await lastDaySends()).map((s) => [s.org_id, s.status])).toEqual(
        // Ordered by address.
        [
          ["org_mixed", "sent"],
          ["org_open_typed", "sent"],
          ["org_has_it", "sent"],
          ["org_may_have_it", "unknown"],
          ["org_open", "sent"],
          ["org_two_logs", "sent"],
          ["org_unknown", "sent"],
        ],
      );
      // The first send's record is left as it was, and nothing went through its route.
      expect(await sendsOf("black-friday")).toEqual(before);
      expect(firstRouteMails).toEqual([]);
    });

    it("is its own email on its own route, to the address as typed, with links signed for that account", async () => {
      await opened("org_mixed", { email: " Mixed@Example.test " });
      ok(await runBlackFridayLastDay(env(), {}));
      expect(mails).toEqual([
        {
          to: "Mixed@Example.test",
          name: "Name org_mixed",
          org_id: "org_mixed",
          unsubscribe_url: `https://mcp.getengram.app/email/unsubscribe?org=org_mixed&sig=${unsubscribeSig("org_mixed")}`,
          offer_url: `${WEB}/black-friday?org=org_mixed&sig=${offerSig("org_mixed")}&utm_source=email&utm_campaign=blackfriday`,
        },
      ]);
      expect(firstRouteMails).toEqual([]);
      expect(await lastDaySends()).toEqual([{ email: "mixed@example.test", org_id: "org_mixed", status: "sent" }]);
    });

    it("is not sent before the offer's last day, and is from that day's first moment", async () => {
      await opened("org_1");
      for (const early of [BEFORE, LAST_DAY - 1]) {
        clock = early;
        expect(await runBlackFridayLastDay(env(), { limit: 50 })).toEqual({ ...TOO_EARLY, status: 409 });
      }
      // The time the cron hands it decides, not the clock.
      clock = SEND_AT;
      expect(await runBlackFridayLastDay(env(), { limit: 50, now: LAST_DAY - 1 })).toEqual({ ...TOO_EARLY, status: 409 });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await lastDaySends()).toEqual([]);

      clock = LAST_DAY;
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1"]);
    });

    it("is not sent once the offer has ended", async () => {
      await opened("org_1");
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await runBlackFridayLastDay(env(), { limit: 50 })).toMatchObject({ error: "offer_ended", status: 410 });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await lastDaySends()).toEqual([]);
    });

    it("an open, a purchase or an unsubscribe during the send counts at the next batch", async () => {
      await opened("org_1");
      await opened("org_2");
      await opened("org_3");
      await got("org_4");
      expect(ok(await runBlackFridayLastDay(env(), { limit: 1 }))).toMatchObject({ owed: 3, sent: 1 });
      await bought("org_2", "cs_1");
      await db.prepare("UPDATE organizations SET digest_opt_out = 1 WHERE id = 'org_3'").run();
      await logged("org_4@example.test");
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_4"]);
    });

    it("never sends it twice to one address", async () => {
      await opened("org_1");
      await opened("org_2");
      ok(await runBlackFridayLastDay(env(), { limit: 50 }));
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 0, sent: 0, skipped: 0 });
      expect(mails).toHaveLength(2);
    });

    it("caps a batch at 50", async () => {
      await openedMany(53);
      expect(ok(await runBlackFridayLastDay(env(), { limit: 5000 })).sent).toBe(50);
      expect(ok(await runBlackFridayLastDay(env(), { limit: 5000 }))).toMatchObject({ owed: 3, sent: 3 });
    });

    it("a website that says it is too early, or has no such route, sent nothing: the address is tried again", async () => {
      await opened("org_1");
      await opened("org_2");
      // 409: not the last day by the website's clock. 404: a website without the route.
      webAnswer = (m) => (m.org_id === "org_1" ? 409 : 404);
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({
        owed: 2,
        sent: 0,
        failed: 2,
        stopped: false,
        recorded: {},
      });
      expect(await lastDaySends()).toEqual([]);
      webAnswer = () => 200;
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 2, sent: 2 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2"]);
    });

    it("keeps the claim when engram-web gave no clear answer, so that address is not tried again", async () => {
      await opened("org_1");
      await opened("org_2");
      webAnswer = (m) => (m.org_id === "org_1" ? 502 : "throw");
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({
        sent: 0,
        failed: 2,
        recorded: { unknown: 2 },
      });
      webAnswer = () => 200;
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 0, sent: 0 });
      expect(mails).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the cron sends it on the last day", () => {
    it("cannot be started before the last day, and nothing is written", async () => {
      await opened("org_1");
      for (const early of [BEFORE, LAST_DAY - 1]) {
        clock = early;
        expect(await startCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toEqual({ ...TOO_EARLY, status: 409 });
      }
      expect(await runRow()).toBeNull();
      expect(await tick()).toEqual([]);
      expect(mails).toEqual([]);
    });

    it("started on the last day, it goes a batch each tick until nobody is owed it, then ends itself", async () => {
      const ids = await openedMany(55);
      clock = SEND_AT;
      expect(await start()).toMatchObject({
        campaign: BLACK_FRIDAY_LAST_DAY,
        state: "running",
        sending: false,
        note: null,
        start_at: null,
      });
      expect(mails).toEqual([]);

      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "running", result: { owed: 55, sent: 50 } });
      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "running", result: { owed: 5, sent: 5 } });
      expect((await tick())[0]).toMatchObject({
        outcome: "batch",
        state: "done",
        note: "Sent to everyone it was owed to.",
        result: { owed: 0 },
      });
      expect((await runRow())?.finished_at).not.toBeNull();

      expect(await tick()).toEqual([]);
      expect(mails.map((m) => m.org_id).sort()).toEqual(ids);
      expect(firstRouteMails).toEqual([]);
    });

    it("ends itself without sending once the offer has ended", async () => {
      await opened("org_1");
      clock = SEND_AT;
      await start();
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect((await runCampaignTick(env()))[0]).toMatchObject({
        outcome: "batch",
        state: "done",
        note: "The offer has ended; nothing was sent.",
        result: null,
      });
      expect(await runRow()).toMatchObject({ state: "done", lease_until: null });
      expect(mails).toEqual([]);
    });

    it("pauses when engram-web refuses every send, and everyone can still get it once that is put right", async () => {
      await opened("org_1");
      await opened("org_2");
      clock = SEND_AT;
      await start();
      webAnswer = () => 409;
      expect((await tick())[0]).toMatchObject({
        state: "paused",
        note: "No send in the last batch went through; see the worker log.",
        result: { sent: 0, failed: 2, stopped: false },
      });
      expect(await lastDaySends()).toEqual([]);
      expect(await tick()).toEqual([]);

      webAnswer = () => 200;
      await start();
      expect((await tick())[0]).toMatchObject({ state: "running", result: { owed: 2, sent: 2 } });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2"]);
    });

    it("stops a batch after three refusals in a row: a website without the route is asked three times, not fifty", async () => {
      await openedMany(6);
      clock = SEND_AT;
      await start();
      webAnswer = () => 404;
      expect((await tick())[0]).toMatchObject({
        state: "paused",
        note: "Stopped after repeated failed sends; see the worker log.",
        result: { sent: 0, failed: 3, stopped: true },
      });
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(3);
      expect(await lastDaySends()).toEqual([]);
      expect(await tick()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("a start scheduled for a time", () => {
    it("the time used here is on the offer's last day", () => {
      expect(new Date(LAST_DAY).toISOString()).toBe("2026-11-27T05:00:00.000Z");
      expect(new Date(SEND_AT).toISOString()).toBe(SEND_AT_ISO);
      expect(Date.parse(SEND_AT_TEXT)).toBe(SEND_AT);
      expect(SEND_AT).toBeLessThan(BLACK_FRIDAY_ENDS_AT_MS);
    });

    it("sends nothing, and leaves the cron nothing to do, until its time", async () => {
      await opened("org_1");
      expect(await schedule()).toMatchObject({
        campaign: BLACK_FRIDAY_LAST_DAY,
        state: "scheduled",
        start_at: SEND_AT_ISO,
        sending: false,
        note: null,
        failed_ticks: 0,
        finished_at: null,
      });
      expect(await runRow()).toMatchObject({ state: "scheduled", start_at: SEND_AT, lease_until: null });

      expect(await tick()).toEqual([]);
      clock = SEND_AT - 1;
      expect(await runCampaignTick(env())).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await lastDaySends()).toEqual([]);
      expect(await runRow()).toMatchObject({ state: "scheduled", start_at: SEND_AT });
    });

    it("a tick with nothing running or due asks the database one question", async () => {
      await opened("org_1");
      await schedule();
      const sql: string[] = [];
      expect(await tick(env({ DB: recording(sql) }))).toEqual([]);
      expect(sql).toHaveLength(1);
      expect(sql[0]).toMatch(/FROM campaign_runs/);
    });

    it("the first tick at or after its time starts it and sends its first batch", async () => {
      const ids = await openedMany(55);
      await schedule();
      clock = SEND_AT;
      const outcomes = await runCampaignTick(env());
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        campaign: BLACK_FRIDAY_LAST_DAY,
        outcome: "batch",
        state: "running",
        note: null,
        result: { owed: 55, sent: 50 },
      });
      expect(await runRow()).toMatchObject({ state: "running", start_at: null, lease_until: null, finished_at: null });

      // From here it is a running run like any other.
      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "running", result: { owed: 5, sent: 5 } });
      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "done", note: "Sent to everyone it was owed to." });
      expect(await tick()).toEqual([]);
      expect(mails.map((m) => m.org_id).sort()).toEqual(ids);
      expect(await campaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toMatchObject({ state: "done", start_at: null });
    });

    it("starts at the first tick after its time when none falls on it", async () => {
      await opened("org_1");
      await schedule(SEND_AT + 30_000);
      clock = SEND_AT;
      expect(await runCampaignTick(env())).toEqual([]);
      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "running", result: { owed: 1, sent: 1 } });
    });

    it("is refused for a time that is not ahead, before the last day, or after the offer ends; nothing is written", async () => {
      await opened("org_1");
      const at = (time: number) => scheduleCampaignRun(env(), BLACK_FRIDAY_LAST_DAY, time);
      for (const past of [clock, clock - 1, 0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8.64e15 + 1]) {
        expect(await at(past)).toEqual({
          error: "bad_request",
          message: "The start time must be a time in the future.",
          status: 400,
        });
      }
      for (const early of [clock + 60_000, LAST_DAY - 1]) {
        expect(await at(early)).toEqual({ ...TOO_EARLY, status: 409 });
      }
      for (const late of [BLACK_FRIDAY_ENDS_AT_MS, BLACK_FRIDAY_ENDS_AT_MS + 86_400_000]) {
        expect(await at(late)).toMatchObject({ error: "offer_ended", status: 410 });
      }
      expect(await runRow()).toBeNull();

      // The first and the last moment it can be set for.
      expect((await schedule(LAST_DAY)).start_at).toBe("2026-11-27T05:00:00.000Z");
      expect((await schedule(BLACK_FRIDAY_ENDS_AT_MS - 1)).start_at).toBe("2026-11-28T04:59:59.999Z");
    });

    it("is refused for a campaign the worker cannot send", async () => {
      expect(await scheduleCampaignRun(env(), "black-friday", SEND_AT)).toEqual({
        error: "unknown_campaign",
        message: "The worker has no sender for this campaign.",
        status: 404,
      });
      expect(await runRow("black-friday")).toBeNull();
    });

    it("is refused while the campaign is running, and the run goes on", async () => {
      await openedMany(51);
      clock = SEND_AT;
      await start();
      expect(await scheduleCampaignRun(env(), BLACK_FRIDAY_LAST_DAY, SEND_AT + HOUR)).toEqual({
        error: "already_running",
        message: "This campaign is running; pause it before giving it a start time.",
        status: 409,
      });
      expect(await runRow()).toMatchObject({ state: "running", start_at: null });
      expect((await tick())[0]).toMatchObject({ outcome: "batch", state: "running", result: { sent: 50 } });
    });

    it("can be moved to another time, and a finished run can be given one", async () => {
      await opened("org_1");
      await schedule();
      expect((await schedule(SEND_AT + HOUR)).start_at).toBe("2026-11-27T15:00:00.000Z");
      clock = SEND_AT;
      expect(await runCampaignTick(env())).toEqual([]);
      clock = SEND_AT + HOUR;
      expect((await runCampaignTick(env()))[0]).toMatchObject({ outcome: "batch", result: { sent: 1 } });
      expect((await tick())[0]).toMatchObject({ state: "done" });
      expect((await runRow())?.finished_at).not.toBeNull();

      // Someone opened one since; the finished run is given a time again.
      await opened("org_2");
      expect(await schedule(clock + 10 * 60_000)).toMatchObject({ state: "scheduled", note: null, finished_at: null });
      clock += 10 * 60_000;
      expect((await runCampaignTick(env()))[0]).toMatchObject({
        outcome: "batch",
        state: "running",
        result: { owed: 1, sent: 1 },
      });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2"]);
    });

    it("starting it by hand drops the time it was scheduled for", async () => {
      await opened("org_1");
      await schedule(SEND_AT + HOUR);
      clock = SEND_AT;
      expect(await start()).toMatchObject({ state: "running", start_at: null });
      expect((await tick())[0]).toMatchObject({ outcome: "batch", result: { sent: 1 } });
      expect((await tick())[0]).toMatchObject({ state: "done" });
      clock = SEND_AT + HOUR;
      expect(await runCampaignTick(env())).toEqual([]);
      expect(mails).toHaveLength(1);
    });

    it("a pause cancels it: nothing goes at its time, and it can be given a time again", async () => {
      await opened("org_1");
      await schedule();
      expect(await pauseCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toMatchObject({
        paused: true,
        run: { state: "paused", note: "Scheduled start cancelled from /admin.", start_at: null },
      });
      expect(await pauseCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toMatchObject({ paused: false });
      clock = SEND_AT;
      expect(await runCampaignTick(env())).toEqual([]);
      expect(await tick()).toEqual([]);
      expect(mails).toEqual([]);

      expect(await schedule(SEND_AT + HOUR)).toMatchObject({
        state: "scheduled",
        note: null,
        start_at: "2026-11-27T15:00:00.000Z",
      });
    });

    it("waits for a campaign that is running at its time, and starts in the tick that finds that one done", async () => {
      // 51 people who have opened nothing are owed the fourth email; two who opened one are owed this.
      await gotMany(51);
      await opened("org_a");
      await opened("org_b");
      await schedule();
      clock = SEND_AT - TICK;
      expect(await startCampaignRun(env(), BLACK_FRIDAY_FOURTH)).toMatchObject({ run: { state: "running" } });

      const waiting = {
        campaign: BLACK_FRIDAY_LAST_DAY,
        outcome: "not_started",
        state: "scheduled",
        result: null,
        note: waitingFor(BLACK_FRIDAY_FOURTH),
      };
      // Its time has come and the fourth email is still going out.
      let outcomes = await tick();
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({ campaign: BLACK_FRIDAY_FOURTH, outcome: "batch", state: "running", result: { sent: 50 } });
      expect(outcomes[1]).toEqual(waiting);
      expect(await campaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toMatchObject({
        state: "scheduled",
        start_at: SEND_AT_ISO,
        note: waitingFor(BLACK_FRIDAY_FOURTH),
      });

      // The note is written when the wait begins, not again at every tick of it.
      await db
        .prepare("UPDATE campaign_runs SET updated_at = '2000-01-01 00:00:00' WHERE campaign = ?")
        .bind(BLACK_FRIDAY_LAST_DAY)
        .run();
      outcomes = await tick();
      expect(outcomes[0]).toMatchObject({ campaign: BLACK_FRIDAY_FOURTH, state: "running", result: { owed: 1, sent: 1 } });
      expect(outcomes[1]).toEqual(waiting);
      expect((await runRow())?.updated_at).toBe("2000-01-01 00:00:00");
      expect(mails).toEqual([]);

      // Starting it by hand is refused for the same reason.
      expect(await startCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)).toMatchObject({ error: "another_campaign_running" });

      // This tick finds nobody owed the fourth email, ends it, then starts this one.
      outcomes = await tick();
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({ campaign: BLACK_FRIDAY_FOURTH, outcome: "batch", state: "done" });
      expect(outcomes[1]).toMatchObject({
        campaign: BLACK_FRIDAY_LAST_DAY,
        outcome: "batch",
        state: "running",
        note: null,
        result: { owed: 2, sent: 2 },
      });
      expect(mails.map((m) => m.org_id)).toEqual(["org_a", "org_b"]);
      expect(firstRouteMails).toHaveLength(51);
      expect(await runRow()).toMatchObject({ state: "running", start_at: null, note: null });
    });

    it("at its time, with mail not configured, it stops unsent and says why", async () => {
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      const broken = env({ UNSUBSCRIBE_HMAC_KEY: undefined, ADMIN_SECRET: undefined });
      expect(await runCampaignTick(broken)).toEqual([
        {
          campaign: BLACK_FRIDAY_LAST_DAY,
          outcome: "not_started",
          state: "paused",
          result: null,
          note: "No website bearer, signing key or APP_URL; nothing was sent.",
        },
      ]);
      expect(await runRow()).toMatchObject({ state: "paused", start_at: null, finished_at: null });
      const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
      expect(errors.some((l) => l.includes("not started at its scheduled time -> paused"))).toBe(true);
      expect(await tick()).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("a run whose time comes only after the offer has ended ends unsent", async () => {
      await opened("org_1");
      await schedule();
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await runCampaignTick(env())).toEqual([
        {
          campaign: BLACK_FRIDAY_LAST_DAY,
          outcome: "not_started",
          state: "done",
          result: null,
          note: "The offer has ended; nothing was sent.",
        },
      ]);
      const row = await runRow();
      expect(row).toMatchObject({ state: "done", start_at: null });
      expect(row?.finished_at).not.toBeNull();
      expect(await tick()).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("a scheduled run of a campaign with no sender is stopped unsent at its time", async () => {
      await org("org_new");
      await db
        .prepare("INSERT INTO campaign_runs (campaign, state, start_at) VALUES ('black-friday', 'scheduled', ?)")
        .bind(SEND_AT)
        .run();
      expect(await tick()).toEqual([]);
      clock = SEND_AT;
      expect(await runCampaignTick(env())).toEqual([
        {
          campaign: "black-friday",
          outcome: "no_sender",
          state: "paused",
          result: null,
          note: "The worker has no sender for this campaign; nothing was sent.",
        },
      ]);
      expect(await runRow("black-friday")).toMatchObject({ state: "paused", start_at: null });
      expect(await tick()).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("cancelled from /admin just as the tick goes to start it: it stays cancelled", async () => {
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      const e = env({ DB: meanwhile(() => pauseCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)) });
      expect(await runCampaignTick(e)).toEqual([
        {
          campaign: BLACK_FRIDAY_LAST_DAY,
          outcome: "not_started",
          state: "paused",
          result: null,
          note: "Scheduled start cancelled from /admin.",
        },
      ]);
      expect(interrupted).toBe(1);
      expect(await tick()).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("moved to a later time just as the tick goes to start it: it waits for that time", async () => {
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      const later = SEND_AT + HOUR;
      const e = env({ DB: meanwhile(() => scheduleCampaignRun(env(), BLACK_FRIDAY_LAST_DAY, later)) });
      expect(await runCampaignTick(e)).toEqual([
        { campaign: BLACK_FRIDAY_LAST_DAY, outcome: "not_started", state: "scheduled", result: null, note: null },
      ]);
      expect(interrupted).toBe(1);
      expect(await runRow()).toMatchObject({ state: "scheduled", start_at: later });
      expect(await tick()).toEqual([]);
      expect(mails).toEqual([]);
      clock = later;
      expect((await runCampaignTick(env()))[0]).toMatchObject({ outcome: "batch", result: { sent: 1 } });
    });

    it("started by hand just as the tick goes to start it: one batch goes", async () => {
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      const e = env({ DB: meanwhile(() => startCampaignRun(env(), BLACK_FRIDAY_LAST_DAY)) });
      const outcomes = await runCampaignTick(e);
      expect(interrupted).toBe(1);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ outcome: "batch", state: "running", result: { owed: 1, sent: 1 } });
      expect(mails).toHaveLength(1);
    });

    it("two ticks at once start it once: the second finds the first still sending and sends nothing", async () => {
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      // The other tick has made it a running run and holds it for its batch.
      const otherTick = () =>
        db
          .prepare("UPDATE campaign_runs SET state = 'running', start_at = NULL, lease_until = ? WHERE campaign = ?")
          .bind(clock + 60_000, BLACK_FRIDAY_LAST_DAY)
          .run();
      expect(await runCampaignTick(env({ DB: meanwhile(otherTick) }))).toEqual([
        { campaign: BLACK_FRIDAY_LAST_DAY, outcome: "busy", state: "running", result: null, note: null },
      ]);
      expect(interrupted).toBe(1);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("another campaign started just as the tick goes to start it: it waits for that one", async () => {
      await got("org_unopened");
      await opened("org_1");
      await schedule();
      clock = SEND_AT;
      const e = env({ DB: meanwhile(() => startCampaignRun(env(), BLACK_FRIDAY_FOURTH)) });
      expect(await runCampaignTick(e)).toEqual([
        {
          campaign: BLACK_FRIDAY_LAST_DAY,
          outcome: "not_started",
          state: "scheduled",
          result: null,
          note: waitingFor(BLACK_FRIDAY_FOURTH),
        },
      ]);
      expect(interrupted).toBe(1);
      expect(await runRow(BLACK_FRIDAY_FOURTH)).toMatchObject({ state: "running" });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("is started by the two-minute cron, and that cron runs nothing else", async () => {
      await opened("org_1");
      await schedule();
      await cron(SEND_AT - TICK);
      expect(mails).toEqual([]);
      await cron(SEND_AT);
      expect(mails.map((m) => m.org_id)).toEqual(["org_1"]);
      const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes("started at its scheduled time"))).toBe(true);
      expect(logs.some((l) => l.includes("[cron]"))).toBe(false);
      expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0])).some((l) => l.includes("[cron]"))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("/admin/campaigns/black-friday-last-day", () => {
    it("needs the admin secret", async () => {
      await org("org_hello", { email: TEST_RECIPIENT });
      await opened("org_1");
      expect((await admin("GET", undefined, "wrong")).status).toBe(401);
      for (const body of [{ start: true }, { schedule_at: SEND_AT_TEXT }, { test_to: TEST_RECIPIENT }, { pause: true }]) {
        expect((await admin("POST", body, "wrong")).status).toBe(401);
      }
      expect(await runRow()).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("GET counts who is owed it and what has gone, on any day, and sends nothing", async () => {
      await opened("org_1");
      await opened("org_2");
      await got("org_3");
      expect(await admin("GET")).toEqual({
        status: 200,
        body: { campaign: BLACK_FRIDAY_LAST_DAY, owed: 2, first_send: 3, opened: 2, recorded: {}, run: null },
      });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("POST refuses anything but exactly one of start, pause, test_to or schedule_at", async () => {
      await org("org_hello", { email: TEST_RECIPIENT });
      await opened("org_1");
      clock = SEND_AT - HOUR;
      for (const body of [
        {},
        "",
        "{",
        "null",
        "5",
        "[]",
        { start: "true" },
        { start: 1 },
        { start: false },
        { pause: false },
        { start: true, pause: true },
        { start: true, test_to: TEST_RECIPIENT },
        { pause: true, test_to: TEST_RECIPIENT },
        { start: true, schedule_at: SEND_AT_TEXT },
        { pause: true, schedule_at: SEND_AT_TEXT },
        { test_to: TEST_RECIPIENT, schedule_at: SEND_AT_TEXT },
        { start: true, schedule_at: 5 },
        { test_to: 5 },
        { schedule_at: 5 },
        { schedule_at: SEND_AT },
        { schedule_at: null },
        { schedule_at: true },
        { send: true },
      ]) {
        expect(await admin("POST", body)).toEqual({
          status: 400,
          body: {
            error: "bad_request",
            message: "Send exactly one of: start: true, pause: true, test_to: <address> or schedule_at: <UTC time>.",
          },
        });
      }
      expect(await runRow()).toBeNull();
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("schedule_at must be a real UTC time, written with its Z", async () => {
      await opened("org_1");
      for (const at of [
        "tomorrow",
        "",
        "2026-11-27",
        "2026-11-27T14:00:00",
        "2026-11-27T14:00:00+00:00",
        "2026-11-27T08:00:00-06:00",
        "2026-11-27 14:00:00Z",
        " 2026-11-27T14:00:00Z",
        "2026-11-27T14:00:00z",
        "2026-11-31T14:00:00Z",
        "2026-11-27T24:00:00Z",
        "2026-11-27T14:60:00Z",
        "2026-13-01T00:00:00Z",
        String(SEND_AT),
      ]) {
        expect(await admin("POST", { schedule_at: at }), at).toEqual({
          status: 400,
          body: { error: "bad_request", message: "schedule_at must be a UTC time like 2026-11-27T14:00:00Z." },
        });
      }
      expect(await runRow()).toBeNull();
    });

    it("schedule_at sets the time, written to the minute, the second or the millisecond, and sends nothing", async () => {
      await opened("org_1");
      await opened("org_2");
      for (const at of ["2026-11-27T14:00Z", SEND_AT_TEXT, SEND_AT_ISO]) {
        expect(await admin("POST", { schedule_at: at }), at).toMatchObject({
          status: 200,
          body: {
            owed: 2,
            run: { campaign: BLACK_FRIDAY_LAST_DAY, state: "scheduled", start_at: SEND_AT_ISO, sending: false, note: null },
          },
        });
      }
      expect((await admin("POST", { schedule_at: "2026-11-27T14:30:15.250Z" })).body).toMatchObject({
        run: { start_at: "2026-11-27T14:30:15.250Z" },
      });
      expect((await admin("GET")).body).toMatchObject({
        owed: 2,
        recorded: {},
        run: { state: "scheduled", start_at: "2026-11-27T14:30:15.250Z" },
      });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(await lastDaySends()).toEqual([]);
    });

    it("schedule_at is refused for a time that has passed, one before the last day and one after the offer ends", async () => {
      await opened("org_1");
      expect(await admin("POST", { schedule_at: "2026-11-17T14:00:00Z" })).toEqual({
        status: 400,
        body: { error: "bad_request", message: "The start time must be a time in the future." },
      });
      expect(await admin("POST", { schedule_at: "2026-11-26T14:00:00Z" })).toEqual({ status: 409, body: TOO_EARLY });
      expect(await admin("POST", { schedule_at: "2026-11-28T05:00:00Z" })).toMatchObject({
        status: 410,
        body: { error: "offer_ended" },
      });
      expect(await runRow()).toBeNull();
    });

    it("schedule_at is refused while it is running", async () => {
      await openedMany(51);
      clock = SEND_AT;
      await admin("POST", { start: true });
      expect(await admin("POST", { schedule_at: "2026-11-27T15:00:00Z" })).toEqual({
        status: 409,
        body: { error: "already_running", message: "This campaign is running; pause it before giving it a start time." },
      });
      expect(await runRow()).toMatchObject({ state: "running", start_at: null });
    });

    it("start is refused before the last day and after the offer, and writes nothing; on the day it arms the run", async () => {
      await opened("org_1");
      expect(await admin("POST", { start: true })).toEqual({ status: 409, body: TOO_EARLY });
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await admin("POST", { start: true })).toMatchObject({ status: 410, body: { error: "offer_ended" } });
      expect(await runRow()).toBeNull();

      clock = SEND_AT;
      expect(await admin("POST", { start: true })).toMatchObject({
        status: 200,
        body: { owed: 1, run: { state: "running", sending: false, note: null, start_at: null } },
      });
      expect(mails).toEqual([]);
      await tick();
      expect(mails).toHaveLength(1);
      expect((await admin("GET")).body).toMatchObject({ owed: 0, recorded: { sent: 1 }, run: { state: "running" } });
    });

    it("pause cancels a scheduled start, and pauses a running run", async () => {
      await opened("org_1");
      await admin("POST", { schedule_at: SEND_AT_TEXT });
      expect(await admin("POST", { pause: true })).toMatchObject({
        status: 200,
        body: { paused: true, run: { state: "paused", note: "Scheduled start cancelled from /admin.", start_at: null } },
      });
      expect((await admin("POST", { pause: true })).body).toMatchObject({ paused: false });
      clock = SEND_AT;
      expect(await runCampaignTick(env())).toEqual([]);

      await admin("POST", { start: true });
      expect((await admin("POST", { pause: true })).body).toMatchObject({
        paused: true,
        run: { state: "paused", note: "Paused from /admin." },
      });
      expect(await tick()).toEqual([]);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("scheduled from /admin, the cron sends it at that time and not before", async () => {
      const ids = await openedMany(3);
      await got("org_unopened");
      expect((await admin("POST", { schedule_at: SEND_AT_TEXT })).status).toBe(200);
      await cron(SEND_AT - TICK);
      expect(mails).toEqual([]);
      await cron(SEND_AT);
      expect(mails.map((m) => m.org_id)).toEqual(ids);
      await cron(SEND_AT + TICK);
      expect((await admin("GET")).body).toMatchObject({
        owed: 0,
        recorded: { sent: 3 },
        run: { state: "done", note: "Sent to everyone it was owed to.", start_at: null },
      });
      expect(firstRouteMails).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("its test copy", () => {
    /** hello@getengram.app's own account, on the Free plan. */
    const hello = (o: OrgOpts = {}) => org("org_hello", { email: "Hello@GetEngram.app", ...o });
    const copy = () => ({
      to: TEST_RECIPIENT,
      name: "Name org_hello",
      org_id: "org_hello",
      unsubscribe_url: `https://mcp.getengram.app/email/unsubscribe?org=org_hello&sig=${unsubscribeSig("org_hello")}`,
      offer_url: `${WEB}/black-friday?org=org_hello&sig=${offerSig("org_hello")}&utm_source=email&utm_campaign=blackfriday`,
      test: true,
    });

    it("goes to hello@getengram.app on any day the offer is open, through the last-day route, marked as a test", async () => {
      await hello();
      await opened("org_1");
      for (const day of [BEFORE, SEND_AT]) {
        clock = day;
        expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({ status: 200, body: { sent: true } });
      }
      expect(mails).toEqual([copy(), copy()]);
      expect(firstRouteMails).toEqual([]);
      // Nothing is written: no address is left out of the send, and there is no run.
      expect(await lastDaySends()).toEqual([]);
      expect(await runRow()).toBeNull();
    });

    it("takes the address however it is typed", async () => {
      await hello();
      expect(await admin("POST", { test_to: " Hello@GetEngram.app " })).toEqual({ status: 200, body: { sent: true } });
      expect(mails).toEqual([copy()]);
    });

    it("goes nowhere else", async () => {
      await hello();
      await opened("org_1");
      for (const to of ["org_1@example.test", "hello@getengram.app.example.test", "hello", ""]) {
        expect(await admin("POST", { test_to: to }), to).toEqual({
          status: 400,
          body: { error: "bad_request", message: "A test copy goes to hello@getengram.app only." },
        });
      }
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("leaves hello@ owed the email itself", async () => {
      // hello@ got the first email and opened it.
      await opened("org_hello", { email: "Hello@GetEngram.app" });
      await admin("POST", { test_to: TEST_RECIPIENT });
      clock = SEND_AT;
      expect(ok(await runBlackFridayLastDay(env(), { limit: 50 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => [m.to, m.test])).toEqual([
        [TEST_RECIPIENT, true],
        ["Hello@GetEngram.app", undefined],
      ]);
    });

    it("says so when hello@ has no account, or engram-web did not send it", async () => {
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({
        status: 404,
        body: { error: "organization_not_found", message: "hello@getengram.app has no account to take the name and links from." },
      });
      await hello();
      // A website without the route.
      webAnswer = () => 404;
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({
        status: 502,
        body: { error: "test_send_failed", message: "engram-web did not send the test copy (refused)." },
      });
      webAnswer = () => "throw";
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({
        status: 502,
        body: { error: "test_send_failed", message: "engram-web did not send the test copy (unknown)." },
      });
      expect(mails).toEqual([]);
    });

    it("is refused once the offer has ended", async () => {
      await hello();
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toMatchObject({ status: 410, body: { error: "offer_ended" } });
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  it("migration 0052 keeps the runs that were there, and adds the scheduled state and the start time", async () => {
    await applyMigration(old, "_campaign_runs.sql");
    const insert = (...values: unknown[]) =>
      old
        .prepare(
          `INSERT INTO campaign_runs
             (campaign, state, note, lease_until, failed_ticks, started_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...values);
    await old.batch([
      insert("black-friday-resend", "done", "Sent to everyone it was owed to.", null, 0, "2026-11-20 00:21:00", "2026-11-20 02:01:00", "2026-11-20 02:01:00"),
      insert("black-friday-third", "paused", "The batch failed: D1_ERROR: Overloaded (3 ticks in a row)", null, 3, "2026-11-20 18:20:00", "2026-11-20 18:26:00", null),
      insert("finish-signup", "running", null, 1795000000000, 1, "2026-11-21 19:05:00", "2026-11-21 19:07:00", null),
    ]);
    const columns = async () =>
      (await old.prepare("PRAGMA table_info(campaign_runs)").all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>())
        .results.map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }));
    const rows = async () => (await old.prepare("SELECT * FROM campaign_runs ORDER BY campaign").all<Record<string, unknown>>()).results;
    const columnsBefore = await columns();
    const rowsBefore = await rows();
    expect(rowsBefore).toHaveLength(3);
    await expect(
      old.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('black-friday-last-day', 'scheduled')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    await applyMigration(old, "_campaign_runs_scheduled.sql");

    // Every run is as it was, with no start time.
    expect(await rows()).toEqual(rowsBefore.map((r) => ({ ...r, start_at: null })));
    // Every column is as it was, and start_at comes after them.
    const columnsAfter = await columns();
    expect(columnsAfter.slice(0, columnsBefore.length)).toEqual(columnsBefore);
    expect(columnsAfter.slice(columnsBefore.length)).toEqual([
      { name: "start_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    ]);

    // A scheduled run can be written, with the defaults the table always had.
    await old
      .prepare("INSERT INTO campaign_runs (campaign, state, start_at) VALUES ('black-friday-last-day', 'scheduled', ?)")
      .bind(SEND_AT)
      .run();
    const scheduled = await old
      .prepare("SELECT * FROM campaign_runs WHERE campaign = 'black-friday-last-day'")
      .first<Record<string, unknown>>();
    expect(scheduled).toMatchObject({
      state: "scheduled",
      start_at: SEND_AT,
      note: null,
      lease_until: null,
      failed_ticks: 0,
      finished_at: null,
    });
    expect(String(scheduled?.started_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(scheduled?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // The state is still checked, and a campaign still has one run.
    await expect(
      old.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('another', 'sending')").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      old.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('finish-signup', 'running')").run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    // Nothing is left behind under the name the table was built with.
    const tables = (
      await old.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'campaign_runs%' ORDER BY name").all<{ name: string }>()
    ).results.map((r) => r.name);
    expect(tables).toEqual(["campaign_runs"]);
  });

  // -------------------------------------------------------------------------
  it("its statements read email_log by its type index and never walk campaign_sends or email_log", async () => {
    const sql: string[] = [];
    const e = env({ DB: recording(sql) });
    await opened("org_1");
    await opened("org_2");
    await got("org_3");
    ok(await runBlackFridayLastDay(e, { dryRun: true }));
    await blackFridayOpens(e);
    await schedule(SEND_AT, e);
    clock = SEND_AT;
    await runCampaignTick(e);
    expect(mails).toHaveLength(2);

    const touching = [...new Set(sql)].filter((q) => /\b(campaign_sends|email_log|email_opt_outs)\b/.test(q));
    expect(touching.length).toBeGreaterThan(5);
    expect(touching.some((q) => /\bemail_opt_outs\b/.test(q))).toBe(true);
    let readsEmailLog = 0;
    for (const q of touching) {
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${q}`)
          .bind(...Array.from({ length: paramCount(q) }, () => "x"))
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      expect(plan.filter((line) => /^SCAN (campaign_sends|email_log|email_opt_outs|s)\b/.test(line)), q).toEqual([]);
      if (/\bemail_log\b/.test(q)) {
        expect(plan.some((line) => /^SEARCH email_log USING (COVERING )?INDEX idx_email_log_type\b/.test(line)), q).toBe(true);
        readsEmailLog++;
      }
    }
    expect(readsEmailLog).toBeGreaterThanOrEqual(3);
  });
});
