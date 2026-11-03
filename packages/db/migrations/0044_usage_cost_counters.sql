-- Per-period cost counter (engram#445, #450, #451): chunks_indexed counts
-- the embeddings an org generated this period — on append and on the
-- edit/delete re-index — so the metered unit is the one that costs money
-- (Workers AI + Vectorize), not the row count. It is monotonic: deleting a
-- message gives storage back but never refunds indexing, so a save/delete
-- loop cannot run the embedding model for free.
ALTER TABLE usage ADD COLUMN chunks_indexed INTEGER NOT NULL DEFAULT 0;
