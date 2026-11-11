import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Hono } from "hono";
import app from "../index.js";
import {
  lifecycleMail,
  unsubscribeSig,
  unsubscribeSigValid,
  websiteBearer,
} from "../services/secrets.js";
import { sendWeeklyDigests } from "../cron/weekly-digest.js";
import { sendActivationNudges } from "../cron/activation-nudge.js";
import { sendImportNudges } from "../cron/import-nudge.js";
import { sendMaxoutNudges } from "../cron/maxout-nudge.js";
import { sendRecallNudges } from "../cron/recall-nudge.js";
import { sendStudentReverifyReminders } from "../cron/student-reverify.js";
import { expireGracePeriods } from "../cron/expire-grace.js";
import { sendShareNudge } from "../cron/share-nudge.js";
import { student } from "../routes/student.js";
import { createMockD1, createMockEnv } from "./helpers.js";
import { createOAuthD1, createOAuthEnv, pkcePair, signSupabaseJwt } from "./oauth-helpers.js";
import type { AuthContext, Env } from "../types.js";

/**
 * One secret per job (engram#456).
 *
 * ADMIN_SECRET was the owner's admin bearer, the bearer the worker showed
 * engram-web for every email and report, and the key that signed every
 * unsubscribe link, so a copy taken from any one of those places opened the
 * others. These pin the split, and that it changes nothing until the new
 * secrets are set: until then ADMIN_SECRET stands in for each of them.
 */

const ADMIN = "admin-secret-456-test";
const INTERNAL = "internal-secret-456-test";
const KEY = "unsubscribe-key-456-test";
const PREVIOUS = "previous-key-456-test";
const APP_URL = "https://app.example.test";
const ORG = "org_456";

type Secrets = Partial<
  Record<
    "ADMIN_SECRET" | "INTERNAL_CRON_SECRET" | "UNSUBSCRIBE_HMAC_KEY" | "UNSUBSCRIBE_HMAC_KEY_PREVIOUS",
    string
  >
>;

const ALL: Secrets = {
  ADMIN_SECRET: ADMIN,
  INTERNAL_CRON_SECRET: INTERNAL,
  UNSUBSCRIBE_HMAC_KEY: KEY,
  UNSUBSCRIBE_HMAC_KEY_PREVIOUS: PREVIOUS,
};

function secrets(s: Secrets): Env {
  return { ...s } as unknown as Env;
}

/** A link's signature, computed without the code under test. */
function hmac(key: string, org: string): string {
  return createHmac("sha256", key).update(`digest:${org}`).digest("hex");
}

function link(org: string, sig: string): string {
  return `https://mcp.getengram.app/email/unsubscribe?org=${encodeURIComponent(org)}&sig=${sig}`;
}

describe("websiteBearer", () => {
  it("is INTERNAL_CRON_SECRET when it is set", () => {
    expect(websiteBearer(secrets(ALL))).toBe(INTERNAL);
    expect(websiteBearer(secrets({ INTERNAL_CRON_SECRET: INTERNAL }))).toBe(INTERNAL);
  });

  it("is ADMIN_SECRET until then, as it always was", () => {
    expect(websiteBearer(secrets({ ADMIN_SECRET: ADMIN }))).toBe(ADMIN);
    expect(websiteBearer(secrets({ ADMIN_SECRET: ADMIN, INTERNAL_CRON_SECRET: "" }))).toBe(ADMIN);
  });

  it("is null when neither is set, and is never a signing key", () => {
    expect(websiteBearer(secrets({}))).toBeNull();
    expect(websiteBearer(secrets({ ADMIN_SECRET: "", INTERNAL_CRON_SECRET: "" }))).toBeNull();
    expect(
      websiteBearer(secrets({ UNSUBSCRIBE_HMAC_KEY: KEY, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: PREVIOUS })),
    ).toBeNull();
  });
});

