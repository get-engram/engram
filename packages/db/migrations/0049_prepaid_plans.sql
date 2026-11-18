-- Plans paid for once, for a fixed time (engram#763: Black Friday 2026, one
-- year of Pro for one payment, no renewal).
--
-- One row per paid Stripe Checkout Session. The session id is the primary
-- key and the row is written before the plan is granted, so Stripe
-- delivering the same payment twice grants one year, not two, and the end
-- date does not move.
--
-- While ends_at is in the future the org's tier is held by
-- organizations.grace_ends_at, the same field an admin grant uses. When it
-- passes, the grace cron puts the org back on Free; a row here is how it
-- knows the org paid for its time and writes to them accordingly.
CREATE TABLE prepaid_plans (
  session_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  offer TEXT NOT NULL,
  tier TEXT NOT NULL,
  amount_total INTEGER,
  currency TEXT,
  paid_at TEXT NOT NULL DEFAULT (datetime('now')),
  ends_at TEXT NOT NULL
);

CREATE INDEX idx_prepaid_plans_org ON prepaid_plans (org_id);
