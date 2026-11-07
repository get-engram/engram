import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { sendDailyReport, REPORT_ATTEMPT_DELAYS_MS } from "../services/daily-report.js";
import { admin } from "../routes/admin.js";
import type { Env } from "../types.js";

/**
 * Three daily reports in a row never arrived, and nothing said why: the
 * cron made one attempt, logged the failure to the worker console, which is
 * not kept, and moved on (engram#569). Delivery now retries over a few
 * minutes, and when every attempt fails it emails a short failure notice,
 * so a missing report shows up as an email that names the error.
 */

const APP_URL = "https://app.example.test";
const SECRET = "admin-secret-never-in-a-notice";
const PROBE = "SELECT id FROM organizations LIMIT 1";

/** A D1 stand-in whose first `failBuilds` reports fail at the probe. */
function reportDb(failBuilds = 0, message = "D1_ERROR: Requests queued for too long") {
  let builds = 0;
  const stmt = {
    bind: () => stmt,
    first: async () => ({ n: 0, id: "org_x" }),
    all: async () => ({ results: [] }),
  };
  return {
    prepare: (sql: string) => {
      if (sql === PROBE && ++builds <= failBuilds) throw new Error(message);
      return stmt;
    },
  } as unknown as D1Database;
}

// No STRIPE_SECRET_KEY: revenue is "unavailable" and the only fetches made
// are the deliveries to engram-web.
function env(db: D1Database): Env {
  return { DB: db, APP_URL, ADMIN_SECRET: SECRET } as unknown as Env;
}

interface Post {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/** engram-web: answers each POST with the next status; "throw" never connects. */
function webApp(...statuses: Array<number | "throw">) {
  const posts: Post[] = [];
  let i = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    posts.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    const status = statuses[Math.min(i++, statuses.length - 1)];
    if (status === "throw") throw new Error("connect timeout");
    return new Response(status === 200 ? '{"sent":true}' : "refused", { status });
  });
  vi.stubGlobal("fetch", fetch);
  return posts;
}

function sleeper() {
  return vi.fn(async (_ms: number) => {});
}

const isReport = (p: Post) => "totals" in p.body && !("failure" in p.body);
const isNotice = (p: Post) => "failure" in p.body;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendDailyReport — delivery", () => {
  it("delivers on the first attempt without waiting", async () => {
    const posts = webApp(200);
    const sleep = sleeper();
    await sendDailyReport(env(reportDb()), { sleep });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe(`${APP_URL}/api/reports/daily`);
    expect(posts[0].auth).toBe(`Bearer ${SECRET}`);
    expect(isReport(posts[0])).toBe(true);
    expect(posts[0].body).toMatchObject({ revenue: null, paying_source: "database" });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a report that failed to build, and sends it once", async () => {
    const posts = webApp(200);
    const sleep = sleeper();
    await sendDailyReport(env(reportDb(1)), { sleep });
    expect(posts).toHaveLength(1);
    expect(isReport(posts[0])).toBe(true);
    expect(sleep.mock.calls).toEqual([[60_000]]);
  });

  it("retries a delivery that failed with a 5xx", async () => {
    const posts = webApp(503, 200);
    await sendDailyReport(env(reportDb()), { sleep: sleeper() });
    expect(posts.map(isReport)).toEqual([true, true]);
  });

  it("retries a delivery that never connected", async () => {
    const posts = webApp("throw", 200);
    await sendDailyReport(env(reportDb()), { sleep: sleeper() });
    expect(posts.map(isReport)).toEqual([true, true]);
  });

  it("spreads its attempts over minutes, well inside a cron run's 15-minute limit", () => {
    expect(REPORT_ATTEMPT_DELAYS_MS[0]).toBe(0);
    expect(REPORT_ATTEMPT_DELAYS_MS.length).toBeGreaterThanOrEqual(3);
    expect(REPORT_ATTEMPT_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * 60_000);
  });
});

describe("sendDailyReport — when every attempt fails", () => {
  it("emails a failure notice that names each error, then throws", async () => {
    const posts = webApp(200);
    const sleep = sleeper();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendDailyReport(env(reportDb(99)), { sleep })).rejects.toThrow(
      /failed after 3 attempt\(s\): building the report: D1_ERROR/,
    );
    expect(sleep.mock.calls).toEqual([[60_000], [180_000]]);
    expect(posts).toHaveLength(1);
    expect(isNotice(posts[0])).toBe(true);
    expect(posts[0].auth).toBe(`Bearer ${SECRET}`);
    expect(posts[0].body).toEqual({
      generated_at: expect.any(String),
      failure: {
        attempts: 3,
        errors: Array(3).fill("building the report: D1_ERROR: Requests queued for too long"),
      },
    });
  });

  it("does not retry a refusal, and says so in the notice", async () => {
    // A 401 (wrong ADMIN_SECRET) or 400 (malformed report) is the same
    // answer every time: one report attempt, then the notice.
    const posts = webApp(401);
    const sleep = sleeper();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(sendDailyReport(env(reportDb()), { sleep })).rejects.toThrow(/401/);
    expect(posts.map((p) => (isNotice(p) ? "notice" : "report"))).toEqual(["report", "notice"]);
    expect(sleep).not.toHaveBeenCalled();
    expect(posts[1].body.failure).toEqual({ attempts: 1, errors: ["delivery failed: 401 refused"] });
    expect(JSON.stringify(posts[1].body)).not.toContain(SECRET);
  });

  it("keeps each error in the notice short", async () => {
    const posts = webApp(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendDailyReport(env(reportDb(99, `D1_ERROR: ${"x".repeat(5000)}`)), { sleep: sleeper() }),
    ).rejects.toThrow();
    const errors = (posts[0].body.failure as { errors: string[] }).errors;
    expect(errors).toHaveLength(3);
    for (const e of errors) expect(e.length).toBeLessThanOrEqual(300);
  });

  it("still throws when the notice cannot be delivered either", async () => {
    const posts = webApp(500);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m: string) => void errors.push(m));
    await expect(sendDailyReport(env(reportDb(99)), { sleep: sleeper() })).rejects.toThrow(
      /failed after 3 attempt/,
    );
    expect(posts).toHaveLength(1);
    expect(errors.some((m) => /the failure notice failed too/.test(m))).toBe(true);
  });

  it("sends no notice when asked not to", async () => {
    const posts = webApp(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      sendDailyReport(env(reportDb(99)), { delays: [0], notifyOnFailure: false }),
    ).rejects.toThrow(/failed after 1 attempt/);
    expect(posts).toHaveLength(0);
  });
});

describe("POST /admin/daily-report/send", () => {
  function route() {
    const app = new Hono<{ Bindings: Env }>();
    app.route("/admin", admin);
    return app;
  }

  it("sends the report", async () => {
    const posts = webApp(200);
    const res = await route().request("/admin/daily-report/send", { method: "POST" }, env(reportDb()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(posts.map(isReport)).toEqual([true]);
  });

  it("makes one attempt and answers with the error, with no failure email", async () => {
    // The cron's retries wait minutes; an HTTP caller reads the error instead.
    const posts = webApp(200);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await route().request("/admin/daily-report/send", { method: "POST" }, env(reportDb(1)));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { sent: boolean; error: string };
    expect(body.sent).toBe(false);
    expect(body.error).toMatch(/building the report: D1_ERROR/);
    expect(posts).toHaveLength(0);
  });
});
