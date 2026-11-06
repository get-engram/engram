import { ftsRowid, orgFtsToken, ftsMatch } from "./fts-keys.js";

export function insertChunks(
  db: D1Database,
  chunks: Array<{
    id: string;
    conversationId: string;
    organizationId: string;
    chunkText: string;
    chunkSummary: string;
    startSequence: number;
    endSequence: number;
    vectorizeId: string;
  }>
) {
  if (chunks.length === 0) return Promise.resolve();
  // Idempotent by chunk id: with deterministic ids (see chunkId()), re-indexing
  // the same window must upsert, not duplicate or PK-conflict. chunks_fts has no
  // unique key and chunk_id is UNINDEXED (a per-row delete would full-scan the
  // whole FTS on every append), so we clear all prior FTS rows for this batch's
  // ids in ONE delete up front, then INSERT OR REPLACE each chunk row and write
  // its fresh FTS row. All in one D1 batch/transaction.
  const ids = chunks.map((c) => c.id);
  const ph = ids.map(() => "?").join(",");
  const rowids = chunks.map((c) => ftsRowid(c.id));
  const rph = rowids.map(() => "?").join(",");
  const stmts = [
    // Contentless FTS deletes by rowid alone (contentless_delete=1), so the
    // old text is not needed to clear a stale entry — which is what keeps
    // this working once chunk text moves to R2.
    db.prepare(`DELETE FROM chunks_fts_v2 WHERE rowid IN (${rph})`).bind(...rowids),
    ...chunks.flatMap((c) => [
      db
        .prepare(
          "INSERT OR REPLACE INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, chunk_summary, start_sequence, end_sequence, vectorize_id, fts_rowid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          c.id,
          c.conversationId,
          c.organizationId,
          c.chunkText,
          c.chunkSummary,
          c.startSequence,
          c.endSequence,
          c.vectorizeId,
          ftsRowid(c.id)
        ),
      // Dual-write into the FTS5 index for keyword search. The rowid is
      // derived from the chunk id so this is an idempotent overwrite.
      db
        .prepare(
          "INSERT INTO chunks_fts_v2(rowid, chunk_text, org) VALUES (?, ?, ?)"
        )
        .bind(ftsRowid(c.id), c.chunkText, orgFtsToken(c.organizationId)),
    ]),
  ];
  return db.batch(stmts);
}

export function getChunksByVectorizeIds(
  db: D1Database,
  vectorizeIds: string[],
  organizationId: string,
) {
  // Defense in depth: scope hydration to the org, mirroring the FTS path's
  // `c.organization_id = ?` guarantee. Vector matches are already gated by the
  // Vectorize metadata filter, so this is a second, SQL-level fence — if that
  // metadata filter ever regressed or a vector's org metadata diverged from
  // its D1 row, verbatim chunk_text still could not cross tenants.
  //
  // INDEXED BY is load-bearing, not a hint (engram#469, Oct 2026). Given both
  // predicates, SQLite's planner picks idx_chunks_org and walks EVERY chunk the
  // org owns before filtering by vectorize_id — 215k rows per search for the
  // largest account, ~8k on average across 15.9k searches/week, 128M rows read
  // in 7 days from this one statement. Four concurrent searches from one user
  // were enough to overload D1 on 2026-10-06. Forcing the vectorize index turns
  // that into ≤fetchK indexed lookups; the org check then runs on those rows.
  // Verified with EXPLAIN QUERY PLAN against production. If the index is ever
  // dropped this statement errors loudly rather than silently regressing.
  const placeholders = vectorizeIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM conversation_chunks INDEXED BY idx_chunks_vectorize WHERE vectorize_id IN (${placeholders}) AND organization_id = ?`
    )
    .bind(...vectorizeIds, organizationId)
    .all();
}

export function getChunksByIds(
  db: D1Database,
  chunkIds: string[],
  organizationId: string,
) {
  // Same SQL-level fence as getChunksByVectorizeIds (engram#452). The ids
  // come from the org-scoped FTS query today; hydration must not depend on
  // that staying true for every future caller, because what it returns is
  // verbatim chunk_text.
  //
  // INDEXED BY is load-bearing here exactly as above: given
  // `id IN (...) AND organization_id = ?`, production's planner chooses
  // idx_chunks_org and walks the whole org before filtering by id (EXPLAIN
  // QUERY PLAN against prod, 2026-11-02) — the #469 regression in a new
  // coat. Forcing the primary-key index makes this ≤N point lookups.
  const placeholders = chunkIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM conversation_chunks INDEXED BY sqlite_autoindex_conversation_chunks_1 WHERE id IN (${placeholders}) AND organization_id = ?`
    )
    .bind(...chunkIds, organizationId)
    .all();
}

