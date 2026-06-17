-- Track how many seats an org has paid for via Stripe subscription quantity.
-- Free/Pro default to 1; Team orgs get this set from the webhook.
ALTER TABLE organizations ADD COLUMN seat_limit INTEGER NOT NULL DEFAULT 1;
