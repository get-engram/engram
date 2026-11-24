-- A campaign run can be scheduled to start by itself (engram#785).
--
-- campaign_runs (migration 0050) gains a fourth state, 'scheduled', and a
-- column, start_at: the time (ms since the epoch, like lease_until) at
-- which the cron that fires every two minutes turns a scheduled run into a
-- running one. start_at is set only while the state is 'scheduled'. At the
-- first tick at or after it the run starts, unless another campaign is
-- still running (then it waits for that one) or the campaign may not be
-- sent at that moment (then it stops, and note says why). /admin sets the
-- time and can cancel it.
--
-- SQLite cannot change a CHECK constraint in place, so the table is built
-- again under a new name with the wider check, the rows are copied, and
-- the new table takes the old one's name. Every other column, default and
-- the primary key are as in 0050. Nothing refers to this table and it has
-- no index of its own, so there is nothing else to carry over.
CREATE TABLE campaign_runs_new (
  campaign TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('scheduled', 'running', 'paused', 'done')),
  note TEXT,
  lease_until INTEGER,
  failed_ticks INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  start_at INTEGER
);

INSERT INTO campaign_runs_new
  (campaign, state, note, lease_until, failed_ticks, started_at, updated_at, finished_at)
SELECT campaign, state, note, lease_until, failed_ticks, started_at, updated_at, finished_at
FROM campaign_runs;

DROP TABLE campaign_runs;

ALTER TABLE campaign_runs_new RENAME TO campaign_runs;
