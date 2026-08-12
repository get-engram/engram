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
  const stmts = [
    db.prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${ph})`).bind(...ids),
    ...chunks.flatMap((c) => [
      db
        .prepare(
          "INSERT OR REPLACE INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, chunk_summary, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(
          c.id,
          c.conversationId,
          c.organizationId,
          c.chunkText,
          c.chunkSummary,
          c.startSequence,
          c.endSequence,
          c.vectorizeId
        ),
      // Dual-write into FTS5 index for keyword search
      db
        .prepare(
          "INSERT INTO chunks_fts(chunk_text, chunk_id, organization_id) VALUES (?, ?, ?)"
        )
        .bind(c.chunkText, c.id, c.organizationId),
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
        `SELECT chunk_id, rank FROM chunks_fts
         WHERE chunks_fts MATCH ? AND organization_id = ?
           AND chunk_id IN (SELECT id FROM conversation_chunks WHERE conversation_id = ?)
         ORDER BY rank LIMIT ?`
      )
      .bind(query, organizationId, conversationId, limit)
      .all<{ chunk_id: string; rank: number }>();
  }
  return db
    .prepare(
      `SELECT chunk_id, rank FROM chunks_fts
       WHERE chunks_fts MATCH ? AND organization_id = ?
       ORDER BY rank LIMIT ?`
    )
    .bind(query, organizationId, limit)
    .all<{ chunk_id: string; rank: number }>();
}

export function deleteChunksFts(
  db: D1Database,
  conversationId: string,
  organizationId: string
) {
  return db
    .prepare(
      "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?)"
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
      .prepare(`DELETE FROM chunks_fts WHERE chunk_id IN (${ph})`)
      .bind(...ids),
    db
      .prepare(
        `DELETE FROM conversation_chunks WHERE id IN (${ph}) AND organization_id = ?`
      )
      .bind(...ids, organizationId),
  ]);
}
