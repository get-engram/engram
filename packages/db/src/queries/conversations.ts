export function insertConversation(
  db: D1Database,
  id: string,
  organizationId: string,
  title: string | null,
  agentId: string | null,
  tags: string[],
  metadata: Record<string, unknown>
) {
  // Insert the row, bump the denormalized org counter (engram#41), and populate
  // the conversation_tags junction index (engram#42) — all atomically.
  const statements = [
    db
      .prepare(
        "INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(id, organizationId, title, agentId, JSON.stringify(tags), JSON.stringify(metadata)),
    db
      .prepare(
        "UPDATE organizations SET conversation_count = conversation_count + 1 WHERE id = ?"
      )
      .bind(organizationId),
  ];
  for (const tag of tags) {
    if (!tag) continue;
    statements.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO conversation_tags (conversation_id, organization_id, tag) VALUES (?, ?, ?)"
        )
        .bind(id, organizationId, tag),
    );
  }
  return db.batch(statements);
}

export function getConversationById(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .first();
}

/** Tag marking the org's auto-created default memory conversation. */
export const DEFAULT_CONVERSATION_TAG = "__engram_default__";

/**
 * Find the org's default memory conversation (the one append_messages writes
 * to when no conversation_id is supplied). Returns its id or null.
 */
export function getDefaultConversationId(db: D1Database, organizationId: string) {
  return db
    .prepare(
      `SELECT id FROM conversations
       WHERE organization_id = ?
         AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)
       ORDER BY created_at LIMIT 1`,
    )
    .bind(organizationId, DEFAULT_CONVERSATION_TAG)
    .first<{ id: string }>();
}

export function listConversations(
  db: D1Database,
  organizationId: string,
  opts: {
    limit: number;
    offset: number;
    agentId?: string;
    tags?: string[];
    sort: string;
    order: string;
  }
) {
  let sql = "SELECT * FROM conversations WHERE organization_id = ?";
  const params: unknown[] = [organizationId];

  if (opts.agentId) {
    sql += " AND agent_id = ?";
    params.push(opts.agentId);
  }

  if (opts.tags && opts.tags.length > 0) {
    // Filter via the conversation_tags junction index (engram#42) instead of
    // a json_each scan. One EXISTS per tag = AND semantics (must have all).
    for (const tag of opts.tags) {
      sql += ` AND EXISTS (SELECT 1 FROM conversation_tags ct WHERE ct.organization_id = ? AND ct.tag = ? AND ct.conversation_id = conversations.id)`;
      params.push(organizationId, tag);
    }
  }

  const allowedSort = ["created_at", "updated_at", "message_count"];
  const allowedOrder = ["asc", "desc"];
  const sort = allowedSort.includes(opts.sort) ? opts.sort : "updated_at";
  const order = allowedOrder.includes(opts.order) ? opts.order : "desc";
  sql += ` ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`;
  params.push(opts.limit, opts.offset);

  return db
    .prepare(sql)
    .bind(...params)
    .all();
}

export function updateConversationMessageCount(
  db: D1Database,
  id: string,
  increment: number
) {
  return db
    .prepare(
      "UPDATE conversations SET message_count = message_count + ?, updated_at = datetime('now') WHERE id = ?"
    )
    .bind(increment, id)
    .run();
}

/** COUNT(*) fallback — kept for backfills/reconciliation and tests. */
export function getConversationCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT COUNT(*) as count FROM conversations WHERE organization_id = ?")
    .bind(organizationId)
    .first<{ count: number }>();
}

/** O(1) read of the denormalized counter on the org row (engram#41). */
export function getOrgConversationCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT conversation_count as count FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ count: number }>();
}

export function deleteConversationById(db: D1Database, id: string, organizationId: string) {
  return db.batch([
    // FTS delete must come before chunks delete (subquery references conversation_chunks)
    db.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?)").bind(id, organizationId),
    db.prepare("DELETE FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM messages WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM conversation_tags WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM conversations WHERE id = ? AND organization_id = ?").bind(id, organizationId),
    // Keep the denormalized org counter in sync; clamp at 0 defensively.
    db.prepare("UPDATE organizations SET conversation_count = MAX(conversation_count - 1, 0) WHERE id = ?").bind(organizationId),
  ]);
}

/**
 * Find a conversation previously imported with this fingerprint
 * (engram#254). Fingerprints are only set by importers.
 */
export function getConversationByFingerprint(
  db: D1Database,
  organizationId: string,
  fingerprint: string
) {
  return db
    .prepare(
      "SELECT id, message_count FROM conversations WHERE organization_id = ? AND import_fingerprint = ? LIMIT 1"
    )
    .bind(organizationId, fingerprint)
    .first<{ id: string; message_count: number }>();
}
