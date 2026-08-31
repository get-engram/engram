export function insertMessages(
  db: D1Database,
  messages: Array<{
    id: string;
    conversationId: string;
    organizationId: string;
    role: string;
    content: string;
    contentEncoding: string | null;
    toolCallId: string | null;
    toolName: string | null;
    sequence: number;
    metadata: Record<string, unknown>;
  }>
) {
  const stmts = messages.map((m) =>
    db
      .prepare(
        "INSERT INTO messages (id, conversation_id, organization_id, role, content, content_encoding, tool_call_id, tool_name, sequence, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        m.id,
        m.conversationId,
        m.organizationId,
        m.role,
        m.content,
        m.contentEncoding,
        m.toolCallId,
        m.toolName,
        m.sequence,
        JSON.stringify(m.metadata)
      )
  );
  return db.batch(stmts);
}

export function getMessagesByConversation(
  db: D1Database,
  conversationId: string,
  organizationId: string,
  limit: number,
  offset: number
) {
  return db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND organization_id = ? ORDER BY sequence ASC LIMIT ? OFFSET ?"
    )
    .bind(conversationId, organizationId, limit, offset)
    .all();
}

export function getMaxSequence(db: D1Database, conversationId: string) {
  return db
    .prepare("SELECT MAX(sequence) as max_seq FROM messages WHERE conversation_id = ?")
    .bind(conversationId)
    .first<{ max_seq: number | null }>();
}

export function getMessagesBySequenceRange(
  db: D1Database,
  conversationId: string,
  organizationId: string,
  startSeq: number,
  endSeq: number
) {
  return db
    .prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND organization_id = ? AND sequence >= ? AND sequence <= ? ORDER BY sequence ASC"
    )
    .bind(conversationId, organizationId, startSeq, endSeq)
    .all();
}

export function getMessageById(
  db: D1Database,
  messageId: string,
  organizationId: string
) {
  return db
    .prepare("SELECT * FROM messages WHERE id = ? AND organization_id = ?")
    .bind(messageId, organizationId)
    .first();
}

export function updateMessageContent(
  db: D1Database,
  messageId: string,
  organizationId: string,
  content: string,
  contentEncoding: string | null
) {
  return db
    .prepare(
      "UPDATE messages SET content = ?, content_encoding = ? WHERE id = ? AND organization_id = ?"
    )
    .bind(content, contentEncoding, messageId, organizationId)
    .run();
}

/**
 * Ids of R2-backed messages in a conversation, for purging their bodies
 * from the content bucket before the D1 rows are deleted.
 *
 * Only `r2:*` rows have an object; legacy inline content lives in the D1
 * column and goes away with the row. Order matters at the call site: read
 * these BEFORE deleting from D1, or the keys become unrecoverable.
 */
export function getR2MessageIdsByConversation(
  db: D1Database,
  conversationId: string,
  organizationId: string
) {
  return db
    .prepare(
      "SELECT id FROM messages WHERE conversation_id = ? AND organization_id = ? AND content_encoding LIKE 'r2:%'"
    )
    .bind(conversationId, organizationId)
    .all<{ id: string }>();
}

/** Same, for every message in an organization (hard-purge after account deletion). */
export function getR2MessageIdsByOrganization(
  db: D1Database,
  organizationId: string
) {
  return db
    .prepare(
      "SELECT id FROM messages WHERE organization_id = ? AND content_encoding LIKE 'r2:%'"
    )
    .bind(organizationId)
    .all<{ id: string }>();
}
