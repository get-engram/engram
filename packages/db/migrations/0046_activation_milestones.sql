-- Per-organization activation milestones (engram#555).
--
-- The admin activation funnel and the recall nudge answered "has this org
-- EVER searched / had a search return a hit / been active on two dates /
-- come back a week after signing up" by probing audit_log. audit_log is held
-- to a 90-day retention floor (cron/audit-retention.ts), so once retention
-- starts deleting, those answers forget: the funnel shrinks and the recall
-- nudge emails people who already saw recall work.
--
-- Each column is the created_at of the audit_log row that first proved the
-- milestone. services/activation-milestones.ts stamps them at the start of
-- every retention pass, before anything is deleted, and never overwrites a
-- stamp. NULL means not reached, or reached since the last pass; the readers
-- OR in the live audit_log probe for that case. ADD COLUMN only rewrites the
-- schema, not the rows, so this is instant on organizations.
ALTER TABLE organizations ADD COLUMN first_activity_at TEXT;
ALTER TABLE organizations ADD COLUMN first_search_at TEXT;
ALTER TABLE organizations ADD COLUMN first_recall_at TEXT;
ALTER TABLE organizations ADD COLUMN second_session_at TEXT;
ALTER TABLE organizations ADD COLUMN returned_7d_at TEXT;
