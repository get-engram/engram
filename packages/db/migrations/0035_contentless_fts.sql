-- Contentless FTS5: stop storing every chunk's text twice.
--
-- The original chunks_fts is a standalone FTS5 table, so SQLite keeps a
-- complete second copy of every chunk in chunks_fts_content — on top of
-- conversation_chunks.chunk_text. Measured on production 2026-09-01:
--
--   chunks_fts_content   848 MB   duplicate text
--   chunks_fts_data      304 MB   the actual index
--
-- Contentless (content='') keeps only the index. Verified against D1's SQLite
-- build before writing this: content='' is accepted, explicit rowids round
-- trip through MATCH, column filters still scope by org, and
-- contentless_delete=1 allows deleting by rowid ALONE. That last one matters —
-- without it, removing a row from a contentless index requires re-supplying
-- the original text, which becomes impossible once #384 moves chunk text to R2.
--
-- Two consequences drive the shape below:
--   1. A contentless table cannot return column values, so matches come back
--      as rowids and have to be resolved to chunk ids by joining. That needs a
--      stable integer per chunk -> conversation_chunks.fts_rowid.
--   2. organization_id can no longer ride along as an UNINDEXED column, so org
--      scoping moves into the MATCH expression as a column filter. That keeps
--      the filtering inside the index rather than scanning every org's matches
--      and discarding them afterwards.

-- Stable integer key linking a chunk to its FTS row. Derived deterministically
-- from the chunk id (see ftsRowid() in packages/db), so re-indexing the same
-- window is an idempotent overwrite rather than a duplicate.
ALTER TABLE conversation_chunks ADD COLUMN fts_rowid INTEGER;

CREATE INDEX IF NOT EXISTS idx_chunks_fts_rowid
  ON conversation_chunks(fts_rowid);

-- The `org` column is indexed (not UNINDEXED) precisely so it can be used as a
-- MATCH column filter: 'org:<token> AND chunk_text:<query>'.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_v2 USING fts5(
  chunk_text,
  org,
  content='',
  contentless_delete=1
);

-- Deliberately NOT backfilled here. Populating 571k chunks inside a migration
-- would run far past D1's statement limits on a database already at 8.3 GB.
-- The backfill runs afterwards via POST /admin/backfill-fts in batches, and
-- the old chunks_fts is dropped in a follow-up migration once verified.
