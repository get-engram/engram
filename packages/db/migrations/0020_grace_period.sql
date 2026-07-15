-- Grace period for manually-granted Pro access.
-- When set, the daily cron downgrades the org to free after this date
-- if they haven't added a Stripe subscription.
ALTER TABLE organizations ADD COLUMN grace_ends_at TEXT;
