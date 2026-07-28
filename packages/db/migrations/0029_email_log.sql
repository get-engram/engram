-- Email observability: one row per transactional email sent by engram-web's
-- sendEmail() (welcome, nudges, digests, reports, invites...). opened_at is
-- stamped by the tracking pixel (GET /email/open?id=) — approximate by
-- nature: image-blocking clients undercount, Apple MPP prefetch overcounts.
CREATE TABLE email_log (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  recipient TEXT NOT NULL,
  type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  opened_at TEXT
);

CREATE INDEX idx_email_log_type ON email_log (type, sent_at);
CREATE INDEX idx_email_log_sent ON email_log (sent_at);
