-- Lifetime message storage counter (engram#275): the free tier is gated on
-- total stored memory (Gmail model — memory fills up, nothing ever expires),
-- not monthly velocity. Maintained atomically on append, decremented when a
-- conversation is deleted.
ALTER TABLE organizations ADD COLUMN messages_stored_total INTEGER NOT NULL DEFAULT 0;

-- Backfill from live message counts (idx_messages_org makes this a per-org
-- index scan, not a table scan).
UPDATE organizations SET messages_stored_total = (
  SELECT COUNT(*) FROM messages WHERE messages.organization_id = organizations.id
);
