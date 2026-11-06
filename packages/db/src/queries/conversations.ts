export function insertConversation(
  db: D1Database,
  id: string,
  organizationId: string,
  title: string | null,
  agentId: string | null,
  tags: string[],
  metadata: Record<string, unknown>,
  seatId: string | null = null,
  visibility: "shared" | "private" = "shared"
) {
  // Insert the row, bump the denormalized org counter (engram#41), and populate
  // the conversation_tags junction index (engram#42) — all atomically.
  const statements = [
    db
      .prepare(
        "INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata, seat_id, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(id, organizationId, title, agentId, JSON.stringify(tags), JSON.stringify(metadata), seatId, visibility),
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

/** Filters shared by listConversations and countConversations (engram#540). */
export interface ConversationFilter {
  agentId?: string;
  tags?: string[];
  /** Seat of the caller (engram#264): private conversations belonging
   * to other seats are hidden. Omit to skip filtering (admin/export). */
  viewerSeatId?: string | null;
  filterVisibility?: boolean;
}

/**
 * WHERE clause for a conversation listing. Built once and used by both the
 * page query and the count query, so `total` can never disagree with the
 * rows it describes (engram#540: it used to be the page size).
 */
function conversationFilter(organizationId: string, opts: ConversationFilter) {
  let sql = " WHERE organization_id = ?";
  const params: unknown[] = [organizationId];

  if (opts.filterVisibility) {
    if (opts.viewerSeatId) {
      sql += " AND (visibility != 'private' OR seat_id = ?)";
      params.push(opts.viewerSeatId);
    } else {
      sql += " AND (visibility != 'private' OR seat_id IS NULL)";
    }
  }

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

  return { sql, params };
}

export function listConversations(
  db: D1Database,
  organizationId: string,
  opts: ConversationFilter & {
    limit: number;
    offset: number;
    sort: string;
    order: string;
  }
) {
  const where = conversationFilter(organizationId, opts);

  const allowedSort = ["created_at", "updated_at", "message_count"];
  const allowedOrder = ["asc", "desc"];
  const sort = allowedSort.includes(opts.sort) ? opts.sort : "updated_at";
  const order = allowedOrder.includes(opts.order) ? opts.order : "desc";

  return db
    .prepare(`SELECT * FROM conversations${where.sql} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`)
    .bind(...where.params, opts.limit, opts.offset)
    .all();
}

/**
 * Conversations in id order, starting after (or, when `inclusive`, at)
 * `afterId` — keyset paging for the data export (engram#546). Ids are
 * random, so the order is arbitrary but total and stable: a conversation
 * created or deleted mid-export cannot shift the others the way an OFFSET
 * would. `afterId` null starts from the beginning.
 */
export function listConversationsAfterId(
  db: D1Database,
  organizationId: string,
  afterId: string | null,
  limit: number,
  opts: ConversationFilter & { inclusive?: boolean } = {}
) {
  const where = conversationFilter(organizationId, opts);
  let sql = where.sql;
  const params = [...where.params];
  if (afterId !== null) {
    sql += opts.inclusive ? " AND id >= ?" : " AND id > ?";
    params.push(afterId);
  }
  return db
    .prepare(`SELECT * FROM conversations${sql} ORDER BY id ASC LIMIT ?`)
    .bind(...params, limit)
    .all();
}

/**
 * How many conversations the same filters match — the `total` of a list
 * response. A page holds at most `limit` rows; `total` is how many rows the
 * caller can page through with `offset`.
 */
export function countConversations(
  db: D1Database,
  organizationId: string,
  opts: ConversationFilter
) {
  const where = conversationFilter(organizationId, opts);
  return db
    .prepare(`SELECT COUNT(*) AS count FROM conversations${where.sql}`)
    .bind(...where.params)
    .first<{ count: number }>();
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
    // FTS delete must come before chunks delete (subquery references conversation_chunks).
    // Targets chunks_fts_v2 by rowid — the contentless index (migration 0035)
    // cannot be addressed by chunk_id, and the old chunks_fts is being dropped.
    db.prepare("DELETE FROM chunks_fts_v2 WHERE rowid IN (SELECT fts_rowid FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ? AND fts_rowid IS NOT NULL)").bind(id, organizationId),
    db.prepare("DELETE FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    // INDEXED BY on these two is load-bearing (engram#559): given both
    // predicates, production seeks the single-column org index and walks
    // every message / tag the organization owns. conversation_chunks needs
    // no hint — idx_chunks_org_conv covers both columns and wins on cost.
    db.prepare("DELETE FROM messages INDEXED BY idx_messages_conv_seq WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM conversation_tags INDEXED BY sqlite_autoindex_conversation_tags_1 WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
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
