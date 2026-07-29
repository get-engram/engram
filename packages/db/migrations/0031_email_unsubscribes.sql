-- Unsubscribe observability (engram: admin email section).
-- organizations.digest_opt_out already gates lifecycle sends; this adds
-- WHEN it happened, and stamps the email that likely triggered it (the
-- most recent send to that org at click time) so the admin dashboard can
-- show per-type unsubscribe counts next to open rates.
ALTER TABLE email_log ADD COLUMN unsubscribed_at TEXT;
ALTER TABLE organizations ADD COLUMN digest_opt_out_at TEXT;
