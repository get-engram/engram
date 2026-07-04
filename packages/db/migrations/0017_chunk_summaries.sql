-- Per-chunk summaries so agents can triage search results without reading the
-- full chunk_text (engram#61). Generated extractively at chunk-creation time.
ALTER TABLE conversation_chunks ADD COLUMN chunk_summary TEXT;

-- Backfill existing chunks with a lead snippet so old results still carry a
-- summary. New chunks get a cleaner extractive summary from summarizeChunk().
UPDATE conversation_chunks
SET chunk_summary = substr(chunk_text, 1, 200)
WHERE chunk_summary IS NULL;
