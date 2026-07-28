-- Churn visibility: distinguish "never paid" from "paid and left".
-- cancel_at_period_end mirrors Stripe (they cancelled but keep paid access
-- until the period ends); churned_at is stamped when a paying org is
-- actually downgraded to free. Cleared again if they resubscribe.
ALTER TABLE organizations ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organizations ADD COLUMN churned_at TEXT;
