import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import app from "../index.js";
import {
  BLACK_FRIDAY_RESEND,
  SEND_TIMEOUT_MS,
  blackFridayOpens,
  runBlackFridayResend,
  type CampaignResult,
} from "../services/black-friday-campaign.js";
import {
  LEASE_MS,
  MAX_FAILED_TICKS,
  TICK_BUDGET_MS,
  pauseCampaignRun,
  runCampaignTick,
  startCampaignRun,
} from "../services/campaign-runs.js";
import { BLACK_FRIDAY_ENDS_AT_MS } from "../services/black-friday.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The Black Friday email again (engram#773), against real SQLite with the
 * real migrations: who it goes to, the send itself, the cron that sends it
 * a batch at a time once /admin starts it, and the /admin switch.
 */

const KEY = "link-key-773-test";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
/** Ten days before the deadline: the offer is on sale. */
const DURING = BLACK_FRIDAY_ENDS_AT_MS - 10 * 86_400_000;
/** The cron's interval. */
const TICK = 120_000;

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
  finished_at: string | null;
}

/** EXPLAIN QUERY PLAN takes as many values as the statement has parameters. */
function paramCount(sql: string): number {
  const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  return numbered.length > 0 ? Math.max(...numbered) : (sql.match(/\?/g) ?? []).length;
}

