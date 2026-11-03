import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { Miniflare } from "miniflare";
import {
  claimStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
  STRIPE_EVENT_CLAIM_STALE_MINUTES,
} from "@getengram/db";
import { pruneStripeWebhookEvents } from "../cron/prune-stripe-events.js";
import type { Env } from "../types.js";

/**
 * The webhook idempotency ledger (engram#454) rests on one SQLite property:
 * an upsert's `changes` is 1 when the row was inserted or the DO UPDATE
 * applied, and 0 when the conflict's WHERE kept it from applying. The mock D1
 * in helpers.ts does not model DO UPDATE, so this file runs the real queries
 * against real SQLite through Miniflare's D1, with the real migration applied.
 */

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/db/migrations",
);

/** D1's exec() splits on newlines, so apply the file one statement at a time. */
async function applyMigration(db: D1Database, suffix: string): Promise<void> {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`no migration ending in ${suffix}`);
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

async function insertRow(
  db: D1Database,
  eventId: string,
  receivedOffset: string,
  processedOffset: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO stripe_webhook_events (event_id, event_type, received_at, processed_at)
       VALUES (?, 'test.event', datetime('now', ?), CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END)`,
    )
    .bind(eventId, receivedOffset, processedOffset, processedOffset)
    .run();
}

async function rowIds(db: D1Database): Promise<string[]> {
  const r = await db.prepare("SELECT event_id FROM stripe_webhook_events ORDER BY event_id").all<{ event_id: string }>();
  return r.results.map((row) => row.event_id);
}

describe("stripe_webhook_events ledger against real SQLite", () => {
  let mf: Miniflare;
  let db: D1Database;
  let env: Env;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "stripe-events-test" },
    });
    db = (await mf.getD1Database("DB")) as unknown as D1Database;
    env = { DB: db } as unknown as Env;
    await applyMigration(db, "_stripe_webhook_events.sql");
  }, 60_000);

  afterAll(async () => {
    await mf.dispose();
  });

  it("claims an id once; the same id again is a duplicate", async () => {
    expect(await claimStripeWebhookEvent(db, "evt_once", "checkout.session.completed")).toBe(true);
    expect(await claimStripeWebhookEvent(db, "evt_once", "checkout.session.completed")).toBe(false);
  });

  it("a processed id is final", async () => {
    expect(await claimStripeWebhookEvent(db, "evt_done", "customer.subscription.updated")).toBe(true);
    await markStripeWebhookEventProcessed(db, "evt_done");
    expect(await claimStripeWebhookEvent(db, "evt_done", "customer.subscription.updated")).toBe(false);
    // Releasing a processed row is a no-op: the id stays final.
    await releaseStripeWebhookEvent(db, "evt_done");
    expect(await claimStripeWebhookEvent(db, "evt_done", "customer.subscription.updated")).toBe(false);
  });

  it("a claim whose handler failed is released and can be claimed again", async () => {
    expect(await claimStripeWebhookEvent(db, "evt_retry", "customer.subscription.deleted")).toBe(true);
    await releaseStripeWebhookEvent(db, "evt_retry");
    expect(await claimStripeWebhookEvent(db, "evt_retry", "customer.subscription.deleted")).toBe(true);
    expect(await claimStripeWebhookEvent(db, "evt_retry", "customer.subscription.deleted")).toBe(false);
  });

  it("an unprocessed claim older than the stale window is re-claimable, a processed one is not", async () => {
    const stale = `-${STRIPE_EVENT_CLAIM_STALE_MINUTES + 1} minutes`;
    await insertRow(db, "evt_evicted", stale, null);
    await insertRow(db, "evt_old_done", stale, stale);
    // The earlier attempt died without releasing: take it over...
    expect(await claimStripeWebhookEvent(db, "evt_evicted", "test.event")).toBe(true);
    // ...and the take-over refreshed received_at, so a concurrent one loses.
    expect(await claimStripeWebhookEvent(db, "evt_evicted", "test.event")).toBe(false);
    // Age alone never reopens a finished event.
    expect(await claimStripeWebhookEvent(db, "evt_old_done", "test.event")).toBe(false);
  });

  it("an unprocessed claim inside the stale window is still owned by its first claimer", async () => {
    await insertRow(db, "evt_in_flight", "-1 minutes", null);
    expect(await claimStripeWebhookEvent(db, "evt_in_flight", "test.event")).toBe(false);
  });

  it("the nightly prune drops rows past retention and keeps the rest", async () => {
    await insertRow(db, "evt_ancient", "-31 days", "-31 days");
    await insertRow(db, "evt_ancient_unprocessed", "-31 days", null);
    const before = await rowIds(db);
    expect(before).toContain("evt_ancient");
    const n = await pruneStripeWebhookEvents(env);
    expect(n).toBe(2);
    const after = await rowIds(db);
    expect(after).not.toContain("evt_ancient");
    expect(after).not.toContain("evt_ancient_unprocessed");
    expect(after).toEqual(before.filter((id) => !id.startsWith("evt_ancient")));
  });
});
