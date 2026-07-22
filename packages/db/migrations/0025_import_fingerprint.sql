-- Idempotent imports (engram#254): importers stamp conversations with a
-- stable fingerprint derived from the source export (e.g. chatgpt:<id>).
-- Re-importing the same export finds the existing conversation instead of
-- duplicating it.
ALTER TABLE conversations ADD COLUMN import_fingerprint TEXT;
CREATE INDEX IF NOT EXISTS idx_conversations_org_fingerprint
  ON conversations(organization_id, import_fingerprint);
