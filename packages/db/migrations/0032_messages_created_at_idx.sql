-- The daily ops report filters messages by created_at four ways (24h
-- counts, active orgs, 7-day top-org join). With no index those are full
-- scans — fine at thousands of rows, fatal at 3.2M: D1 kills the worker
-- mid-report and the 13:00 cron dies silently (first observed 2026-07-31).
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
