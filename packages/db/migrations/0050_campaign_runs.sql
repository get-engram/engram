-- Campaign email the worker sends by itself (engram#773).
--
-- One row per campaign. While state is 'running', the cron that fires
-- every two minutes sends the next batch (at most 50) through that
-- campaign's sender, which claims each address in campaign_sends before
-- sending it, exactly as a send started by hand does. A run ends itself:
-- 'done' once nobody is owed the email or the offer has ended, 'paused'
-- when sending keeps failing (note says why). /admin starts and pauses it.
--
-- lease_until (ms since the epoch) is held by the tick that is sending. A
-- slow batch and the next tick never send at the same time: engram-web
-- sends one email at a time over SMTP, and two senders at once would run
-- into the mail provider's rate limit, where a refused email is not retried.
--
-- failed_ticks counts ticks in a row whose batch threw (D1 overloaded, say).
-- The next tick tries again; the third in a row pauses the run.
CREATE TABLE campaign_runs (
  campaign TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('running', 'paused', 'done')),
  note TEXT,
  lease_until INTEGER,
  failed_ticks INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
