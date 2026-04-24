-- FTS5 virtual table for keyword/BM25 search on chunk text.
-- Standalone (not content-external) because D1 doesn't support triggers
-- for automatic sync. Dual-write handled at the application layer.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  chunk_text,
  chunk_id UNINDEXED,
  organization_id UNINDEXED
);

-- Backfill existing chunks into the FTS index.
INSERT INTO chunks_fts(chunk_text, chunk_id, organization_id)
  SELECT chunk_text, id, organization_id
  FROM conversation_chunks;
