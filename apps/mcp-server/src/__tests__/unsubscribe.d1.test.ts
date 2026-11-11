import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import app from "../index.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * The unsubscribe link in lifecycle email (engram#736), against real SQLite
 * with the real migrations.
 *
 * Mail security gateways fetch every link in a message to check it. While a
 * GET of the link did the opt-out, that fetch alone unsubscribed people who
 * never saw the email, and the unsubscribe counts counted the scanners. Now
 * GET only shows a page with one button, and a POST to the same URL does the
 * opt-out: the button, and a mail client's RFC 8058 one-click unsubscribe.
 */

const KEY = "unsubscribe-key-736-test";
const ORG = "org_736";
const OTHER = "org_736_other";

const sig = (org: string, key = KEY) => createHmac("sha256", key).update(`digest:${org}`).digest("hex");
const BASE = "https://mcp.example.test/email/unsubscribe";
const link = (org: string, s = sig(org)) => `${BASE}?org=${encodeURIComponent(org)}&sig=${s}`;

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** Both orgs subscribed, nothing credited with an unsubscribe. */
const UNTOUCHED = { out: 0, at: null, otherOut: 0, credited: [] };

describe("/email/unsubscribe (engram#736), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "unsubscribe" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  /** Two subscribed orgs: two emails sent to ORG, and a later one to OTHER. */
  async function reset() {
    const sent = "INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES (?, ?, 'someone@example.test', ?, ?)";
    await db.batch([
      db.prepare("DELETE FROM email_log"),
      db.prepare("DELETE FROM organizations"),
      db.prepare("INSERT INTO organizations (id, name) VALUES (?, 'Org'), (?, 'Other')").bind(ORG, OTHER),
      db.prepare(sent).bind("e_old", ORG, "weekly-digest", "2026-11-01 09:00:00"),
      db.prepare(sent).bind("e_new", ORG, "recall-nudge", "2026-11-08 09:00:00"),
      db.prepare(sent).bind("e_other", OTHER, "weekly-digest", "2026-11-09 09:00:00"),
    ]);
  }

  beforeEach(reset);

  async function send(url: string, init?: RequestInit) {
    const env = { ...createMockEnv(db), UNSUBSCRIBE_HMAC_KEY: KEY } as unknown as Env;
    const res = await app.fetch(new Request(url, init), env, ctx);
    return {
      status: res.status,
      location: res.headers.get("Location"),
      type: res.headers.get("Content-Type") ?? "",
      body: await res.text(),
    };
  }

  async function state() {
    const flag = "SELECT digest_opt_out AS out, digest_opt_out_at AS at FROM organizations WHERE id = ?";
    const org = await db.prepare(flag).bind(ORG).first<{ out: number; at: string | null }>();
    const other = await db.prepare(flag).bind(OTHER).first<{ out: number }>();
    const { results } = await db
      .prepare("SELECT id FROM email_log WHERE unsubscribed_at IS NOT NULL ORDER BY id")
      .all<{ id: string }>();
    return { out: org!.out, at: org!.at, otherOut: other!.out, credited: results.map((r) => r.id) };
  }

  it("shows a page with one Unsubscribe button on a GET, and changes nothing", async () => {
    // A mail gateway may check the link more than once.
    for (let i = 0; i < 3; i++) {
      const page = await send(link(ORG));
      expect(page.status).toBe(200);
      expect(page.type).toMatch(/^text\/html/);
      expect(page.body).toContain("Unsubscribe from Engram emails?");
      // The form has no action, so it posts back to this same URL, signature and all.
      expect(page.body).toContain('<form method="post"><button type="submit"');
      expect(page.body).not.toContain("action=");
      // It says what the opt-out stops: the digest and the reminder emails.
      expect(page.body).toContain("the weekly digest and our reminder emails");
    }
    expect(await state()).toEqual(UNTOUCHED);
  });

  it("changes nothing on a HEAD", async () => {
    const res = await send(link(ORG), { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.body).toBe("");
    expect(await state()).toEqual(UNTOUCHED);
  });

  it("opts the org out on a POST, and credits the latest email sent to that org", async () => {
    const done = await send(link(ORG), { method: "POST" });
    expect(done.status).toBe(200);
    expect(done.location).toBeNull();
    expect(done.type).toMatch(/^text\/html/);
    expect(done.body).toContain("You're unsubscribed");
    expect(done.body).toContain("No more weekly digest or reminder emails.");
    expect(done.body).not.toContain("<form");
    const after = await state();
    expect(after).toMatchObject({ out: 1, otherOut: 0, credited: ["e_new"] });
    expect(after.at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  it("changes nothing on a second POST, even after a later email", async () => {
    await send(link(ORG), { method: "POST" });
    // Pin the opt-out time, so a rewrite of it shows.
    await db.prepare("UPDATE organizations SET digest_opt_out_at = '2026-11-08 12:00:00' WHERE id = ?").bind(ORG).run();
    // An email the opt-out doesn't stop (a billing notice, say), sent after it.
    await db
      .prepare("INSERT INTO email_log (id, org_id, recipient, type, sent_at) VALUES ('e_later', ?, 'someone@example.test', 'plan-changed', '2026-11-10 09:00:00')")
      .bind(ORG)
      .run();
    // The button again, or a mail client retrying its one-click POST.
    const again = await send(link(ORG), { method: "POST" });
    expect(again.status).toBe(200);
    expect(again.body).toContain("You're unsubscribed");
    expect(await state()).toEqual({ out: 1, at: "2026-11-08 12:00:00", otherOut: 0, credited: ["e_new"] });
  });

  it("takes a mail client's RFC 8058 one-click POST, form-encoded or multipart, with a 200 and no redirect", async () => {
    const multipart = new FormData();
    multipart.set("List-Unsubscribe", "One-Click");
    for (const body of [new URLSearchParams({ "List-Unsubscribe": "One-Click" }), multipart]) {
      await reset();
      const res = await send(link(ORG), { method: "POST", body });
      expect(res.status).toBe(200);
      expect(res.location).toBeNull();
      expect(await state()).toMatchObject({ out: 1, otherOut: 0, credited: ["e_new"] });
    }
  });

  it("says the org is unsubscribed on a GET after the opt-out, with no button", async () => {
    await send(link(ORG), { method: "POST" });
    const page = await send(link(ORG));
    expect(page.status).toBe(200);
    expect(page.body).toContain("You're unsubscribed");
    expect(page.body).not.toContain("<form");
  });

  it("refuses a link not signed for its org, on a GET or a POST, and changes nothing", async () => {
    const refused = [
      link(ORG, sig(ORG, "some-other-key")),
      link(ORG, sig(OTHER)),
      link(ORG, "0".repeat(64)),
      `${BASE}?org=${ORG}`,
      `${BASE}?sig=${sig(ORG)}`,
      BASE,
    ];
    for (const url of refused) {
      for (const method of ["GET", "POST"]) {
        const res = await send(url, { method });
        expect(res.status, `${method} ${url}`).toBe(400);
        expect(res.body).toBe("Invalid link.");
      }
    }
    expect(await state()).toEqual(UNTOUCHED);
  });
});
