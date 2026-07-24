-- Maxout nudge: one upgrade email per free org that hits the 10,000-message
-- storage ceiling (the free tier's storage_messages cap). Stamped with the
-- send time so the daily cron never emails the same org twice, and so we can
-- later measure how many nudged orgs converted to Pro.
ALTER TABLE organizations ADD COLUMN maxout_nudged_at TEXT;