describe("The Black Friday email again (engram#773), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let clock: number;
  /** Emails engram-web sent. */
  let mails: Mail[];
  /** What engram-web answers: a status, or "throw" for no answer at all. */
  let webAnswer: (mail: Mail) => number | "throw" | Promise<number | "throw">;
  let logId = 0;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "black-friday-resend" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await db.batch(
      ["campaign_runs", "campaign_sends", "email_log", "prepaid_plans", "organizations"].map((t) =>
        db.prepare(`DELETE FROM ${t}`),
      ),
    );
    mails = [];
    webAnswer = () => 200;
    clock = DURING;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.origin === WEB && url.pathname === "/api/email/black-friday") {
          expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer web-bearer");
          const mail = JSON.parse(String(init?.body)) as Mail;
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

  /** An account. Free, with an email, subscribed to email, unless told otherwise. */
  async function org(id: string, o: OrgOpts = {}) {
    await orgInsert(id, o).run();
  }

  /** An account the first email went to, at its address as it was then. */
  async function got(id: string, o: OrgOpts & { status?: string } = {}) {
    const email = o.email === undefined ? `${id}@example.test` : String(o.email);
    await db.batch([orgInsert(id, o), sendInsert("black-friday", email.trim().toLowerCase(), id, o.status)]);
  }

  /** `n` accounts the first email went to, org_000 onwards. */
  async function gotMany(n: number) {
    const ids = Array.from({ length: n }, (_, i) => `org_${String(i).padStart(3, "0")}`);
    await db.batch(ids.flatMap((id) => [orgInsert(id), sendInsert("black-friday", `${id}@example.test`, id)]));
    return ids;
  }

  /** An email engram-web logged, opened unless told otherwise. */
  async function logged(recipient: string, o: { opened?: boolean; type?: string } = {}) {
    await db
      .prepare("INSERT INTO email_log (id, org_id, recipient, type, opened_at) VALUES (?, NULL, ?, ?, ?)")
      .bind(`el_${++logId}`, recipient, o.type ?? "black-friday", o.opened === false ? null : "2026-11-18 06:00:00")
      .run();
  }

  const sendsOf = async (campaign: string) =>
    (
      await db
        .prepare("SELECT email, org_id, status FROM campaign_sends WHERE campaign = ? ORDER BY email")
        .bind(campaign)
        .all<{ email: string; org_id: string; status: string }>()
    ).results;
  const resends = () => sendsOf(BLACK_FRIDAY_RESEND);

  const runRow = (campaign = BLACK_FRIDAY_RESEND) =>
    db
      .prepare("SELECT state, note, lease_until, failed_ticks, finished_at FROM campaign_runs WHERE campaign = ?")
      .bind(campaign)
      .first<RunRow>();

  const ok = (r: Awaited<ReturnType<typeof runBlackFridayResend>>) => {
    if ("error" in r) throw new Error(`resend refused: ${r.error}`);
    return r as CampaignResult;
  };

  /** The next cron tick, two minutes after the last. */
  async function tick(e: Env = env()) {
    clock += TICK;
    return runCampaignTick(e);
  }

  async function start(e: Env = env()) {
    const r = await startCampaignRun(e, BLACK_FRIDAY_RESEND);
    if ("error" in r) throw new Error(`start refused: ${r.error}`);
    return r.run;
  }

  // -------------------------------------------------------------------------
  describe("who it goes to", () => {
    /** Five people who should get it again, and one of every kind that should not. */
    async function everyone() {
      await got("org_a");
      // Typed with capitals and spaces; the first email went to it.
      await got("org_mixed", { email: " Mixed@Example.test " });
      // Got the first email and a weekly digest, opened only the digest.
      await got("org_digest");
      await logged("org_digest@example.test", { type: "weekly-digest" });
      // Logged by engram-web, never opened.
      await got("org_unopened");
      await logged("org_unopened@example.test", { opened: false });
      // The first send never heard back: the email may not have gone.
      await got("org_unknown", { status: "unknown" });

      // Opened it.
      await got("org_open");
      await logged("org_open@example.test");
      // Opened it; engram-web logged the address as it was typed.
      await got("org_open_typed", { email: "Open_Typed@example.test" });
      await logged(" Open_Typed@Example.test ");
      // A customer now.
      await got("org_paid", { tier: "pro" });
      // Still on Free, but the same person has a paid account.
      await got("org_twin");
      await org("org_twin_pro", { email: "ORG_TWIN@example.test", tier: "team" });
      // Bought the offer, then a refund put the account back on Free.
      await got("org_bought");
      await db.prepare(
        "INSERT INTO prepaid_plans (session_id, org_id, offer, tier, ends_at) VALUES ('cs_1', 'org_bought', 'black-friday', 'pro', '2027-11-19 00:00:00')",
      ).run();
      // The same person bought it on another account.
      await got("org_bought_twin");
      await org("org_bought_twin_2", { email: "Org_Bought_Twin@example.test" });
      await db.prepare(
        "INSERT INTO prepaid_plans (session_id, org_id, offer, tier, ends_at) VALUES ('cs_2', 'org_bought_twin_2', 'black-friday', 'pro', '2027-11-19 00:00:00')",
      ).run();
      // Unsubscribed since.
      await got("org_out", { optOut: true });
      // The same person unsubscribed on another account.
      await got("org_out_twin");
      await org("org_out_twin_2", { email: "ORG_OUT_TWIN@example.test", optOut: true });
      // Deleted since.
      await got("org_deleted", { deleted: true });
      // Internal.
      await got("org_internal", { source: "internal" });
      // Changed address since.
      await got("org_moved");
      await db.prepare("UPDATE organizations SET email = 'new-address@example.test' WHERE id = 'org_moved'").run();
      // Signed up after the first email: never sent the second.
      await org("org_new");
    }

    const OWED_TO = ["org_a", "org_digest", "org_mixed", "org_unknown", "org_unopened"];

    it("a dry run counts the addresses owed it and sends nothing", async () => {
      await everyone();
      expect(ok(await runBlackFridayResend(env(), { dryRun: true }))).toEqual({
        dry_run: true,
        owed: OWED_TO.length,
        sent: 0,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: {},
      });
      expect(mails).toEqual([]);
      expect(await resends()).toEqual([]);
    });

    it("goes only to people the first email went to who have not opened it and could still buy", async () => {
      await everyone();
      const before = await sendsOf("black-friday");
      const r = ok(await runBlackFridayResend(env(), { limit: 50 }));
      expect(r).toMatchObject({ dry_run: false, owed: 5, sent: 5, failed: 0, stopped: false, recorded: { sent: 5 } });
      expect(mails.map((m) => m.org_id).sort()).toEqual(OWED_TO);
      expect((await resends()).map((s) => [s.org_id, s.status])).toEqual(
        // Ordered by address.
        [
          ["org_mixed", "sent"],
          ["org_a", "sent"],
          ["org_digest", "sent"],
          ["org_unknown", "sent"],
          ["org_unopened", "sent"],
        ],
      );
      // The first send's record is left as it was.
      expect(await sendsOf("black-friday")).toEqual(before);
    });

    it("is the same email as the first, to the address as typed, with links signed for that account", async () => {
      await got("org_mixed", { email: " Mixed@Example.test " });
      ok(await runBlackFridayResend(env(), {}));
      expect(mails).toEqual([
        {
          to: "Mixed@Example.test",
          name: "Name org_mixed",
          org_id: "org_mixed",
          unsubscribe_url: `https://mcp.getengram.app/email/unsubscribe?org=org_mixed&sig=${unsubscribeSig("org_mixed")}`,
          offer_url: `${WEB}/black-friday?org=org_mixed&sig=${offerSig("org_mixed")}&utm_source=email&utm_campaign=blackfriday`,
        },
      ]);
      expect(await resends()).toEqual([{ email: "mixed@example.test", org_id: "org_mixed", status: "sent" }]);
    });

    it("an open recorded during the send counts at the next batch", async () => {
      await got("org_1");
      await got("org_2");
      await got("org_3");
      expect(ok(await runBlackFridayResend(env(), { limit: 1 }))).toMatchObject({ owed: 3, sent: 1 });
      await logged("org_3@example.test");
      expect(ok(await runBlackFridayResend(env(), { limit: 50 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2"]);
    });

    it("never sends it twice to one address", async () => {
      await got("org_1");
      await got("org_2");
      ok(await runBlackFridayResend(env(), { limit: 50 }));
      expect(ok(await runBlackFridayResend(env(), { limit: 50 }))).toMatchObject({ owed: 0, sent: 0, skipped: 0 });
      expect(mails).toHaveLength(2);
    });

    it("caps a batch at 50", async () => {
      await gotMany(53);
      expect(ok(await runBlackFridayResend(env(), { limit: 5000 })).sent).toBe(50);
      expect(ok(await runBlackFridayResend(env(), { limit: 5000 }))).toMatchObject({ owed: 3, sent: 3 });
    });

    it("releases a claim engram-web refused, and keeps one with no clear answer", async () => {
      await got("org_1");
      await got("org_2");
      await got("org_3");
      webAnswer = (m) => (m.org_id === "org_1" ? 401 : m.org_id === "org_2" ? 500 : "throw");
      expect(ok(await runBlackFridayResend(env(), { limit: 50 }))).toMatchObject({
        sent: 0,
        failed: 3,
        stopped: true,
        recorded: { unknown: 2 },
      });
      webAnswer = () => 200;
      expect(ok(await runBlackFridayResend(env(), { limit: 50 }))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1"]);
    });

    it("counts, for /admin, the first email's addresses and how many of them opened one", async () => {
      await got("org_1");
      await got("org_2", { email: "Two@example.test" });
      await got("org_3");
      await logged("two@example.test");
      await logged("org_3@example.test", { opened: false });
      // An open that is not the Black Friday email, and one from an address it never went to.
      await logged("org_1@example.test", { type: "weekly-digest" });
      await logged("someone-else@example.test");
      expect(await blackFridayOpens(env())).toEqual({ first_send: 3, opened: 1 });
    });
  });

  // -------------------------------------------------------------------------
  describe("the cron sends it a batch at a time once started", () => {
    it("does nothing until a run is started", async () => {
      await got("org_1");
      expect(await tick()).toEqual([]);
      expect(mails).toEqual([]);
    });

    it("sends a batch each tick until nobody is owed it, then ends itself", async () => {
      const ids = await gotMany(55);
      expect(await start()).toMatchObject({ campaign: BLACK_FRIDAY_RESEND, state: "running", sending: false, note: null });
      expect(mails).toEqual([]);

      const [first] = await tick();
      expect(first).toMatchObject({ outcome: "batch", state: "running", result: { owed: 55, sent: 50 } });
      expect(await runRow()).toMatchObject({ state: "running", lease_until: null, finished_at: null });
      const [second] = await tick();
      expect(second).toMatchObject({ outcome: "batch", state: "running", result: { owed: 5, sent: 5 } });
      const [last] = await tick();
      expect(last).toMatchObject({ outcome: "batch", state: "done", note: "Sent to everyone it was owed to.", result: { owed: 0 } });
      expect((await runRow())?.finished_at).not.toBeNull();

      expect(await tick()).toEqual([]);
      expect(mails.map((m) => m.org_id).sort()).toEqual(ids);
    });

    it("a pause from /admin lets the batch being sent finish, then nothing more goes until it is started again", async () => {
      await gotMany(53);
      await start();
      webAnswer = async () => {
        if (mails.length === 0) expect((await pauseCampaignRun(env(), BLACK_FRIDAY_RESEND)).paused).toBe(true);
        return 200;
      };
      const [batch] = await tick();
      expect(batch).toMatchObject({ outcome: "batch", state: "paused", note: "Paused from /admin.", result: { sent: 50 } });
      expect(await runRow()).toMatchObject({ state: "paused", note: "Paused from /admin.", lease_until: null });

      webAnswer = () => 200;
      expect(await tick()).toEqual([]);
      expect(mails).toHaveLength(50);

      await start();
      expect((await tick())[0]).toMatchObject({ state: "running", result: { owed: 3, sent: 3 } });
      expect((await tick())[0]).toMatchObject({ state: "done" });
      expect(mails).toHaveLength(53);
    });

    it("ends itself without sending once the offer has ended", async () => {
      await got("org_1");
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

    it("pauses without sending while mail is not configured", async () => {
      await got("org_1");
      await start();
      const [r] = await tick(env({ UNSUBSCRIBE_HMAC_KEY: undefined, ADMIN_SECRET: undefined }));
      expect(r).toMatchObject({ state: "paused", note: "No website bearer, signing key or APP_URL; nothing was sent." });
      expect(mails).toEqual([]);
      expect(await resends()).toEqual([]);
    });

    it("pauses after three failed sends in a row, keeping each claim that had no clear answer", async () => {
      await gotMany(6);
      await start();
      webAnswer = () => 500;
      const [r] = await tick();
      expect(r).toMatchObject({
        state: "paused",
        note: "Stopped after repeated failed sends; see the worker log.",
        result: { sent: 0, failed: 3, stopped: true },
      });
      expect((await resends()).map((s) => s.status)).toEqual(["unknown", "unknown", "unknown"]);
      expect(await tick()).toEqual([]);
    });

    it("pauses when no send in a batch went through", async () => {
      await got("org_1");
      await got("org_2");
      await start();
      webAnswer = () => 400;
      const [r] = await tick();
      expect(r).toMatchObject({
        state: "paused",
        note: "No send in the last batch went through; see the worker log.",
        result: { sent: 0, failed: 2, stopped: false },
      });
      // Refused before sending, so both can be tried again.
      expect(await resends()).toEqual([]);
    });

    it("a batch that throws is tried again next tick; three in a row pause the run", async () => {
      await got("org_1");
      await got("org_2");
      await got("org_3");
      await start();
      const overloaded = new Proxy(db, {
        get(target, prop) {
          if (prop === "prepare") {
            return (query: string) => {
              if (/FROM campaign_sends s\s+JOIN organizations/.test(query)) throw new Error("D1_ERROR: Overloaded");
              return target.prepare(query);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const failing = env({ DB: overloaded });

      expect((await tick(failing))[0]).toMatchObject({ state: "running", note: "The batch failed: D1_ERROR: Overloaded" });
      expect(await runRow()).toMatchObject({ state: "running", failed_ticks: 1, lease_until: null });
      expect(await resends()).toEqual([]);

      // A batch that goes through in between starts the count again. (Each
      // send here takes the tick's whole budget, so one goes per tick.)
      webAnswer = () => {
        clock += TICK_BUDGET_MS;
        return 200;
      };
      expect((await tick())[0]).toMatchObject({ state: "running", note: null, result: { sent: 1 } });
      expect(await runRow()).toMatchObject({ failed_ticks: 0 });
      webAnswer = () => 200;

      for (let i = 1; i < MAX_FAILED_TICKS; i++) {
        expect((await tick(failing))[0]).toMatchObject({ state: "running" });
      }
      expect((await tick(failing))[0]).toMatchObject({
        state: "paused",
        note: `The batch failed: D1_ERROR: Overloaded (${MAX_FAILED_TICKS} ticks in a row)`,
      });
      expect(await runRow()).toMatchObject({ state: "paused", failed_ticks: MAX_FAILED_TICKS, lease_until: null });
      expect(await tick()).toEqual([]);

      await start();
      expect(await runRow()).toMatchObject({ state: "running", failed_ticks: 0 });
      expect((await tick())[0]).toMatchObject({ state: "running", result: { owed: 2, sent: 2 } });
      expect(mails.map((m) => m.org_id)).toEqual(["org_1", "org_2", "org_3"]);
    });

    it("sends nothing while the last batch still holds the run, and carries on once its hold runs out", async () => {
      await got("org_1");
      await start();
      clock += TICK;
      const held = clock + 60_000;
      await db.prepare("UPDATE campaign_runs SET lease_until = ?").bind(held).run();

      expect(await runCampaignTick(env())).toEqual([
        { campaign: BLACK_FRIDAY_RESEND, outcome: "busy", state: "running", result: null, note: null },
      ]);
      expect(mails).toEqual([]);
      expect(await runRow()).toMatchObject({ lease_until: held });

      clock = held;
      expect((await runCampaignTick(env()))[0]).toMatchObject({ outcome: "batch", result: { sent: 1 } });
      expect(mails).toHaveLength(1);
    });

    it("starts no send once the tick's time is up; the next tick carries on", async () => {
      await gotMany(10);
      await start();
      webAnswer = () => {
        clock += 40_000;
        return 200;
      };
      // Sends at 0 s, 40 s and 80 s; at 120 s the 90 s budget is spent.
      expect((await tick())[0]).toMatchObject({ state: "running", result: { sent: 3 } });
      expect((await tick())[0]).toMatchObject({ state: "running", result: { owed: 7, sent: 3 } });
    });

    it("a batch, even one whose last send runs to its timeout, ends before the next tick and inside its hold", () => {
      expect(TICK_BUDGET_MS + SEND_TIMEOUT_MS).toBeLessThan(TICK);
      expect(LEASE_MS).toBeGreaterThan(TICK_BUDGET_MS + SEND_TIMEOUT_MS + 30_000);
    });

    it("the first email has no sender: it cannot be started, and a run of it is stopped unsent", async () => {
      await org("org_new");
      expect(await startCampaignRun(env(), "black-friday")).toMatchObject({ error: "unknown_campaign", status: 404 });
      expect(await runRow("black-friday")).toBeNull();

      await db.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('black-friday', 'running')").run();
      expect(await tick()).toEqual([
        {
          campaign: "black-friday",
          outcome: "no_sender",
          state: "paused",
          result: null,
          note: "The worker has no sender for this campaign; nothing was sent.",
        },
      ]);
      expect(await runRow("black-friday")).toMatchObject({ state: "paused" });
      expect(mails).toEqual([]);
    });

    it("runs on the two-minute cron, and that cron runs nothing else", async () => {
      await got("org_1");
      await start();
      await app.scheduled(
        { cron: "*/2 * * * *", scheduledTime: clock, type: "scheduled", noRetry() {} } as unknown as ScheduledEvent,
        env(),
        ctx,
      );
      expect(mails.map((m) => m.org_id)).toEqual(["org_1"]);
      const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes("[cron]"))).toBe(false);
      expect(vi.mocked(console.error).mock.calls.map((c) => String(c[0])).some((l) => l.includes("[cron]"))).toBe(false);
    });

    it("every cron in wrangler.toml but the 03:00 one has its own branch in scheduled()", () => {
      const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
      const crons = JSON.parse(/^crons\s*=\s*(\[.*\])\s*$/m.exec(toml)?.[1] ?? "[]") as string[];
      expect(crons).toContain("*/2 * * * *");
      const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
      for (const cron of crons.filter((c) => c !== "0 3 * * *")) {
        expect(index).toContain(`event.cron === "${cron}"`);
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("/admin/campaigns/black-friday-resend", () => {
    async function admin(method: "GET" | "POST", body?: unknown, bearer = "admin-test") {
      const res = await app.fetch(
        new Request(`${WORKER}/admin/campaigns/black-friday-resend`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
          body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        }),
        env(),
        ctx,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("needs the admin secret", async () => {
      await got("org_1");
      expect((await admin("GET", undefined, "wrong")).status).toBe(401);
      expect((await admin("POST", { start: true }, "wrong")).status).toBe(401);
      expect(await runRow()).toBeNull();
    });

    it("GET counts who is owed it and what has gone, and sends nothing", async () => {
      await got("org_1");
      await got("org_2");
      await got("org_3");
      await logged("org_3@example.test");
      const res = await admin("GET");
      expect(res).toEqual({
        status: 200,
        body: { campaign: BLACK_FRIDAY_RESEND, owed: 2, first_send: 3, opened: 1, recorded: {}, run: null },
      });
      expect(mails).toEqual([]);
    });

    it("POST refuses anything but exactly one of start or pause", async () => {
      await got("org_1");
      for (const body of [{}, "", "{", "null", "5", { start: "true" }, { start: 1 }, { start: true, pause: true }, { send: true }]) {
        expect((await admin("POST", body)).status).toBe(400);
      }
      expect(await runRow()).toBeNull();
      expect(mails).toEqual([]);
    });

    it("start is refused once the offer has ended, and writes nothing", async () => {
      await got("org_1");
      clock = BLACK_FRIDAY_ENDS_AT_MS;
      expect(await admin("POST", { start: true })).toMatchObject({ status: 410, body: { error: "offer_ended" } });
      expect(await runRow()).toBeNull();
    });

    it("start arms the run without sending, pause stops it, start again resumes it", async () => {
      await got("org_1");
      await got("org_2");
      const started = await admin("POST", { start: true });
      expect(started).toMatchObject({ status: 200, body: { owed: 2, run: { state: "running", sending: false, note: null } } });
      expect(mails).toEqual([]);
      expect((await admin("GET")).body).toMatchObject({ run: { state: "running" } });

      expect((await admin("POST", { pause: true })).body).toMatchObject({
        paused: true,
        run: { state: "paused", note: "Paused from /admin." },
      });
      expect((await admin("POST", { pause: true })).body).toMatchObject({ paused: false });
      expect(await tick()).toEqual([]);

      expect((await admin("POST", { start: true })).body).toMatchObject({ run: { state: "running", note: null } });
      await tick();
      expect(mails).toHaveLength(2);
      expect((await admin("GET")).body).toMatchObject({ owed: 0, recorded: { sent: 2 }, run: { state: "running" } });
    });
  });

  // -------------------------------------------------------------------------
  it("its statements read email_log by its type index and never walk campaign_sends or email_log", async () => {
    const sql: string[] = [];
    const recording = new Proxy(db, {
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
    const e = env({ DB: recording });
    await got("org_1");
    await got("org_2");
    await logged("org_2@example.test");
    ok(await runBlackFridayResend(e, { dryRun: true }));
    await blackFridayOpens(e);
    await startCampaignRun(e, BLACK_FRIDAY_RESEND);
    await runCampaignTick(e);
    expect(mails).toHaveLength(1);

    const touching = [...new Set(sql)].filter((q) => /\b(campaign_sends|email_log)\b/.test(q));
    expect(touching.length).toBeGreaterThan(5);
    let readsEmailLog = 0;
    for (const q of touching) {
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${q}`)
          .bind(...Array.from({ length: paramCount(q) }, () => "x"))
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      expect(plan.filter((line) => /^SCAN (campaign_sends|email_log|s)\b/.test(line)), q).toEqual([]);
      if (/\bemail_log\b/.test(q)) {
        expect(plan.some((line) => /^SEARCH email_log USING (COVERING )?INDEX idx_email_log_type\b/.test(line)), q).toBe(true);
        readsEmailLog++;
      }
    }
    expect(readsEmailLog).toBeGreaterThanOrEqual(3);
  });
});
