-- Normalize tags into a junction table for fast filtering (engram#42).
--
-- listConversations filtered tags with one EXISTS(json_each(tags)) subquery
-- per tag — O(conversations) per tag, quadratic at scale. This junction table,
-- indexed on (organization_id, tag), turns a tag filter into an index lookup.
--
-- conversations.tags (JSON) stays the source of truth (returned by the API and
-- used for the default-conversation lookup); this table is a maintained index.
-- Tags are immutable after creation, so a dual-write on insert/delete keeps it
-- consistent — there is no update path to drift from.
CREATE TABLE conversation_tags (
  conversation_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (conversation_id, tag)
);

CREATE INDEX idx_conversation_tags_org_tag
  ON conversation_tags (organization_id, tag);

-- Backfill from existing conversations' JSON tag arrays.
INSERT OR IGNORE INTO conversation_tags (conversation_id, organization_id, tag)
SELECT c.id, c.organization_id, je.value
FROM conversations c, json_each(c.tags) je
WHERE je.value IS NOT NULL AND je.value != '';
