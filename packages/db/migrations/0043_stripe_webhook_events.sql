-- Stripe webhook idempotency ledger (engram#454).
--
-- Stripe delivers an event more than once (retries after a non-2xx, and
-- occasionally plain duplicates), and a delivery's signature stays valid for
-- 300 seconds, so anyone holding one signed body can replay it. The webhook
-- records every event id it accepts and acknowledges a repeat without running
-- the handler again.
--
-- A row is claimed BEFORE the event is processed, so two concurrent
-- deliveries cannot both run, and stamped processed_at afterwards. A claim
-- whose handler threw is released so Stripe's retry is processed; one that
-- never finished (the isolate was evicted mid-flight) becomes re-claimable
-- once it is older than any handler can run. Rows are pruned nightly after
-- 30 days, well past Stripe's 3-day retry horizon.
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_received_at
  ON stripe_webhook_events(received_at);