describe("lifecycleMail", () => {
  it("signs with UNSUBSCRIBE_HMAC_KEY and shows engram-web INTERNAL_CRON_SECRET", async () => {
    const odd = "org_456&x=y z";
    const mail = lifecycleMail(secrets(ALL))!;
    expect(mail.bearer).toBe(INTERNAL);
    const url = await mail.unsubscribeUrl(odd);
    expect(url).toBe(link(odd, hmac(KEY, odd)));
    expect(url).toContain("?org=org_456%26x%3Dy%20z&sig=");
  });

  it("makes the same links as before when only ADMIN_SECRET is set", async () => {
    const mail = lifecycleMail(secrets({ ADMIN_SECRET: ADMIN }))!;
    expect(mail.bearer).toBe(ADMIN);
    expect(await mail.unsubscribeUrl(ORG)).toBe(link(ORG, hmac(ADMIN, ORG)));
  });

  it("needs no ADMIN_SECRET once both new secrets are set", async () => {
    const mail = lifecycleMail(secrets({ INTERNAL_CRON_SECRET: INTERNAL, UNSUBSCRIBE_HMAC_KEY: KEY }))!;
    expect(mail.bearer).toBe(INTERNAL);
    expect(await mail.unsubscribeUrl(ORG)).toBe(link(ORG, hmac(KEY, ORG)));
  });

  it("lets ADMIN_SECRET stand in for whichever one is not set yet", async () => {
    const signsWithAdmin = lifecycleMail(secrets({ ADMIN_SECRET: ADMIN, INTERNAL_CRON_SECRET: INTERNAL }))!;
    expect(signsWithAdmin.bearer).toBe(INTERNAL);
    expect(await signsWithAdmin.unsubscribeUrl(ORG)).toBe(link(ORG, hmac(ADMIN, ORG)));

    const showsAdmin = lifecycleMail(secrets({ ADMIN_SECRET: ADMIN, UNSUBSCRIBE_HMAC_KEY: KEY }))!;
    expect(showsAdmin.bearer).toBe(ADMIN);
    expect(await showsAdmin.unsubscribeUrl(ORG)).toBe(link(ORG, hmac(KEY, ORG)));
  });

  it.each<[string, Secrets]>([
    ["nothing is set", {}],
    ["only the bearer is set", { INTERNAL_CRON_SECRET: INTERNAL }],
    ["only the signing key is set", { UNSUBSCRIBE_HMAC_KEY: KEY }],
    ["only the previous key is set, which never signs", { INTERNAL_CRON_SECRET: INTERNAL, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: PREVIOUS }],
    ["every value is empty", { ADMIN_SECRET: "", INTERNAL_CRON_SECRET: "", UNSUBSCRIBE_HMAC_KEY: "" }],
    ["the signing key is empty", { INTERNAL_CRON_SECRET: INTERNAL, UNSUBSCRIBE_HMAC_KEY: "" }],
  ])("is null, so no email goes out, when %s", (_when, s) => {
    expect(lifecycleMail(secrets(s))).toBeNull();
  });

  it("signs what it documents: the hex HMAC-SHA256 of digest:<org id>", async () => {
    expect(await unsubscribeSig(ORG, KEY)).toBe(hmac(KEY, ORG));
  });
});

