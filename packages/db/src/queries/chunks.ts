export function insertChunks(
  db: D1Database,
  chunks: Array<{
    id: string;
    conversationId: string;
    organizationId: string;
    chunkText: string;
    startSequence: number;
    endSequence: number;
    vectorizeId: string;
  }>
) {
  const stmts = chunks.map((c) =>
    db
      .prepare(
        "INSERT INTO conversation_chunks (id, conversation_id, organization_id, chunk_text, start_sequence, end_sequence, vectorize_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        c.id,
        c.conversationId,
        c.organizationId,
        c.chunkText,
        c.startSequence,
        c.endSequence,
        c.vectorizeId
      )
  );
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