/**
 * Keyword search over the contentless FTS5 index.
 *
 * Ranking uses bm25(chunks_fts_v2, 1.0, 0.0) rather than the bare `rank`
 * shorthand. `rank` scores ALL indexed columns, and `org` is a real indexed
 * column here (it has to be, so the MATCH can scope by it). Since every
 * document in an org carries the same org token, its BM25 contribution varies
 * only with document length — which quietly reweights results toward short
 * chunks regardless of their relevance to the user's actual query.
 *
 * Measured against the old standalone index before this was added: identical
 * result SETS (6,928 = 6,928, zero on either side alone for a sample term) but
 * near-zero overlap in the top 20. Zeroing the org column's weight restored
 * 20/20, 19/20, 19/20 agreement on the same queries.
 */
export function searchChunksFts(
  db: D1Database,
  query: string,
  organizationId: string,
  limit: number,
  conversationId?: string,
) {
  // FTS5 MATCH with org scoping. rank is negative BM25 (lower = better).
  if (conversationId) {
    return db
      .prepare(
        `SELECT c.id AS chunk_id, bm25(chunks_fts_v2, 1.0, 0.0) AS rank
           FROM chunks_fts_v2 f
           JOIN conversation_chunks c ON c.fts_rowid = f.rowid
          WHERE chunks_fts_v2 MATCH ?
            AND c.organization_id = ?
            AND c.conversation_id = ?
          ORDER BY bm25(chunks_fts_v2, 1.0, 0.0) LIMIT ?`
      )
      .bind(ftsMatch(query, organizationId), organizationId, conversationId, limit)
      .all<{ chunk_id: string; rank: number }>();
  }
  return db
    .prepare(
      `SELECT c.id AS chunk_id, bm25(chunks_fts_v2, 1.0, 0.0) AS rank
         FROM chunks_fts_v2 f
         JOIN conversation_chunks c ON c.fts_rowid = f.rowid
        WHERE chunks_fts_v2 MATCH ?
          AND c.organization_id = ?
        ORDER BY bm25(chunks_fts_v2, 1.0, 0.0) LIMIT ?`
    )
    .bind(ftsMatch(query, organizationId), organizationId, limit)
    .all<{ chunk_id: string; rank: number }>();
}

export function deleteChunksFts(
  db: D1Database,
  conversationId: string,
  organizationId: string
) {
  return db
    .prepare(
      "DELETE FROM chunks_fts_v2 WHERE rowid IN (SELECT fts_rowid FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ? AND fts_rowid IS NOT NULL)"
    )
    .bind(conversationId, organizationId);
}

export function getVectorizeIdsByConversation(
  db: D1Database,
  conversationId: string,
  organizationId: string
) {
  return db
    .prepare(
      "SELECT vectorize_id FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?"
    )
    .bind(conversationId, organizationId)
    .all<{ vectorize_id: string }>();
}

/** Chunks whose [start,end] sequence window covers the given message
 *  sequence — the ones invalidated when that message's content changes. */
export function getChunksOverlappingSequence(
  db: D1Database,
  conversationId: string,
  organizationId: string,
  sequence: number
) {
  return db
    .prepare(
      "SELECT id, vectorize_id, start_sequence, end_sequence FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ? AND start_sequence <= ? AND end_sequence >= ?"
    )
    .bind(conversationId, organizationId, sequence, sequence)
    .all<{ id: string; vectorize_id: string; start_sequence: number; end_sequence: number }>();
}

/**
 * The chunks covering one message sequence, WITH their text — the raw
 * material the content-integrity repair rebuilds a lost message body from
 * (engram#541). Same window as getChunksOverlappingSequence. Carries
 * conversation_id and chunk_encoding so the caller can resolve a chunk
 * whose text has moved to R2 (engram#384).
 */
