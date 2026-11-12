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
 *
 * `extra` statements commit in the same batch: writes that must exist
 * exactly when these messages do (the append's vault entries, engram#591;
 * an import's progress marker, engram#751). Either everything is written or
 * nothing is.
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
  extra: D1PreparedStatement[] = [],
) {
  return db.batch([
    ...insertMessageStatements(db, messages),
    db
      .prepare(
        "UPDATE conversations SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?",
      )
      .bind(messages.length, conversationId),
    ...extra,
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
 * Whether any message row has this id. Deliberately not org-scoped: an org
 * merge moves rows by rewriting organization_id, ids unchanged, so a row
 * missing from one org may be alive in another. Ids are never reused, so no
 * row anywhere means the message is gone for good.
 */
export async function messageExists(
  db: D1Database,
  messageId: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS present FROM messages WHERE id = ?")
    .bind(messageId)
    .first();
  return row !== null;
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
  // INDEXED BY is load-bearing (engram#559), as in chunks.ts (#477). Given
  // `conversation_id = ? AND organization_id = ?` and no planner statistics,
  // production picks idx_messages_org and walks every message the
  // organization owns to find one conversation's — seconds on the largest
  // accounts, with D1 answering nothing else meanwhile. The conversation
  // index reads that conversation's rows; the org check runs on them.
  return db
    .prepare(
      "SELECT id FROM messages INDEXED BY idx_messages_conv_seq WHERE conversation_id = ? AND organization_id = ? AND content_encoding LIKE 'r2:%'"
    )
    .bind(conversationId, organizationId)
    .all<{ id: string }>();
}

/**
 * One rowid keyset page of an organization's message pointers (rowid, id,
 * conversation, sequence, role, encoding; never content) for the
 * content-integrity scan (engram#541), optionally limited to one
 * conversation. Pass the last row's `rid` as `afterRowid` for the next page.
 *
 * Every message in the range comes back, inline or R2-backed, and the scan
 * keeps the `r2:*` ones. Filtering on content_encoding here would let a page
 * read past any number of inline rows to fill itself, so its cost would
 * depend on the data instead of on `limit`.
 *
 * Organization-wide, the page seeks idx_messages_org, whose entries run in
 * (organization_id, rowid) order: it reads `limit` rows from the cursor and
 * stops, with no sort. The page used to be keyed on message id, an order no
 * org-scoped index gives, so every page read and sorted all of the
 * organization's pointers: seconds on the largest accounts, while D1 (one
 * statement at a time) answered nothing else (engram#561). The INDEXED BY
 * keeps the plan from depending on the statistics production's planner has
 * (engram#559).
 *
 * Rowid order is safe to resume from: nothing in the service changes a
 * message's rowid, and a row added during a scan gets a rowid above the
 * cursor, so the scan still reaches it.
 */
export function getMessagePointerPage(
  db: D1Database,
  organizationId: string,
  afterRowid: number | null,
  limit: number,
  conversationId?: string
) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (conversationId) {
    where.push("conversation_id = ?");
    params.push(conversationId);
  }
  where.push("organization_id = ?");
  params.push(organizationId);
  if (afterRowid !== null) {
    where.push("rowid > ?");
    params.push(afterRowid);
  }
  // Limited to one conversation, seek the conversation index for the reason
  // getR2MessageIdsByConversation does (engram#559). That page sorts the
  // conversation's rows by rowid, a sort one conversation bounds.
  const index = conversationId ? "idx_messages_conv_seq" : "idx_messages_org";
  return db
    .prepare(
      `SELECT rowid AS rid, id, conversation_id, sequence, role, content_encoding FROM messages INDEXED BY ${index} WHERE ${where.join(" AND ")} ORDER BY rowid LIMIT ?`
    )
    .bind(...params, limit)
    .all<{
      rid: number;
      id: string;
      conversation_id: string;
      sequence: number;
      role: string;
      content_encoding: string | null;
    }>();
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
