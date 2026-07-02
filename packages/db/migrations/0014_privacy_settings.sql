-- Privacy & sharing settings per organization (engram-web#19).
--
-- Both default to 1 (ON) so existing behavior is unchanged — assistants
-- consuming Engram over MCP keep full access until an org opts out.
--   assistant_can_read_bodies:            0 => tools return message/chunk
--                                         metadata only, never verbatim content.
--   assistant_can_read_cross_conversation: 0 => tools that aggregate across
--                                         conversations (list_conversations,
--                                         global search) are disabled; the
--                                         assistant only sees a conversation
--                                         it was given the id for.
ALTER TABLE organizations
  ADD COLUMN assistant_can_read_bodies INTEGER NOT NULL DEFAULT 1;

ALTER TABLE organizations
  ADD COLUMN assistant_can_read_cross_conversation INTEGER NOT NULL DEFAULT 1;