export function getChunkTextsCoveringSequence(
  db: D1Database,
  conversationId: string,
  organizationId: string,
  sequence: number
) {
  return db
    .prepare(
      "SELECT id, conversation_id, chunk_text, chunk_encoding, start_sequence, end_sequence FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ? AND start_sequence <= ? AND end_sequence >= ?"
    )
    .bind(conversationId, organizationId, sequence, sequence)
    .all<{
      id: string;
      conversation_id: string;
      chunk_text: string;
      chunk_encoding: string | null;
      start_sequence: number;
      end_sequence: number;
    }>();
}

/** One row of the engram#384 copy/verify job's walk over conversation_chunks. */
export interface ChunkCopyRow {
  rid: number;
  id: string;
  conversation_id: string;
  organization_id: string;
  chunk_text: string;
  chunk_encoding: string | null;
}

/**
 * The next `limit` chunks after rowid `after`, in rowid order, with their
 * text: one page of the job that copies chunk text to R2 and verifies the
 * copies (engram#384).
 *
 * Paged on rowid alone, so every statement reads `limit` rows however far
 * the walk has got. Filtering on chunk_encoding instead would make each page
 * a scan over every row already done, and D1 runs one statement at a time:
 * a multi-second statement stalls every user (engram#552). With an org the
 * walk follows idx_chunks_org, whose entries are (organization_id, rowid),
 * so it is the same bounded range read; INDEXED BY keeps the planner from
 * taking idx_chunks_org_conv, which would need a sort of the whole org.
 */
export function getChunkCopyPage(
  db: D1Database,
  after: number,
  limit: number,
  organizationId?: string | null
) {
  if (organizationId) {
    return db
      .prepare(
        `SELECT rowid AS rid, id, conversation_id, organization_id, chunk_text, chunk_encoding
           FROM conversation_chunks INDEXED BY idx_chunks_org
          WHERE organization_id = ? AND rowid > ?
          ORDER BY rowid LIMIT ?`
      )
      .bind(organizationId, after, limit)
      .all<ChunkCopyRow>();
  }
  return db
    .prepare(
      `SELECT rowid AS rid, id, conversation_id, organization_id, chunk_text, chunk_encoding
         FROM conversation_chunks
        WHERE rowid > ?
        ORDER BY rowid LIMIT ?`
    )
    .bind(after, limit)
    .all<ChunkCopyRow>();
}

// Bound parameters per IN(...) statement — D1 refuses more than 100.
const ID_IN_CHUNK = 90;

/** A chunk as it is now, for checking a copy against the row. */
export interface ChunkTextNow {
  id: string;
  conversation_id: string;
  chunk_text: string;
  chunk_encoding: string | null;
}

/**
 * These chunks as they are now, by id; a chunk with no row is simply absent
 * (engram#384). The copy job reads a page, then writes an object per chunk.
 * A save or delete can land in between, so it reads the rows again
 * afterwards: an object whose row is gone is removed rather than left behind
 * after the user deleted it, and one whose row changed is rewritten from the
 * row's current text.
 */
export async function getChunkTextsByIds(
  db: D1Database,
  ids: string[]
): Promise<ChunkTextNow[]> {
  const out: ChunkTextNow[] = [];
  for (let i = 0; i < ids.length; i += ID_IN_CHUNK) {
    const slice = ids.slice(i, i + ID_IN_CHUNK);
    const res = await db
      .prepare(
        `SELECT id, conversation_id, chunk_text, chunk_encoding FROM conversation_chunks WHERE id IN (${slice.map(() => "?").join(",")})`
      )
      .bind(...slice)
      .all<ChunkTextNow>();
    out.push(...(res.results ?? []));
  }
  return out;
}

export function deleteChunksByIds(
  db: D1Database,
  ids: string[],
  organizationId: string
) {
  if (ids.length === 0) return Promise.resolve();
  const ph = ids.map(() => "?").join(",");
  return db.batch([
    db
      .prepare(
        `DELETE FROM chunks_fts_v2 WHERE rowid IN (${ids.map(() => "?").join(",")})`
      )
      .bind(...ids.map(ftsRowid)),
    db
      .prepare(
        `DELETE FROM conversation_chunks WHERE id IN (${ph}) AND organization_id = ?`
      )
      .bind(...ids, organizationId),
  ]);
}