describe("unsubscribeSigValid", () => {
  const valid = (s: Secrets, sig: string, org = ORG) => unsubscribeSigValid(secrets(s), org, sig);

  it("accepts a link signed with the signing key or the key before it", async () => {
    const s = { UNSUBSCRIBE_HMAC_KEY: KEY, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: PREVIOUS };
    expect(await valid(s, hmac(KEY, ORG))).toBe(true);
    expect(await valid(s, hmac(PREVIOUS, ORG))).toBe(true);
  });

  it("keeps links mailed before the change working, at every step of the rollout", async () => {
    const mailed = hmac(ADMIN, ORG);
    // Today: ADMIN_SECRET signs and checks, as it always has.
    expect(await valid({ ADMIN_SECRET: ADMIN }, mailed)).toBe(true);
    // Once the signing key is set, ADMIN_SECRET no longer checks anything...
    expect(await valid({ ADMIN_SECRET: ADMIN, UNSUBSCRIBE_HMAC_KEY: KEY }, mailed)).toBe(false);
    // ...so its value goes into the previous-key slot first,
    const step = { ADMIN_SECRET: ADMIN, UNSUBSCRIBE_HMAC_KEY: KEY, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: ADMIN };
    expect(await valid(step, mailed)).toBe(true);
    // and the links still work after ADMIN_SECRET itself is rotated.
    const rotated = { ...step, ADMIN_SECRET: "rotated-admin-456-test" };
    expect(await valid(rotated, mailed)).toBe(true);
    expect(await valid(rotated, hmac("rotated-admin-456-test", ORG))).toBe(false);
  });

  it("rejects a signature made with either bearer once the signing key is set", async () => {
    expect(await valid(ALL, hmac(ADMIN, ORG))).toBe(false);
    expect(await valid(ALL, hmac(INTERNAL, ORG))).toBe(false);
  });

  it("rejects another org's signature", async () => {
    expect(await valid(ALL, hmac(KEY, "org_other"))).toBe(false);
    expect(await valid(ALL, hmac(KEY, ORG), "org_other")).toBe(false);
  });

  it("rejects anything but the 64 lowercase hex digits it signed", async () => {
    const sig = hmac(KEY, ORG);
    expect(sig.toUpperCase()).not.toBe(sig);
    for (const bad of [
      "",
      sig.slice(0, 63),
      `${sig}0`,
      sig.toUpperCase(),
      ` ${sig}`,
      `${sig} `,
      `${sig.slice(0, 63)}g`,
      "0".repeat(64),
    ]) {
      expect(await valid(ALL, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("never treats an empty value as a key", async () => {
    const empty = hmac("", ORG);
    expect(
      await valid({ ADMIN_SECRET: "", UNSUBSCRIBE_HMAC_KEY: "", UNSUBSCRIBE_HMAC_KEY_PREVIOUS: "" }, empty),
    ).toBe(false);
    expect(await valid({ UNSUBSCRIBE_HMAC_KEY: KEY, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: "" }, empty)).toBe(false);
    expect(await valid({}, hmac(KEY, ORG))).toBe(false);
  });
});

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** A D1 for the unsubscribe route that records which org it opts out. */
function optOutDb() {
  const optedOut: unknown[] = [];
  const db = {
    prepare: (sql: string) => {
      const stmt = {
        bind: (...args: unknown[]) => {
          if (/SET digest_opt_out = 1/.test(sql)) optedOut.push(args[0]);
          return stmt;
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, optedOut };
}

/**
 * Follows an unsubscribe link. A POST unless told otherwise: what the
 * page's button and a mail client's one-click unsubscribe send, and the
 * only method that opts out (engram#736).
 */
async function unsubscribe(url: string, s: Secrets, method: "GET" | "POST" = "POST") {
  const { db, optedOut } = optOutDb();
  const res = await app.fetch(new Request(url, { method }), { ...createMockEnv(db), ...s }, ctx);
  return { status: res.status, optedOut };
}

describe("/email/unsubscribe", () => {
  it("opts the org out on a POST to a link signed with the signing key or the key before it", async () => {
    for (const key of [KEY, PREVIOUS]) {
      expect(await unsubscribe(link(ORG, hmac(key, ORG)), ALL)).toEqual({ status: 200, optedOut: [ORG] });
    }
  });

  it("opts no one out on a GET, which only shows the page with the button (engram#736)", async () => {
    for (const key of [KEY, PREVIOUS]) {
      expect(await unsubscribe(link(ORG, hmac(key, ORG)), ALL, "GET")).toEqual({ status: 200, optedOut: [] });
    }
  });

  it("refuses a link signed with either bearer, and opts no one out", async () => {
    for (const method of ["GET", "POST"] as const) {
      for (const key of [ADMIN, INTERNAL]) {
        expect(await unsubscribe(link(ORG, hmac(key, ORG)), ALL, method)).toEqual({ status: 400, optedOut: [] });
      }
    }
  });
});

// ── every send to engram-web ─────────────────────────────────────────────

/** One org that every sender's query finds. */
const ROW = {
  id: ORG,
  name: "Ada",
  email: "ada@example.test",
  student_email: "ada@university.example.edu",
  student_expires_at: "2026-11-25 00:00:00",
  tier: "pro",
  grace_ends_at: "2026-11-01 00:00:00",
  saved: 3,
  days_old: 9,
  title: "A conversation",
  n: 0,
};

function oneOrgDb() {
  const sql: string[] = [];
  const db = {
    prepare: (q: string) => {
      sql.push(q);
      const stmt = {
        bind: () => stmt,
        all: async () => ({ results: [ROW], success: true, meta: {} }),
        first: async () => ROW,
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, sql };
}

function cronEnv(db: D1Database, s: Secrets): Env {
  return { DB: db, APP_URL, ...s } as unknown as Env;
}

const FEED_URL = "https://getengram.app/feed.xml";

interface Post {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** engram-web, and the blog feed the share nudge reads first. */
function web() {
  const posts: Post[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === FEED_URL) {
      return new Response(
        `<rss><channel><item><title>New post</title><link>https://getengram.app/blog/new</link>` +
          `<description>About it</description><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`,
      );
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    } catch {
      // not JSON: the assertions on posts say what was expected
    }
    posts.push({ url, auth: new Headers(init?.headers).get("authorization"), body });
    return new Response('{"sent":true}', { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { posts, fetchMock };
}

interface Sender {
  name: string;
  send: (env: Env) => Promise<number>;
  route: string;
  /** Carries an unsubscribe link, so it needs a signing key to go out at all. */
  signs: boolean;
}

const SENDERS: Sender[] = [
  { name: "weekly digest", send: sendWeeklyDigests, route: "/api/email/weekly-digest", signs: true },
  { name: "activation nudge", send: sendActivationNudges, route: "/api/email/activation-nudge", signs: true },
  { name: "import nudge", send: sendImportNudges, route: "/api/email/import-nudge", signs: true },
  { name: "maxout nudge", send: sendMaxoutNudges, route: "/api/email/maxout-nudge", signs: true },
  { name: "recall nudge", send: sendRecallNudges, route: "/api/email/recall-nudge", signs: true },
  { name: "student re-verify reminder", send: sendStudentReverifyReminders, route: "/api/email/student-reverify", signs: false },
  { name: "payment reminder", send: expireGracePeriods, route: "/api/email/payment-reminder", signs: false },
  { name: "share drafts", send: sendShareNudge, route: "/api/email/support-reply", signs: false },
];

describe("every cron send to engram-web", () => {
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(SENDERS)("$name shows INTERNAL_CRON_SECRET, never the admin secret or a key", async (sender) => {
    const { posts } = web();
    expect(await sender.send(cronEnv(oneOrgDb().db, ALL))).toBe(1);
    expect(posts.map((p) => [p.url, p.auth])).toEqual([[`${APP_URL}${sender.route}`, `Bearer ${INTERNAL}`]]);
    const wire = JSON.stringify(posts);
    for (const s of [ADMIN, KEY, PREVIOUS]) expect(wire).not.toContain(s);
    if (sender.signs) expect(posts[0].body.unsubscribe_url).toBe(link(ORG, hmac(KEY, ORG)));
    else expect(posts[0].body).not.toHaveProperty("unsubscribe_url");
    expect(errors).not.toHaveBeenCalled();
  });

  it.each(SENDERS.filter((s) => s.signs))(
    "$name: its unsubscribe link works, and keeps working through the next key change",
    async (sender) => {
      const { posts } = web();
      await sender.send(cronEnv(oneOrgDb().db, ALL));
      const url = String(posts[0].body.unsubscribe_url);
      expect((await unsubscribe(url, ALL)).status).toBe(200);
      const next = { ...ALL, UNSUBSCRIBE_HMAC_KEY: "next-key-456-test", UNSUBSCRIBE_HMAC_KEY_PREVIOUS: KEY };
      expect((await unsubscribe(url, next)).status).toBe(200);
      // Removing the previous key is what ends a mailed link, hence the 60-day wait.
      expect((await unsubscribe(url, { ...next, UNSUBSCRIBE_HMAC_KEY_PREVIOUS: undefined })).status).toBe(400);
    },
  );

  it.each(SENDERS)("$name sends as it did before when only ADMIN_SECRET is set", async (sender) => {
    const { posts } = web();
    expect(await sender.send(cronEnv(oneOrgDb().db, { ADMIN_SECRET: ADMIN }))).toBe(1);
    expect(posts.map((p) => p.auth)).toEqual([`Bearer ${ADMIN}`]);
    if (sender.signs) expect(posts[0].body.unsubscribe_url).toBe(link(ORG, hmac(ADMIN, ORG)));
  });

  it.each(SENDERS)("$name asks engram-web for nothing when no secret is set", async (sender) => {
    const { fetchMock } = web();
    await sender.send(cronEnv(oneOrgDb().db, { ADMIN_SECRET: "" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(SENDERS)("$name with only INTERNAL_CRON_SECRET: a signed link or no email", async (sender) => {
    const { posts } = web();
    await sender.send(cronEnv(oneOrgDb().db, { INTERNAL_CRON_SECRET: INTERNAL }));
    // Nothing to sign the unsubscribe link with: no lifecycle email goes out without one.
    if (sender.signs) expect(posts).toEqual([]);
    else expect(posts.map((p) => p.auth)).toEqual([`Bearer ${INTERNAL}`]);
  });

  it("still ends an expired grace period when there is no secret to send the reminder with", async () => {
    const { fetchMock } = web();
    const { db, sql } = oneOrgDb();
    expect(await expireGracePeriods(cronEnv(db, {}))).toBe(1);
    expect(sql.some((q) => /SET tier = 'free'/.test(q))).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("route sends to engram-web", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("student verification shows INTERNAL_CRON_SECRET", async () => {
    const { posts } = web();
    const owner: AuthContext = {
      organizationId: "org_test",
      apiKeyId: "key_owner",
      tier: "team",
      scopes: ["read", "write", "search", "delete"],
      seatId: null,
    };
    const a = new Hono<{ Bindings: Env; Variables: { auth: AuthContext } }>();
    a.use("*", async (c, next) => {
      c.set("auth", owner);
      await next();
    });
    a.route("/api/student", student);
    const res = await a.request(
      "/api/student/verify",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@university.edu" }),
      },
      { ...createMockEnv(createMockD1()), APP_URL, ...ALL },
    );
    expect(res.status).toBe(200);
    expect(posts.map((p) => [p.url, p.auth])).toEqual([
      [`${APP_URL}/api/email/student-verify`, `Bearer ${INTERNAL}`],
    ]);
  });

  it("the welcome email for a new connector user shows INTERNAL_CRON_SECRET", async () => {
    const { posts } = web();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = { ...createOAuthEnv(createOAuthD1()), ...ALL };
    const redirect = "https://chatgpt.com/connector/callback";
    const reg = await app.fetch(
      new Request("http://mcp.test/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirect] }),
      }),
      env,
    );
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };

    const pending: Array<Promise<unknown>> = [];
    const waiting = {
      waitUntil: (p: Promise<unknown>) => void pending.push(p),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
    const approve = await app.fetch(
      new Request("http://mcp.test/oauth/authorize/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          supabase_token: await signSupabaseJwt("newcomer@example.com"),
          client_id,
          redirect_uri: redirect,
          code_challenge: (await pkcePair()).challenge,
          scope: "engram:read engram:write",
          state: "xyz",
          approved: true,
        }),
      }),
      env,
      waiting,
    );
    expect(approve.status).toBe(200);
    await Promise.all(pending);
    expect(posts.map((p) => [p.url, p.auth])).toEqual([
      ["https://getengram.app/api/email/welcome", `Bearer ${INTERNAL}`],
    ]);
  });
});

// ── which code may read which secret ─────────────────────────────────────

const ROOT = join(__dirname, "..");

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!/node_modules|__tests__|dist/.test(name)) yield* sources(p);
      continue;
    }
    if (!/\.ts$/.test(name) || /\.test\.|\.d\.ts$/.test(name)) continue;
    yield p;
  }
}

/** A source file without its comment lines and trailing // comments. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ""))
    .join("\n");
}

const name = (path: string) => relative(ROOT, path).split(sep).join("/");

describe("which code reads which secret (engram#456)", () => {
  it("ADMIN_SECRET: the admin paths, and the stand-in in services/secrets.ts", () => {
    const reads: Record<string, number> = {};
    for (const path of sources(ROOT)) {
      const n = (code(path).match(/\.ADMIN_SECRET\b/g) ?? []).length;
      if (n) reads[name(path)] = n;
    }
    expect(
      reads,
      "ADMIN_SECRET is the owner's admin bearer and nothing else: a call to engram-web " +
        "takes websiteBearer(env), a lifecycle email lifecycleMail(env) (services/secrets.ts)",
    ).toEqual({
      "cron/drain-content.ts": 1, // its own /admin route, through SELF
      "index.ts": 1, // the /admin routes
      "middleware/auth.ts": 1, // admin API calls
      "services/secrets.ts": 2, // the stand-in until the new secrets are set
    });
  });

  it("the new secrets: services/secrets.ts only, where the stand-in rules live", () => {
    const readers = [...sources(ROOT)]
      .filter((path) => /\.(INTERNAL_CRON_SECRET|UNSUBSCRIBE_HMAC_KEY(_PREVIOUS)?)\b/.test(code(path)))
      .map(name);
    expect(readers).toEqual(["services/secrets.ts"]);
  });
});
