/**
 * Stripe webhook idempotency ledger (engram#454, migration 0043).
 *
 * Stripe delivers an event more than once: it retries after any non-2xx, and
 * a delivery's signature stays valid for 300 seconds, so anyone holding one
 * signed body (a log sink, a proxy) can replay it. The handlers in
 * routes/billing.ts are written to be idempotent, but that is a property every
 * future branch would have to preserve by hand. This ledger makes the endpoint
 * idempotent on its own: an event id is CLAIMED before it is processed, and a
 * second delivery of the same id is acknowledged without running anything.
 *
 * The claim is one statement, so two concurrent deliveries cannot both win:
 *
 *   no row                                   -> inserted, claimed
 *   row, processed                           -> duplicate
 *   row, unprocessed, younger than the stale
 *     window                                 -> in flight elsewhere, duplicate
 *   row, unprocessed, older than the window  -> the earlier attempt died
 *     without releasing (an evicted isolate); re-claimed
 *
 * A handler that throws releases its claim so Stripe's retry is processed; one
 * that succeeds stamps processed_at, after which the id is final.
 */

/**
 * Longer than any handler can run: a worker request is bounded well under a
 * minute, and the handlers here are a few D1 statements.
 */
export const STRIPE_EVENT_CLAIM_STALE_MINUTES = 5;

/** True when this call won the id and must process the event. */
export async function claimStripeWebhookEvent(
  db: D1Database,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO stripe_webhook_events (event_id, event_type, received_at, processed_at)
       VALUES (?, ?, datetime('now'), NULL)
       ON CONFLICT(event_id) DO UPDATE SET received_at = excluded.received_at
         WHERE processed_at IS NULL
           AND received_at < datetime('now', '-${STRIPE_EVENT_CLAIM_STALE_MINUTES} minutes')`,
    )
    .bind(eventId, eventType)
    .run();
  // SQLite counts an upsert's row only when it was inserted or the DO UPDATE
  // actually applied, so changes = 1 is exactly "claimed".
  return (r.meta?.changes ?? 0) === 1;
}

/** The event ran to completion: the id is final and is never processed again. */
export async function markStripeWebhookEventProcessed(
  db: D1Database,
  eventId: string,
): Promise<void> {
  await db
    .prepare("UPDATE stripe_webhook_events SET processed_at = datetime('now') WHERE event_id = ?")
    .bind(eventId)
    .run();
}

/**
 * Give an id back after its handler failed, so the retry Stripe sends for the
 * non-2xx is processed instead of dropped as a duplicate. A processed row is
 * final and is never released.
 */
export async function releaseStripeWebhookEvent(
  db: D1Database,
  eventId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM stripe_webhook_events WHERE event_id = ? AND processed_at IS NULL")
    .bind(eventId)
    .run();
}
