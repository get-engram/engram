import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import { insertOrganizationWithEmail, setOrganizationEmail } from "@getengram/db";
import app from "../index.js";
import { BATCH_MAX } from "../services/black-friday-campaign.js";
import {
  FINISH_SIGNUP,
  FINISH_SIGNUP_RESEND,
  TEST_RECIPIENT,
  TEST_USER,
  runFinishSignup,
  type FinishSignupResult,
} from "../services/finish-signup-campaign.js";
import { runCampaignTick, startCampaignRun } from "../services/campaign-runs.js";
import { UNSUBSCRIBE_PAGE_SECURITY_POLICY } from "../middleware/security-headers.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The finish-sign-up email (engram#781), against real SQLite with the real
 * migrations: who it goes to, the send and each answer engram-web can give,
 * the cron that sends it a batch at a time once /admin starts it, the
 * /admin switch and its test copy, the unsubscribe link that names a
 * website account instead of an org, and the opt-out an org made later
 * inherits. Then the same email again (engram#783), to the people the
 * first one went to who are still stuck and have not opened it.
 */

const KEY = "link-key-781-test";
const OLD_KEY = "link-key-781-previous";
const WEB = "https://web.example.test";
const WORKER = "https://mcp.example.test";
/** Where the email's unsubscribe link points (the worker routes by path). */
const BASE = "https://mcp.getengram.app/email/unsubscribe";
/** The cron's interval. */
const TICK = 120_000;
const CUTOFF = "2026-11-21T04:12:49Z";
const START = Date.parse("2026-11-21T08:00:00Z");

/** A website account id (a UUID, as Supabase makes them). */
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Someone engram-web lists as owed the email. */
const person = (n: number, email = `person${n}@example.test`) => ({ id: uid(n), email });
const mac = (message: string, key: string) => createHmac("sha256", key).update(message).digest("hex");
const userSig = (id: string, key = KEY) => mac(`user:${id}`, key);
const digestSig = (id: string) => mac(`digest:${id}`, KEY);
const userLink = (id: string, sig = userSig(id)) => `${BASE}?user=${encodeURIComponent(id)}&sig=${sig}`;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

/** What the worker asks engram-web to send. */
interface Mail {
  to: string;
  user_id: string;
  unsubscribe_url: string;
  test?: boolean;
}

/** engram-web's answer to a send: a status, a status and a body, or "throw" for no answer at all. */
type Answer = number | "throw" | { status: number; body: unknown };
/** engram-web's answer to the list, when it is not the list. */
type ListAnswer = "throw" | { status: number; text?: string };

const notOwed: Answer = { status: 409, body: { error: "not_owed", reason: "already_signed_in" } };

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

const json = (text: string, status: number) =>
  new Response(text, { status, headers: { "Content-Type": "application/json" } });

describe("The finish-sign-up email (engram#781), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  /** The same schema without email_opt_outs: production mid-deploy, before 0051. */
  let bare: D1Database;
  let clock: number;
  /** Who engram-web lists (any shape: the worker must cope). */
  let people: unknown[];
  /** null: engram-web answers with `people`. */
  let listAnswer: ListAnswer | null;
  let webAnswer: (mail: Mail) => Answer | Promise<Answer>;
  /** Every send the worker asked for. */
  let posts: Mail[];
  /** The ones engram-web sent. */
  let mails: Mail[];
  /** Every request to engram-web, by method. */
  let requests: string[];
  /** The bearer on each of them. */
  let bearers: string[];

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "finish-signup", BARE: "finish-signup-bare" },
    });
    db = await mf.getD1Database("DB");
    bare = await mf.getD1Database("BARE");
    await applyAllMigrations(db);
    await applyAllMigrations(bare);
    await bare.prepare("DROP TABLE email_opt_outs").run();
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await db.batch(
      ["campaign_runs", "campaign_sends", "email_log", "email_opt_outs", "organizations"].map((t) =>
        db.prepare(`DELETE FROM ${t}`),
      ),
    );
    people = [];
    listAnswer = null;
    webAnswer = () => 200;
    posts = [];
    mails = [];
    requests = [];
    bearers = [];
    clock = START;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.origin !== WEB || url.pathname !== "/api/email/finish-signup") {
          throw new Error(`unexpected request to ${url}`);
        }
        const method = init?.method ?? "GET";
        requests.push(method);
        bearers.push(new Headers(init?.headers).get("Authorization") ?? "");
        if (method === "GET") {
          if (listAnswer === "throw") throw new Error("connection reset");
          if (listAnswer !== null) return json(listAnswer.text ?? "{}", listAnswer.status);
          return json(JSON.stringify({ cutoff: CUTOFF, users: people }), 200);
        }
        const mail = JSON.parse(String(init?.body)) as Mail;
        posts.push(mail);
        const answer = await webAnswer(mail);
        if (answer === "throw") throw new Error("connection reset");
        const { status, body } =
          typeof answer === "number" ? { status: answer, body: answer === 200 ? { sent: true, offer: true } : {} } : answer;
        if (status === 200) mails.push(mail);
        return json(JSON.stringify(body), status);
      }),
    );
  });

  afterEach(() => {
    const strangers = bearers.filter((b) => b !== "Bearer web-bearer");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    // Every request to engram-web carried the website bearer.
    expect(strangers).toEqual([]);
  });

  function env(over: Partial<Env> = {}): Env {
    return {
      ...createMockEnv(db),
      APP_URL: WEB,
      ADMIN_SECRET: "admin-test",
      INTERNAL_CRON_SECRET: "web-bearer",
      UNSUBSCRIBE_HMAC_KEY: KEY,
      ...over,
    } as unknown as Env;
  }

  /** An org (someone who got in), subscribed unless told otherwise. */
  async function org(id: string, email: string | null, o: { deleted?: boolean; optOut?: boolean } = {}) {
    await db
      .prepare("INSERT INTO organizations (id, name, email, digest_opt_out, deleted_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, `Name ${id}`, email, o.optOut ? 1 : 0, o.deleted ? "2026-11-19 00:00:00" : null)
      .run();
  }

  const optedOut = (email: string) =>
    db.prepare("INSERT INTO email_opt_outs (email, user_id, source) VALUES (?, NULL, ?)").bind(email, FINISH_SIGNUP).run();

  const claim = (email: string, id: string, status: string, campaign = FINISH_SIGNUP) =>
    db
      .prepare("INSERT INTO campaign_sends (campaign, email, org_id, status) VALUES (?, ?, ?, ?)")
      .bind(campaign, email, id, status)
      .run();

  /** Person `n` got the email: claimed, sent, and logged by engram-web (no org, the address). */
  async function gotIt(n: number) {
    const p = person(n);
    await claim(p.email, p.id, "sent");
    await db
      .prepare("INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES (?, NULL, ?, ?, '2026-11-21 08:00:00')")
      .bind(`el_${n}`, p.email, FINISH_SIGNUP)
      .run();
  }

  const sends = async (campaign = FINISH_SIGNUP) =>
    (
      await db
        .prepare("SELECT email, org_id, status FROM campaign_sends WHERE campaign = ? ORDER BY email")
        .bind(campaign)
        .all<{ email: string; org_id: string; status: string }>()
    ).results;

  const optOuts = async () =>
    (
      await db
        .prepare("SELECT email, user_id, source, opted_out_at FROM email_opt_outs ORDER BY email")
        .all<{ email: string; user_id: string | null; source: string; opted_out_at: string }>()
    ).results;

  const logRows = async () =>
    (await db.prepare("SELECT id, unsubscribed_at FROM email_log ORDER BY id").all<{ id: string; unsubscribed_at: string | null }>())
      .results;

  const credited = async () => (await logRows()).filter((r) => r.unsubscribed_at !== null).map((r) => r.id);

  const digestOptOut = (id: string) =>
    db
      .prepare("SELECT digest_opt_out AS out, digest_opt_out_at AS at FROM organizations WHERE id = ?")
      .bind(id)
      .first<{ out: number; at: string | null }>();

  const runRow = (campaign = FINISH_SIGNUP) =>
    db
      .prepare("SELECT state, note, lease_until, failed_ticks, finished_at FROM campaign_runs WHERE campaign = ?")
      .bind(campaign)
      .first<RunRow>();

  /** Person `n`'s finish-sign-up email was opened. */
  const opened = (n: number) =>
    db.prepare("UPDATE email_log SET opened_at = '2026-11-21 09:00:00' WHERE id = ?").bind(`el_${n}`).run();

  /** A D1 that records every statement prepared on it in `sql`. */
  const recordingDb = (sql: string[]): D1Database =>
    new Proxy(db, {
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

  /**
   * Checks that none of the statements touching the campaign tables walks
   * one, and that each reading email_log reads it by its type index.
   * Answers how many read email_log.
   */
  async function expectNoWalks(sql: string[]): Promise<number> {
    const touching = [...new Set(sql)].filter((q) => /\b(campaign_sends|email_log|email_opt_outs)\b/.test(q));
    // Not vacuous: each table was read or written along the way.
    for (const table of ["campaign_sends", "email_log", "email_opt_outs"]) {
      expect(
        touching.some((q) => new RegExp(`\\b${table}\\b`).test(q)),
        table,
      ).toBe(true);
    }
    let readsEmailLog = 0;
    for (const q of touching) {
      const plan = (
        await db
          .prepare(`EXPLAIN QUERY PLAN ${q}`)
          .bind(...Array.from({ length: paramCount(q) }, () => "[]"))
          .all<{ detail: string }>()
      ).results.map((r) => r.detail);
      expect(plan.filter((line) => /^SCAN (campaign_sends|email_log|email_opt_outs)\b/.test(line)), q).toEqual([]);
      if (/\bemail_log\b/.test(q)) {
        expect(plan.some((line) => /^SEARCH email_log USING (COVERING )?INDEX idx_email_log_type\b/.test(line)), q).toBe(true);
        readsEmailLog++;
      }
    }
    return readsEmailLog;
  }

  const ok = (r: Awaited<ReturnType<typeof runFinishSignup>>): FinishSignupResult => {
    if ("error" in r) throw new Error(`refused: ${r.error}`);
    return r;
  };

  /** The next cron tick, two minutes after the last. */
  async function tick(e: Env = env()) {
    clock += TICK;
    return runCampaignTick(e);
  }

  async function start(e: Env = env()) {
    const r = await startCampaignRun(e, FINISH_SIGNUP);
    if ("error" in r) throw new Error(`start refused: ${r.error}`);
    return r.run;
  }

  async function admin(method: "GET" | "POST", body?: unknown, bearer = "admin-test", e: Env = env()) {
    const res = await app.fetch(
      new Request(`${WORKER}/admin/campaigns/${FINISH_SIGNUP}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
        body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      }),
      e,
      ctx,
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  async function send(url: string, init?: RequestInit, e: Env = env()) {
    const res = await app.fetch(new Request(url, init), e, ctx);
    return { status: res.status, csp: res.headers.get("Content-Security-Policy"), body: await res.text() };
  }

  // -------------------------------------------------------------------------
  describe("who it goes to", () => {
    it("everyone engram-web lists, once per address, less anyone with an org, opted out or already sent it", async () => {
      people = [
        person(1),
        person(2, " Person2@Example.TEST "),
        // The same address under a second account: one email.
        person(3, "person2@example.test"),
        { id: "not-a-uuid", email: "bad-id@example.test" },
        { id: uid(4), email: "no-at-sign" },
        { id: uid(5) },
        null,
        "string",
        person(6, "has.org@example.test"),
        person(7, "deleted.org@example.test"),
        person(8),
        person(9),
        person(10),
      ];
      // Got in another way: an org with the address, however it is written.
      await org("org_has", " has.org@EXAMPLE.test ");
      // An org since deleted still means they got in once.
      await org("org_deleted", "deleted.org@example.test", { deleted: true });
      // An org with no address must not leave everyone out.
      await org("org_null", null);
      await optedOut("person8@example.test");
      await claim("person9@example.test", uid(9), "sent");
      // Another campaign's claim on an address is not this one's.
      await claim("person10@example.test", "org_x", "sent", "black-friday");

      expect(ok(await runFinishSignup(env(), { dryRun: true }))).toEqual({
        dry_run: true,
        listed: 7,
        owed: 3,
        sent: 0,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: { sent: 1 },
      });
      expect(requests).toEqual(["GET"]);

      expect(ok(await runFinishSignup(env()))).toEqual({
        dry_run: false,
        listed: 7,
        owed: 3,
        sent: 3,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: { sent: 4 },
      });
      expect(posts.map((p) => p.user_id)).toEqual([uid(1), uid(2), uid(10)]);
      expect(posts[1].to).toBe("person2@example.test");
    });

    it("asks engram-web to send each email with the address, the account and a signed link, and records the address", async () => {
      people = [person(1)];
      ok(await runFinishSignup(env()));
      expect(posts).toEqual([{ to: "person1@example.test", user_id: uid(1), unsubscribe_url: userLink(uid(1)) }]);
      expect(await sends()).toEqual([{ email: "person1@example.test", org_id: uid(1), status: "sent" }]);
    });

    it("sends to an address once, ever, and never to one whose send is in flight or may have gone out", async () => {
      people = [person(1), person(2), person(3)];
      await claim("person2@example.test", uid(2), "claimed");
      await claim("person3@example.test", uid(3), "unknown");
      expect(ok(await runFinishSignup(env()))).toMatchObject({ owed: 1, sent: 1 });
      expect(ok(await runFinishSignup(env()))).toMatchObject({ owed: 0, sent: 0, skipped: 0, failed: 0 });
      expect(posts.map((p) => p.user_id)).toEqual([uid(1)]);
    });

    it("skips an address another send claimed after the list was read", async () => {
      people = [person(1), person(2)];
      webAnswer = async (mail) => {
        if (mail.user_id === uid(1)) await claim("person2@example.test", uid(2), "claimed");
        return 200;
      };
      expect(ok(await runFinishSignup(env()))).toMatchObject({ owed: 2, sent: 1, skipped: 1, failed: 0, stopped: false });
      expect(posts.map((p) => p.user_id)).toEqual([uid(1)]);
    });

    it("sends nothing to nobody", async () => {
      expect(ok(await runFinishSignup(env()))).toMatchObject({ listed: 0, owed: 0, sent: 0 });
      expect(requests).toEqual(["GET"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("engram-web's answer to each send", () => {
    it("no longer owed it (409 not_owed): skipped, and the claim given back", async () => {
      people = [person(1)];
      webAnswer = () => notOwed;
      expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 0, skipped: 1, failed: 0, stopped: false });
      expect(await sends()).toEqual([]);
    });

    it.each([424, 400, 401, 409])("a refusal (%i): failed, the claim given back, so a later batch sends it", async (status) => {
      people = [person(1)];
      webAnswer = () => status;
      expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 0, skipped: 0, failed: 1 });
      expect(await sends()).toEqual([]);
      webAnswer = () => 200;
      expect(ok(await runFinishSignup(env()))).toMatchObject({ owed: 1, sent: 1 });
      expect(mails.map((m) => m.user_id)).toEqual([uid(1)]);
    });

    it.each([500, 502, "throw"] as const)(
      "a server error or no answer (%s): failed, and kept, so it is never sent again",
      async (answer) => {
        people = [person(1)];
        webAnswer = () => answer;
        expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 0, failed: 1 });
        expect(await sends()).toEqual([{ email: "person1@example.test", org_id: uid(1), status: "unknown" }]);
        webAnswer = () => 200;
        expect(ok(await runFinishSignup(env()))).toMatchObject({ owed: 0, sent: 0 });
        expect(posts).toHaveLength(1);
      },
    );

    describe("a batch that keeps sending nothing", () => {
      function answers(...list: Answer[]) {
        let i = 0;
        webAnswer = () => list[i++] ?? 200;
      }

      it("stops after three answers in a row that sent nothing", async () => {
        people = [1, 2, 3, 4, 5].map((n) => person(n));
        answers(200, notOwed, notOwed, notOwed);
        expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 1, skipped: 3, failed: 0, stopped: true });
        expect(posts).toHaveLength(4);
      });

      it("counts every kind of answer that sent nothing", async () => {
        people = [1, 2, 3, 4].map((n) => person(n));
        answers(notOwed, 424, 500);
        expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 0, skipped: 1, failed: 2, stopped: true });
        expect(posts).toHaveLength(3);
      });

      it("starts counting again after a send goes through", async () => {
        people = [1, 2, 3, 4, 5, 6].map((n) => person(n));
        answers(424, 424, 200, 424, 424, 200);
        expect(ok(await runFinishSignup(env()))).toMatchObject({ sent: 2, failed: 4, stopped: false });
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("how many it sends at once", () => {
    beforeEach(() => {
      people = Array.from({ length: 80 }, (_, i) => person(i + 1));
    });

    it.each([
      { limit: 5, n: 5 },
      { limit: 1000, n: BATCH_MAX },
      { limit: undefined, n: 20 },
    ])("limit $limit sends $n", async ({ limit, n }) => {
      expect(ok(await runFinishSignup(env(), { limit }))).toMatchObject({ owed: 80, sent: n });
      expect(posts).toHaveLength(n);
    });

    it("starts no send after the deadline", async () => {
      webAnswer = () => {
        clock += 40_000;
        return 200;
      };
      expect(ok(await runFinishSignup(env(), { limit: BATCH_MAX, deadline: clock + 90_000 }))).toMatchObject({ sent: 3 });
      expect(posts).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  describe("when engram-web does not answer with the list", () => {
    it.each<[string, ListAnswer, string]>([
      ["a server error", { status: 500 }, "engram-web answered 500 for the finish-sign-up list"],
      ["a refusal", { status: 401 }, "engram-web answered 401 for the finish-sign-up list"],
      ["no answer", "throw", "connection reset"],
      ["no users", { status: 200, text: "{}" }, "engram-web sent no finish-sign-up list"],
      ["users that are not a list", { status: 200, text: '{"users":"nope"}' }, "engram-web sent no finish-sign-up list"],
      ["null", { status: 200, text: "null" }, "engram-web sent no finish-sign-up list"],
      ["not JSON", { status: 200, text: "<html>" }, "engram-web sent no finish-sign-up list"],
    ])("%s: throws, and sends nothing", async (_, answer, message) => {
      people = [person(1)];
      listAnswer = answer;
      await expect(runFinishSignup(env())).rejects.toThrow(message);
      await expect(runFinishSignup(env(), { dryRun: true })).rejects.toThrow(message);
      expect(posts).toEqual([]);
      expect(await sends()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("the cron", () => {
    it("sends a batch a tick once started, and finishes by itself when nobody is left", async () => {
      people = Array.from({ length: 70 }, (_, i) => person(i + 1));
      expect(await start()).toMatchObject({ campaign: FINISH_SIGNUP, state: "running", sending: false });
      expect(requests).toEqual([]);

      const [first] = await tick();
      expect(first).toMatchObject({ campaign: FINISH_SIGNUP, outcome: "batch", state: "running", note: null });
      expect(first.result).toMatchObject({ owed: 70, sent: BATCH_MAX });
      const [second] = await tick();
      expect(second).toMatchObject({ state: "running" });
      expect(second.result).toMatchObject({ owed: 20, sent: 20 });
      const [third] = await tick();
      expect(third).toMatchObject({ state: "done", note: "Sent to everyone it was owed to." });
      expect(third.result).toMatchObject({ owed: 0, sent: 0 });

      expect(mails).toHaveLength(70);
      expect(new Set(mails.map((m) => m.to)).size).toBe(70);
      const row = await runRow();
      expect(row).toMatchObject({ state: "done", note: "Sent to everyone it was owed to.", lease_until: null, failed_ticks: 0 });
      expect(row?.finished_at).not.toBeNull();
      expect(await tick()).toEqual([]);
      expect(posts).toHaveLength(70);
    });

    it("runs on the two-minute cron", async () => {
      people = [person(1)];
      await start();
      await app.scheduled(
        { cron: "*/2 * * * *", scheduledTime: clock, type: "scheduled", noRetry() {} } as unknown as ScheduledEvent,
        env(),
        ctx,
      );
      expect(mails.map((m) => m.user_id)).toEqual([uid(1)]);
    });

    it("tries again next tick when the list fails, and pauses after three ticks in a row", async () => {
      people = [person(1)];
      await start();
      listAnswer = { status: 500 };
      const [first] = await tick();
      expect(first).toMatchObject({
        state: "running",
        note: "The batch failed: engram-web answered 500 for the finish-sign-up list",
      });
      await tick();
      const [third] = await tick();
      expect(third.state).toBe("paused");
      const row = await runRow();
      expect(row).toMatchObject({ state: "paused", failed_ticks: 3, lease_until: null });
      expect(row?.note).toContain("(3 ticks in a row)");
      expect(posts).toEqual([]);
    });

    it("a tick that sends again clears the failures before it", async () => {
      people = [person(1)];
      await start();
      listAnswer = { status: 500 };
      await tick();
      await tick();
      listAnswer = null;
      const [t] = await tick();
      expect(t.result).toMatchObject({ sent: 1 });
      expect(await runRow()).toMatchObject({ failed_ticks: 0 });
    });

    it("pauses when a batch stops after three sends in a row that sent nothing", async () => {
      people = [1, 2, 3, 4].map((n) => person(n));
      webAnswer = () => 424;
      await start();
      const [t] = await tick();
      expect(t).toMatchObject({ state: "paused", note: "Stopped after repeated failed sends; see the worker log." });
      expect(posts).toHaveLength(3);
    });

    it("pauses when no send in a batch went through", async () => {
      people = [person(1)];
      webAnswer = () => 424;
      await start();
      const [t] = await tick();
      expect(t).toMatchObject({ state: "paused", note: "No send in the last batch went through; see the worker log." });
    });

    it("pauses, sending nothing, when mail is no longer configured", async () => {
      people = [person(1)];
      await start();
      const [t] = await tick(env({ APP_URL: undefined }));
      expect(t).toMatchObject({ state: "paused", note: "No website bearer, signing key or APP_URL; nothing was sent." });
      expect(requests).toEqual([]);
    });

    it.each<[string, Partial<Env>]>([
      ["no APP_URL", { APP_URL: undefined }],
      ["no website bearer", { INTERNAL_CRON_SECRET: undefined, ADMIN_SECRET: undefined }],
      ["no signing key", { UNSUBSCRIBE_HMAC_KEY: undefined, ADMIN_SECRET: undefined }],
    ])("will not start with %s, and writes and asks nothing", async (_, over) => {
      people = [person(1)];
      expect(await startCampaignRun(env(over), FINISH_SIGNUP)).toEqual({
        error: "mail_not_configured",
        message: "No website bearer, signing key or APP_URL; nothing was sent.",
        status: 500,
      });
      expect(await runRow()).toBeNull();
      expect(requests).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  describe("/admin/campaigns/finish-signup", () => {
    it("needs the admin secret", async () => {
      people = [person(1)];
      expect((await admin("GET", undefined, "wrong")).status).toBe(401);
      expect((await admin("POST", { start: true }, "wrong")).status).toBe(401);
      expect((await admin("POST", { test_to: TEST_RECIPIENT }, "wrong")).status).toBe(401);
      expect(requests).toEqual([]);
      expect(await runRow()).toBeNull();
    });

    it("GET counts who engram-web lists and who is still owed it, and sends nothing", async () => {
      people = [person(1), person(2), person(3)];
      await claim("person3@example.test", uid(3), "sent");
      expect(await admin("GET")).toEqual({
        status: 200,
        body: { campaign: FINISH_SIGNUP, listed: 3, owed: 2, recorded: { sent: 1 }, run: null },
      });
      expect(posts).toEqual([]);
    });

    it("GET says why when engram-web does not list them", async () => {
      listAnswer = { status: 500 };
      expect(await admin("GET")).toEqual({
        status: 502,
        body: { error: "list_failed", message: "engram-web answered 500 for the finish-sign-up list" },
      });
    });

    it("GET without mail configured", async () => {
      expect(await admin("GET", undefined, "admin-test", env({ APP_URL: undefined }))).toEqual({
        status: 500,
        body: { error: "mail_not_configured", message: "No website bearer, signing key or APP_URL; nothing was sent." },
      });
      expect(requests).toEqual([]);
    });

    it.each<unknown>([
      {},
      "",
      "{",
      "null",
      "5",
      { start: "true" },
      { start: 1 },
      { start: true, pause: true },
      { start: true, test_to: TEST_RECIPIENT },
      { pause: true, test_to: TEST_RECIPIENT },
      { test_to: 5 },
      { test_to: null },
      { send: true },
    ])("POST %j is refused, and nothing happens", async (body) => {
      people = [person(1)];
      expect(await admin("POST", body)).toEqual({
        status: 400,
        body: { error: "bad_request", message: "Send exactly one of: start: true, pause: true or test_to: <address>." },
      });
      expect(requests).toEqual([]);
      expect(await runRow()).toBeNull();
    });

    it("POST start starts the run and sends nothing itself; pause stops it before the next batch", async () => {
      people = [person(1), person(2)];
      const started = await admin("POST", { start: true });
      expect(started.status).toBe(200);
      expect(started.body).toMatchObject({
        owed: 2,
        run: { campaign: FINISH_SIGNUP, state: "running", sending: false, note: null },
      });
      expect(posts).toEqual([]);

      expect(await admin("POST", { pause: true })).toMatchObject({
        status: 200,
        body: { paused: true, run: { state: "paused", note: "Paused from /admin." } },
      });
      expect(await tick()).toEqual([]);
      expect(posts).toEqual([]);

      expect(await admin("POST", { start: true })).toMatchObject({
        status: 200,
        body: { run: { state: "running", note: null } },
      });
      await tick();
      expect(mails.map((m) => m.user_id)).toEqual([uid(1), uid(2)]);
    });

    it("POST start answers with no count when the list fails, but the run has started", async () => {
      people = [person(1)];
      listAnswer = { status: 500 };
      expect(await admin("POST", { start: true })).toMatchObject({
        status: 200,
        body: { owed: null, run: { state: "running" } },
      });
      expect(await runRow()).toMatchObject({ state: "running" });
    });

    it("POST start is refused while another campaign is running", async () => {
      await db.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('black-friday-resend', 'running')").run();
      expect(await admin("POST", { start: true })).toEqual({
        status: 409,
        body: {
          error: "another_campaign_running",
          message: "black-friday-resend is still running; start this one after it is done or paused.",
        },
      });
      expect(await runRow()).toBeNull();
    });

    it("POST test_to sends one test copy to hello@ only, and records nothing", async () => {
      people = [person(1)];
      expect(await admin("POST", { test_to: " Hello@GetEngram.app " })).toEqual({
        status: 200,
        body: { sent: true, offer: true },
      });
      expect(posts).toEqual([{ to: TEST_RECIPIENT, user_id: TEST_USER, unsubscribe_url: userLink(TEST_USER), test: true }]);
      // No list: a test copy goes to nobody on it.
      expect(requests).toEqual(["POST"]);
      expect(await sends()).toEqual([]);
      expect(await runRow()).toBeNull();
    });

    it("passes on whether the test copy carried the offer", async () => {
      webAnswer = () => ({ status: 200, body: { sent: true, offer: false } });
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({ status: 200, body: { sent: true, offer: false } });
    });

    it.each(["person1@example.test", "hello@getengram.app.evil.test", ""])("refuses a test copy to %j", async (to) => {
      expect(await admin("POST", { test_to: to })).toEqual({
        status: 400,
        body: { error: "bad_request", message: "A test copy goes to hello@getengram.app only." },
      });
      expect(requests).toEqual([]);
    });

    it.each([500, 409, "throw"] as const)("says so when engram-web does not send the test copy (%s)", async (answer) => {
      webAnswer = () => answer;
      expect(await admin("POST", { test_to: TEST_RECIPIENT })).toEqual({
        status: 502,
        body: { error: "test_send_failed", message: "engram-web did not send the test copy; see its log." },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("the unsubscribe link in it", () => {
    beforeEach(async () => {
      await gotIt(1);
      // A later email of another kind to the same address: never credited.
      await db
        .prepare("INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES ('el_welcome', NULL, ?, 'welcome', '2026-11-21 09:00:00')")
        .bind("person1@example.test")
        .run();
      // An org with the address (written another way), and one without it.
      await org("org_a", " Person1@Example.test ");
      await org("org_b", "other@example.test");
    });

    it("GET asks first, and changes nothing however often it is fetched", async () => {
      for (let i = 0; i < 3; i++) {
        const r = await send(userLink(uid(1)));
        expect(r.status).toBe(200);
        expect(r.csp).toBe(UNSUBSCRIBE_PAGE_SECURITY_POLICY);
        expect(r.body).toContain("Unsubscribe from Engram emails?");
        expect(r.body).toContain('<form method="post"><button type="submit"');
      }
      expect(await optOuts()).toEqual([]);
      expect(await digestOptOut("org_a")).toEqual({ out: 0, at: null });
      expect(await credited()).toEqual([]);
    });

    it("POST opts the address out, and any org with it, and credits the email", async () => {
      const r = await send(userLink(uid(1)), { method: "POST" });
      expect(r.status).toBe(200);
      expect(r.body).toContain("You're unsubscribed");
      expect(await optOuts()).toEqual([
        { email: "person1@example.test", user_id: uid(1), source: FINISH_SIGNUP, opted_out_at: expect.any(String) },
      ]);
      expect(await digestOptOut("org_a")).toEqual({ out: 1, at: expect.any(String) });
      expect(await digestOptOut("org_b")).toEqual({ out: 0, at: null });
      expect(await credited()).toEqual(["el_1"]);
    });

    it("a second POST changes nothing", async () => {
      await send(userLink(uid(1)), { method: "POST" });
      await db.batch([
        db.prepare("UPDATE email_opt_outs SET opted_out_at = '2026-11-21 10:00:00'"),
        db.prepare("UPDATE organizations SET digest_opt_out_at = '2026-11-21 10:00:00' WHERE id = 'org_a'"),
        db.prepare("UPDATE email_log SET unsubscribed_at = '2026-11-21 10:00:00' WHERE id = 'el_1'"),
      ]);
      const before = [await optOuts(), await digestOptOut("org_a"), await logRows()];
      clock += 3_600_000;
      const r = await send(userLink(uid(1)), { method: "POST" });
      expect(r.status).toBe(200);
      expect(r.body).toContain("You're unsubscribed");
      expect([await optOuts(), await digestOptOut("org_a"), await logRows()]).toEqual(before);
    });

    it("GET after the opt-out says so, with nothing to click", async () => {
      await send(userLink(uid(1)), { method: "POST" });
      const r = await send(userLink(uid(1)));
      expect(r.status).toBe(200);
      expect(r.body).toContain("You're unsubscribed");
      expect(r.body).not.toContain("<form");
    });

    it("keeps them off the email for good, even if their claim were gone", async () => {
      await send(userLink(uid(1)), { method: "POST" });
      await db.prepare("DELETE FROM campaign_sends").run();
      await db.prepare("DELETE FROM organizations").run();
      people = [person(1)];
      expect(ok(await runFinishSignup(env(), { dryRun: true }))).toMatchObject({ listed: 1, owed: 0 });
    });

    it.each<[string, () => string]>([
      ["signed with another key", () => userLink(uid(1), userSig(uid(1), "another-key"))],
      ["signed for another account", () => userLink(uid(1), userSig(uid(2)))],
      ["an org link's signature for the same id", () => userLink(uid(1), digestSig(uid(1)))],
      ["a made-up signature", () => userLink(uid(1), "0".repeat(64))],
      ["a signature in capitals", () => userLink(uid(1), userSig(uid(1)).toUpperCase())],
      ["no signature", () => `${BASE}?user=${uid(1)}`],
      ["an empty signature", () => `${BASE}?user=${uid(1)}&sig=`],
      ["no account, signed", () => `${BASE}?user=&sig=${userSig("")}`],
      ["nothing at all", () => `${BASE}?user=&sig=`],
      ["a user signature on an org link", () => `${BASE}?org=${uid(1)}&sig=${userSig(uid(1))}`],
      ["an org and a user", () => `${BASE}?org=org_a&user=${uid(1)}&sig=${userSig(uid(1))}`],
    ])("%s: refused on GET and POST, and nothing changes", async (_, link) => {
      for (const method of ["GET", "POST"]) {
        const r = await send(link(), { method });
        expect(r.status, method).toBe(400);
        expect(r.body, method).toBe("Invalid link.");
      }
      expect(await optOuts()).toEqual([]);
      expect(await digestOptOut("org_a")).toEqual({ out: 0, at: null });
      expect(await credited()).toEqual([]);
    });

    it("the test copy's link opts out nobody", async () => {
      const get = await send(userLink(TEST_USER));
      expect(get.status).toBe(200);
      expect(get.body).toContain("Unsubscribe from Engram emails?");
      const post = await send(userLink(TEST_USER), { method: "POST" });
      expect(post.status).toBe(200);
      expect(post.body).toContain("You're unsubscribed");
      expect(await optOuts()).toEqual([]);
      expect(await digestOptOut("org_a")).toEqual({ out: 0, at: null });
      expect(await credited()).toEqual([]);
    });

    it("works for an email whose send had no answer", async () => {
      await claim("person2@example.test", uid(2), "unknown");
      expect((await send(userLink(uid(2)), { method: "POST" })).status).toBe(200);
      expect((await optOuts()).map((o) => o.email)).toEqual(["person2@example.test"]);
    });

    it("takes a link signed with the previous key while that key is set", async () => {
      const link = userLink(uid(1), userSig(uid(1), OLD_KEY));
      expect((await send(link, { method: "POST" })).status).toBe(400);
      expect(await optOuts()).toEqual([]);
      const r = await send(link, { method: "POST" }, env({ UNSUBSCRIBE_HMAC_KEY_PREVIOUS: OLD_KEY }));
      expect(r.status).toBe(200);
      expect((await optOuts()).map((o) => o.email)).toEqual(["person1@example.test"]);
    });
  });

  // -------------------------------------------------------------------------
  describe("an org made later with an address that unsubscribed", () => {
    it("starts opted out; an org with any other address does not", async () => {
      await optedOut("person1@example.test");
      await insertOrganizationWithEmail(db, "org_new", "New", " Person1@EXAMPLE.test ");
      await insertOrganizationWithEmail(db, "org_fresh", "Fresh", "fresh@example.test");
      expect(await digestOptOut("org_new")).toEqual({ out: 1, at: expect.any(String) });
      expect(await digestOptOut("org_fresh")).toEqual({ out: 0, at: null });
    });

    it("an org that changes to that address is opted out", async () => {
      await optedOut("person1@example.test");
      await insertOrganizationWithEmail(db, "org_fresh", "Fresh", "fresh@example.test");
      await setOrganizationEmail(db, "org_fresh", "PERSON1@example.test");
      expect(await digestOptOut("org_fresh")).toEqual({ out: 1, at: expect.any(String) });
    });

    it("never fails a sign-up or an address change when the opt-out table is not there yet", async () => {
      await bare.prepare("DELETE FROM organizations").run();
      await expect(insertOrganizationWithEmail(bare, "org_new", "New", "person1@example.test")).resolves.toBeDefined();
      await expect(setOrganizationEmail(bare, "org_new", "other@example.test")).resolves.toBeDefined();
      expect(await bare.prepare("SELECT email, digest_opt_out AS out FROM organizations WHERE id = 'org_new'").first()).toEqual({
        email: "other@example.test",
        out: 0,
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("the finish-sign-up email again (engram#783)", () => {
    const resent = () => sends(FINISH_SIGNUP_RESEND);
    const again = (o: { dryRun?: boolean } = {}) => runFinishSignup(env(), { campaign: FINISH_SIGNUP_RESEND, ...o });

    async function resendAdmin(method: "GET" | "POST", body?: unknown, bearer = "admin-test") {
      const res = await app.fetch(
        new Request(`${WORKER}/admin/campaigns/${FINISH_SIGNUP_RESEND}`, {
          method,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
          body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
        }),
        env(),
        ctx,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    it("goes to the people the first one went to who are still stuck and have not opened it", async () => {
      people = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => person(n));
      // Got the first, never opened it.
      await gotIt(1);
      // Opened it.
      await gotIt(2);
      await opened(2);
      // Opened it; engram-web logged the address as it was typed.
      await claim("person3@example.test", uid(3), "sent");
      await db
        .prepare(
          "INSERT INTO email_log (id, org_id, recipient, type, sent_at, opened_at) VALUES ('el_3', NULL, ' Person3@Example.test ', ?, '2026-11-21 08:00:00', '2026-11-21 09:00:00')",
        )
        .bind(FINISH_SIGNUP)
        .run();
      // Person 4 is listed, but the first email never went to them.
      // Got in since: an org with the address.
      await gotIt(5);
      await org("org_5", "person5@example.test");
      // Unsubscribed.
      await gotIt(6);
      await optedOut("person6@example.test");
      // The first send had no clear answer: it may not have gone.
      await claim("person7@example.test", uid(7), "unknown");
      // Already sent this one.
      await gotIt(8);
      await claim("person8@example.test", uid(8), "sent", FINISH_SIGNUP_RESEND);
      // Opened only another kind of email.
      await gotIt(9);
      await db
        .prepare(
          "INSERT INTO email_log (id, org_id, recipient, type, sent_at, opened_at) VALUES ('el_9_welcome', NULL, 'person9@example.test', 'welcome', '2026-11-21 09:00:00', '2026-11-21 09:30:00')",
        )
        .run();
      // Got the first, but engram-web no longer lists them.
      await gotIt(10);
      const first = await sends();

      expect(ok(await again({ dryRun: true }))).toEqual({
        dry_run: true,
        listed: 9,
        owed: 2,
        sent: 0,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: { sent: 1 },
      });
      expect(requests).toEqual(["GET"]);

      expect(ok(await again())).toEqual({
        dry_run: false,
        listed: 9,
        owed: 2,
        sent: 2,
        skipped: 0,
        failed: 0,
        stopped: false,
        recorded: { sent: 3 },
      });
      // The same email as the first, with a link that names the account.
      expect(posts).toEqual([1, 9].map((n) => ({ to: `person${n}@example.test`, user_id: uid(n), unsubscribe_url: userLink(uid(n)) })));
      expect(await resent()).toEqual(
        [1, 8, 9].map((n) => ({ email: `person${n}@example.test`, org_id: uid(n), status: "sent" })),
      );
      // The first send's record is left as it was.
      expect(await sends()).toEqual(first);

      expect(ok(await again())).toMatchObject({ owed: 0, sent: 0 });
      expect(posts).toHaveLength(2);
    });

    it("an open recorded during the send counts at the next batch", async () => {
      people = [person(1), person(2)];
      await gotIt(1);
      await gotIt(2);
      expect(ok(await again({ dryRun: true }))).toMatchObject({ owed: 2 });
      await opened(2);
      ok(await again());
      expect(posts.map((p) => p.user_id)).toEqual([uid(1)]);
    });

    it("the cron sends it once started, and the finished first send stays finished", async () => {
      people = [1, 2, 3].map((n) => person(n));
      for (const n of [1, 2, 3]) await gotIt(n);
      await db
        .prepare("INSERT INTO campaign_runs (campaign, state, finished_at) VALUES (?, 'done', datetime('now'))")
        .bind(FINISH_SIGNUP)
        .run();
      expect(await startCampaignRun(env(), FINISH_SIGNUP_RESEND)).toMatchObject({
        run: { campaign: FINISH_SIGNUP_RESEND, state: "running", sending: false, note: null },
      });
      expect(requests).toEqual([]);

      const [first] = await tick();
      expect(first).toMatchObject({ campaign: FINISH_SIGNUP_RESEND, outcome: "batch", state: "running" });
      expect(first.result).toMatchObject({ owed: 3, sent: 3 });
      const [second] = await tick();
      expect(second).toMatchObject({ campaign: FINISH_SIGNUP_RESEND, state: "done", note: "Sent to everyone it was owed to." });
      expect(await tick()).toEqual([]);

      expect(mails.map((m) => m.user_id)).toEqual([uid(1), uid(2), uid(3)]);
      expect(await resent()).toHaveLength(3);
      expect(await runRow(FINISH_SIGNUP)).toMatchObject({ state: "done" });
      expect(await runRow(FINISH_SIGNUP_RESEND)).toMatchObject({ state: "done" });
    });

    it("starts only while no other campaign is running", async () => {
      await db.prepare("INSERT INTO campaign_runs (campaign, state) VALUES ('black-friday-fourth', 'running')").run();
      expect(await resendAdmin("POST", { start: true })).toEqual({
        status: 409,
        body: {
          error: "another_campaign_running",
          message: "black-friday-fourth is still running; start this one after it is done or paused.",
        },
      });
      expect(await runRow(FINISH_SIGNUP_RESEND)).toBeNull();
    });

    it("has its own /admin switch, which needs the admin secret and sends nothing", async () => {
      people = [1, 2, 3].map((n) => person(n));
      await gotIt(1);
      await gotIt(2);
      await opened(2);
      expect((await resendAdmin("GET", undefined, "wrong")).status).toBe(401);
      expect((await resendAdmin("POST", { start: true }, "wrong")).status).toBe(401);
      expect((await resendAdmin("POST", { test_to: TEST_RECIPIENT }, "wrong")).status).toBe(401);
      expect(requests).toEqual([]);

      expect(await resendAdmin("GET")).toEqual({
        status: 200,
        body: { campaign: FINISH_SIGNUP_RESEND, listed: 3, owed: 1, recorded: {}, run: null },
      });
      for (const body of [{}, "", "{", "null", { start: true, pause: true }, { start: true, test_to: TEST_RECIPIENT }, { test_to: 5 }]) {
        expect(await resendAdmin("POST", body)).toEqual({
          status: 400,
          body: { error: "bad_request", message: "Send exactly one of: start: true, pause: true or test_to: <address>." },
        });
      }
      expect(await runRow(FINISH_SIGNUP_RESEND)).toBeNull();

      expect(await resendAdmin("POST", { start: true })).toMatchObject({
        status: 200,
        body: { owed: 1, run: { campaign: FINISH_SIGNUP_RESEND, state: "running", sending: false, note: null } },
      });
      expect(await runRow(FINISH_SIGNUP)).toBeNull();
      expect(await resendAdmin("POST", { pause: true })).toMatchObject({
        status: 200,
        body: { paused: true, run: { state: "paused", note: "Paused from /admin." } },
      });
      expect(await tick()).toEqual([]);
      expect(posts).toEqual([]);
    });

    it("test_to sends one test copy to hello@ only, and records nothing", async () => {
      people = [person(1)];
      await gotIt(1);
      expect(await resendAdmin("POST", { test_to: " Hello@GetEngram.app " })).toEqual({
        status: 200,
        body: { sent: true, offer: true },
      });
      expect(posts).toEqual([{ to: TEST_RECIPIENT, user_id: TEST_USER, unsubscribe_url: userLink(TEST_USER), test: true }]);
      expect(requests).toEqual(["POST"]);
      expect(await resent()).toEqual([]);
      expect(await runRow(FINISH_SIGNUP_RESEND)).toBeNull();

      expect(await resendAdmin("POST", { test_to: "person1@example.test" })).toEqual({
        status: 400,
        body: { error: "bad_request", message: "A test copy goes to hello@getengram.app only." },
      });
      expect(posts).toHaveLength(1);
    });

    it("its unsubscribe link works when it names a different account than the first one did", async () => {
      // engram-web listed the address under a second account this time.
      await gotIt(1);
      await claim("person1@example.test", uid(11), "sent", FINISH_SIGNUP_RESEND);
      await db
        .prepare(
          "INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES ('el_again', NULL, 'person1@example.test', ?, '2026-11-22 05:00:00')",
        )
        .bind(FINISH_SIGNUP)
        .run();
      await org("org_a", " Person1@Example.test ");

      const get = await send(userLink(uid(11)));
      expect(get.status).toBe(200);
      expect(get.body).toContain("Unsubscribe from Engram emails?");
      expect(await optOuts()).toEqual([]);

      const post = await send(userLink(uid(11)), { method: "POST" });
      expect(post.status).toBe(200);
      expect(post.body).toContain("You're unsubscribed");
      expect(await optOuts()).toEqual([
        { email: "person1@example.test", user_id: uid(11), source: FINISH_SIGNUP, opted_out_at: expect.any(String) },
      ]);
      expect(await digestOptOut("org_a")).toEqual({ out: 1, at: expect.any(String) });
      // The newer of the two emails to the address.
      expect(await credited()).toEqual(["el_again"]);
    });
  });

  // -------------------------------------------------------------------------
  it("its statements read email_log by its type index and never walk campaign_sends or email_log", async () => {
    const sql: string[] = [];
    const recording = recordingDb(sql);
    const e = env({ DB: recording });
    people = [person(1), person(2)];
    await gotIt(3);
    ok(await runFinishSignup(e, { dryRun: true }));
    await startCampaignRun(e, FINISH_SIGNUP);
    await runCampaignTick(e);
    expect(mails).toHaveLength(2);
    await admin("GET", undefined, "admin-test", e);
    await send(userLink(uid(3)), undefined, e);
    await send(userLink(uid(3)), { method: "POST" }, e);
    await insertOrganizationWithEmail(recording, "org_new", "New", "person3@example.test");
    expect(await credited()).toEqual(["el_3"]);

    // The unsubscribe's credit.
    expect(await expectNoWalks(sql)).toBe(1);
  });

  it("the second send's statements read email_log by its type index and never walk campaign_sends or email_log", async () => {
    const sql: string[] = [];
    const e = env({ DB: recordingDb(sql) });
    people = [1, 2, 3].map((n) => person(n));
    for (const n of [1, 2, 3]) await gotIt(n);
    await opened(3);
    ok(await runFinishSignup(e, { campaign: FINISH_SIGNUP_RESEND, dryRun: true }));
    await startCampaignRun(e, FINISH_SIGNUP_RESEND);
    await runCampaignTick(e);
    expect(mails.map((m) => m.user_id)).toEqual([uid(1), uid(2)]);
    await app.fetch(
      new Request(`${WORKER}/admin/campaigns/${FINISH_SIGNUP_RESEND}`, { headers: { Authorization: "Bearer admin-test" } }),
      e,
      ctx,
    );
    await send(userLink(uid(1)), undefined, e);
    await send(userLink(uid(1)), { method: "POST" }, e);
    expect(await credited()).toEqual(["el_1"]);

    // Who is owed it, and the unsubscribe's credit.
    expect(await expectNoWalks(sql)).toBe(2);
  });
});
