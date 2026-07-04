-- Denormalize conversation count onto organizations (engram#41).
--
-- create_conversation's tier check ran COUNT(*) over the whole conversations
-- table on every call — O(n) per org. This column is maintained incrementally
-- (insertConversation +1, deleteConversationById -1) so the check is O(1).
ALTER TABLE organizations
  ADD COLUMN conversation_count INTEGER NOT NULL DEFAULT 0;

-- Backfill existing orgs from the current row counts.
UPDATE organizations
SET conversation_count = (
  SELECT COUNT(*) FROM conversations
  WHERE conversations.organization_id = organizations.id
);
