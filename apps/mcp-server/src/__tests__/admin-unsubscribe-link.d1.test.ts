import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import app from "../index.js";
import { admin } from "../routes/admin.js";
import { lifecycleMail } from "../services/secrets.js";
import { applyAllMigrations } from "./miniflare.js";
import { createMockEnv } from "./helpers.js";
import type { Env } from "../types.js";

/**
 * GET /admin/unsubscribe-link (engram#735): an org's signed unsubscribe link
 * for an email sent outside the crons, so no one signs one by hand. After
 * the engram#456 rollout the signing key lives only in the worker, and a
 * link signed by hand with ADMIN_SECRET answers "Invalid link." once that
 * is rotated.
 *
 * The real app (so the admin bearer check is the real one), real SQLite
 * with the real migrations, and the real unsubscribe route at the end.
 */

const ADMIN = "admin-secret-735-test";
const INTERNAL = "internal-secret-735-test";
const KEY = "unsubscribe-key-735-test";
const PREVIOUS = "previous-key-735-test";

type Secrets = Partial<
  Record<"ADMIN_SECRET" | "INTERNAL_CRON_SECRET" | "UNSUBSCRIBE_HMAC_KEY" | "UNSUBSCRIBE_HMAC_KEY_PREVIOUS", string>
>;

const ALL: Secrets = {
  ADMIN_SECRET: ADMIN,
  INTERNAL_CRON_SECRET: INTERNAL,
  UNSUBSCRIBE_HMAC_KEY: KEY,
  UNSUBSCRIBE_HMAC_KEY_PREVIOUS: PREVIOUS,
};

const LIVE = "org_735_live";
const OUT = "org_735_out";
const GONE = "org_735_gone";

const hmac = (key: string, org: string) => createHmac("sha256", key).update(`digest:${org}`).digest("hex");

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

describe("GET /admin/unsubscribe-link (engram#735), against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "unsubscribe-link" },
    });
    db = await mf.getD1Database("DB");
    await applyAllMigrations(db);
    await db.batch([
      db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(LIVE, "Live"),
      db.prepare("INSERT INTO organizations (id, name, digest_opt_out) VALUES (?, ?, 1)").bind(OUT, "Out"),
      db.prepare("INSERT INTO organizations (id, name, deleted_at) VALUES (?, ?, datetime('now'))").bind(GONE, "Gone"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  function env(s: Secrets): Env {
    return { ...createMockEnv(db), ...s } as unknown as Env;
  }

  async function get(query: string, s: Secrets = ALL, bearer: string | null = s.ADMIN_SECRET ?? null) {
    const headers = bearer === null ? undefined : { Authorization: `Bearer ${bearer}` };
    const res = await app.fetch(
      new Request(`https://mcp.example.test/admin/unsubscribe-link${query}`, { headers }),
      env(s),
      ctx,
    );
    return { status: res.status, cache: res.headers.get("Cache-Control"), body: (await res.json()) as Record<string, unknown> };
  }

  async function optedOut(org: string): Promise<number> {
    const row = await db.prepare("SELECT digest_opt_out FROM organizations WHERE id = ?").bind(org).first<{ digest_opt_out: number }>();
    return row!.digest_opt_out;
  }

  it("returns the link the crons mail the org, and the link opts the org out", async () => {
    const res = await get(`?org=${LIVE}`);
    expect(res.status).toBe(200);
    expect(res.cache).toBe("no-store");
    expect(res.body).toEqual({
      org_id: LIVE,
      url: await lifecycleMail(env(ALL))!.unsubscribeUrl(LIVE),
      opted_out: false,
    });

    expect(await optedOut(LIVE)).toBe(0);
    const unsubscribed = await app.fetch(new Request(String(res.body.url)), env(ALL), ctx);
    expect(unsubscribed.status).toBe(200);
    expect(await optedOut(LIVE)).toBe(1);
    await db.prepare("UPDATE organizations SET digest_opt_out = 0, digest_opt_out_at = NULL WHERE id = ?").bind(LIVE).run();
  });

  it("signs with UNSUBSCRIBE_HMAC_KEY once that is set, never with ADMIN_SECRET", async () => {
    const sig = (url: unknown) => new URL(String(url)).searchParams.get("sig");
    expect(sig((await get(`?org=${LIVE}`)).body.url)).toBe(hmac(KEY, LIVE));
    // Before the rollout ADMIN_SECRET is the signing key, for these links and the crons' alike.
    expect(sig((await get(`?org=${LIVE}`, { ADMIN_SECRET: ADMIN })).body.url)).toBe(hmac(ADMIN, LIVE));
  });

  it("makes a link that still works after ADMIN_SECRET is rotated", async () => {
    const url = String((await get(`?org=${LIVE}`)).body.url);
    const rotated = { ...ALL, ADMIN_SECRET: "rotated-admin-735-test" };
    const res = await app.fetch(new Request(url), env(rotated), ctx);
    expect(res.status).toBe(200);
    expect(await optedOut(LIVE)).toBe(1);
    await db.prepare("UPDATE organizations SET digest_opt_out = 0, digest_opt_out_at = NULL WHERE id = ?").bind(LIVE).run();
  });

  it("says when the org already unsubscribed", async () => {
    const res = await get(`?org=${OUT}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ org_id: OUT, opted_out: true });
  });

  it("gives no link for an org that doesn't exist or is deleted", async () => {
    expect(await get("?org=org_735_nobody")).toEqual({
      status: 404,
      cache: "no-store",
      body: { error: "not_found", message: "No such organization." },
    });
    const deleted = await get(`?org=${GONE}`);
    expect(deleted.status).toBe(404);
    expect(deleted.body).toMatchObject({ error: "deleted" });
    expect(deleted.body).not.toHaveProperty("url");
  });

  it("asks for the org when there is none", async () => {
    for (const query of ["", "?org=", "?organization=org_735_live"]) {
      const res = await get(query);
      expect(res.status, query).toBe(400);
      expect(res.body, query).toMatchObject({ error: "missing_org" });
    }
  });

  it("answers only the admin bearer", async () => {
    for (const bearer of [null, "", INTERNAL, KEY, PREVIOUS, `${ADMIN}x`]) {
      const res = await get(`?org=${LIVE}`, ALL, bearer);
      expect(res.status, String(bearer)).toBe(401);
      expect(res.body, String(bearer)).not.toHaveProperty("url");
    }
  });

  it("says so when no key to sign links is set", async () => {
    // Through the app the admin bearer is ADMIN_SECRET, which stands in as the
    // signing key until UNSUBSCRIBE_HMAC_KEY is set, so this needs the router alone.
    const router = new Hono<{ Bindings: Env }>().route("/admin", admin);
    const res = await router.fetch(new Request(`https://mcp.example.test/admin/unsubscribe-link?org=${LIVE}`), env({}), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "no_signing_key", message: "No key to sign unsubscribe links is set." });
  });
});
