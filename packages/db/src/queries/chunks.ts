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
  const stmts = chunks.flatMap((c) => [
    db
      .prepare(
        "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, chunk_summary, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
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
  ]);
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
