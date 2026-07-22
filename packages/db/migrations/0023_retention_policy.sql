-- Custom data retention (engram#289): per-org auto-purge policy for
-- Enterprise contracts. NULL (the default, and the only value self-serve
-- orgs ever have) means memory never expires. When set by admin, the
-- daily cron deletes conversations idle longer than this many days.
ALTER TABLE organizations ADD COLUMN retention_policy_days INTEGER;
