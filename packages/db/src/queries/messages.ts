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
  return db.batch(insertMessageStatements(db, messages));
}

/** The INSERT statements for a batch of messages, without executing them — so
 *  a caller can commit them ATOMICALLY together with a counter update in one
 *  db.batch (D1 batches are transactional). Used by insertMessagesWithCount. */
function insertMessageStatements(
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
  }>,
) {
  return messages.map((m) =>
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
}

/**
 * Insert messages AND bump the conversation's message_count in ONE atomic
 * batch. Previously the inserts and the count update were two separate calls,
 * so a failure between them (or a dropped second call) left message_count
 * drifting below the real row count — the same "counter maintained by
 * convention" class that miscounted ~984 orgs' storage totals. One batch means
 * they can never diverge.
 */
export function insertMessagesWithCount(
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
  }>,
  conversationId: string,
) {
  return db.batch([
    ...insertMessageStatements(db, messages),
    db
      .prepare(
        "UPDATE conversations SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(messages.length, conversationId),
  ]);
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

/**
 * Delete one message AND decrement the conversation's message_count in one
 * atomic batch (mirror of insertMessagesWithCount — split writes are how the
 * counter drifted historically). Org- and conversation-scoped.
 */
export function deleteMessageWithCount(
  db: D1Database,
  messageId: string,
  conversationId: string,
  organizationId: string
) {
  return db.batch([
    db
      .prepare(
        "DELETE FROM messages WHERE id = ? AND conversation_id = ? AND organization_id = ?"
      )
      .bind(messageId, conversationId, organizationId),
    db
      .prepare(
        "UPDATE conversations SET message_count = MAX(message_count - 1, 0), updated_at = datetime('now') WHERE id = ? AND organization_id = ?"
      )
      .bind(conversationId, organizationId),
  ]);
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

/** One rowid-cursored page of an org's R2-backed message ids. Lets the GDPR
 *  purge stream a multi-million-message org's R2 keys instead of loading them
 *  all into the 128MB isolate at once (which would OOM the whole purge run). */
export function getR2MessageIdsByOrganizationPage(
  db: D1Database,
  organizationId: string,
  afterRowid: number,
  limit: number,
) {
  return db
    .prepare(
      "SELECT rowid AS rid, id FROM messages WHERE organization_id = ? AND content_encoding LIKE 'r2:%' AND rowid > ? ORDER BY rowid LIMIT ?",
    )
    .bind(organizationId, afterRowid, limit)
    .all<{ rid: number; id: string }>();
}
