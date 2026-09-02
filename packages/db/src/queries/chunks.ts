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
  vectorizeIds: string[]
) {
  const placeholders = vectorizeIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM conversation_chunks WHERE vectorize_id IN (${placeholders})`
    )
    .bind(...vectorizeIds)
    .all();
}

export function getChunksByIds(
  db: D1Database,
  chunkIds: string[]
) {
  const placeholders = chunkIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT * FROM conversation_chunks WHERE id IN (${placeholders})`
    )
    .bind(...chunkIds)
    .all();
}

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
        `SELECT c.id AS chunk_id, f.rank AS rank
           FROM chunks_fts_v2 f
           JOIN conversation_chunks c ON c.fts_rowid = f.rowid
          WHERE chunks_fts_v2 MATCH ?
            AND c.organization_id = ?
            AND c.conversation_id = ?
          ORDER BY f.rank LIMIT ?`
      )
      .bind(ftsMatch(query, organizationId), organizationId, conversationId, limit)
      .all<{ chunk_id: string; rank: number }>();
  }
  return db
    .prepare(
      `SELECT c.id AS chunk_id, f.rank AS rank
         FROM chunks_fts_v2 f
         JOIN conversation_chunks c ON c.fts_rowid = f.rowid
        WHERE chunks_fts_v2 MATCH ?
          AND c.organization_id = ?
        ORDER BY f.rank LIMIT ?`
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
