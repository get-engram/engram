-- Soft-delete support for GDPR 30-day grace period.
-- When a user requests account deletion, we set deleted_at instead of
-- hard-deleting. A daily cron purges orgs where deleted_at > 30 days.
ALTER TABLE organizations ADD COLUMN deleted_at TEXT;
