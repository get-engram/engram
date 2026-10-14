-- Message edit history (engram#490).
--
-- PATCH /api/v1/conversations/:id/messages/:messageId replaced a message's
-- body IN PLACE: same row, same R2 key, same sequence. The previous wording
-- was destroyed in both stores and could not be recovered by anyone.
--
-- That quietly contradicted the product's central claim. Engram's pitch is
-- that it stores what was actually said, verbatim, so you can tell it apart
-- from a model's later interpretation — and an edit silently erased the
-- "what was actually said" half. A doctoral student evaluating Engram for a
-- crisis-management decision-support system asked for exactly this
-- (provenance, revision identity, supersession) before we noticed it was
-- missing.
--
-- Every superseded body is kept. `revision` is 1 for the first body that was
-- replaced and counts up, so the current row plus N revisions is the full
-- chain. Bodies follow the same storage rule as messages: in R2 when it is
-- available (content = "", content_encoding = "r2:*"), inline in D1 otherwise.
--
-- Deletion: the FKs cascade the ROWS, but R2 objects are not cascaded by D1,
-- so every path that erases content (message delete, conversation delete,
-- org purge) must also delete revision objects by id. See
-- services/content-store.ts callers.
CREATE TABLE IF NOT EXISTS message_revisions (
  id               TEXT PRIMARY KEY,
  message_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  organization_id  TEXT NOT NULL,
  revision         INTEGER NOT NULL,
  content          TEXT NOT NULL,
  content_encoding TEXT,
  replaced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- Serves both the history read (ordered) and nextRevision().
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_revisions_msg_rev
  ON message_revisions(message_id, revision);
-- Drives R2 cleanup on conversation delete and org purge.
CREATE INDEX IF NOT EXISTS idx_message_revisions_conv
  ON message_revisions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_message_revisions_org
  ON message_revisions(organization_id);
