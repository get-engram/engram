-- Shared vs private memory spaces (engram#264): conversations remember
-- which seat created them and whether they're team-shared (default,
-- today's behavior) or private to that seat.
ALTER TABLE conversations ADD COLUMN seat_id TEXT;
ALTER TABLE conversations ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared';
CREATE INDEX IF NOT EXISTS idx_conversations_org_visibility
  ON conversations(organization_id, visibility);
