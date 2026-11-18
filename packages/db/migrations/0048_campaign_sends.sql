-- One-off campaign emails (engram#763: Black Friday 2026).
--
-- A campaign email goes to an address at most once. The row is written
-- BEFORE the send and is the claim: a second batch, a retry, or two orgs
-- that share an address all meet the primary key and skip. email_log cannot
-- do this job, because engram-web writes it after the send and without
-- waiting for the answer.
--
-- status: 'claimed' while the send is in flight, 'sent' once engram-web
-- confirmed it, 'unknown' when the request died without an answer (the
-- email may or may not have gone, so it is not retried).
CREATE TABLE campaign_sends (
  campaign TEXT NOT NULL,
  email TEXT NOT NULL,
  org_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (campaign, email)
);
