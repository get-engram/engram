import type { Env } from "../types.js";

/**
 * Nightly prune of the Stripe webhook idempotency ledger (engram#454).
 *
 * A row only has to outlive the window in which the same event id can come
 * back: Stripe retries a failed delivery for up to 3 days, and a replayed
 * signed body is only valid for 300 seconds. 30 days is comfortably past both.
 *
 * Same shape as prune-oauth-tokens: the LIMIT lives inside the statement so
 * nothing is bound (D1 caps a statement at 100 parameters), and a run is
 * bounded so a backlog drains over a few nights instead of in one unbounded
 * delete.
 */
export const STRIPE_EVENT_RETENTION_DAYS = 30;
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 20; // 10k rows/night; the ledger grows by a handful a day

export async function pruneStripeWebhookEvents(env: Env): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const r = await env.DB.prepare(
      `DELETE FROM stripe_webhook_events WHERE event_id IN (
         SELECT event_id FROM stripe_webhook_events
         WHERE received_at < datetime('now', '-${STRIPE_EVENT_RETENTION_DAYS} days')
         LIMIT ${BATCH}
       )`,
    ).run();
    const changes = r.meta?.changes ?? 0;
    total += changes;
    if (changes < BATCH) break;
  }
  return total;
}
