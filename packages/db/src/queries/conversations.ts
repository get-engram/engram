export function insertConversation(
  db: D1Database,
  id: string,
  organizationId: string,
  title: string | null,
  agentId: string | null,
  tags: string[],
  metadata: Record<string, unknown>
) {
  return db
    .prepare(
      "INSERT INTO conversations (id, organization_id, title, agent_id, tags, metadata) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(id, organizationId, title, agentId, JSON.stringify(tags), JSON.stringify(metadata))
    .run();
}

export function getConversationById(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("SELECT * FROM conversations WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .first();
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
    for (const tag of opts.tags) {
      sql += ` AND EXISTS (SELECT 1 FROM json_each(tags) WHERE json_each.value = ?)`;
      params.push(tag);
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

export function getConversationCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT COUNT(*) as count FROM conversations WHERE organization_id = ?")
    .bind(organizationId)
    .first<{ count: number }>();
}

export function deleteConversationById(db: D1Database, id: string, organizationId: string) {
  return db.batch([
    db.prepare("DELETE FROM conversation_chunks WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM messages WHERE conversation_id = ? AND organization_id = ?").bind(id, organizationId),
    db.prepare("DELETE FROM conversations WHERE id = ? AND organization_id = ?").bind(id, organizationId),
  ]);
}
