-- P1: Backfill FTS index with conversation title context.
-- This makes keyword searches match on conversation titles (e.g. "Antonia")
-- even when the name only appears in the title, not the chunk text.

DELETE FROM chunks_fts;

INSERT INTO chunks_fts(chunk_text, chunk_id, organization_id)
  SELECT
    CASE
      WHEN c.title IS NOT NULL AND c.title != ''
        THEN 'Title: ' || c.title || CHAR(10) || cc.chunk_text
      ELSE cc.chunk_text
    END,
    cc.id,
    cc.organization_id
  FROM conversation_chunks cc
  JOIN conversations c ON c.id = cc.conversation_id;
