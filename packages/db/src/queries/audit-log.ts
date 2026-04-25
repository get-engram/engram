export function insertAuditLog(
  db: D1Database,
  entry: {
    id: string;
    organizationId: string;
    apiKeyId: string | null;
    action: string;
    resourceType: string | null;
    resourceId: string | null;
    metadata: Record<string, unknown>;
  },
) {
  return db
    .prepare(
      "INSERT INTO audit_log (id, organization_id, api_key_id, action, resource_type, resource_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      entry.id,
      entry.organizationId,
      entry.apiKeyId,
      entry.action,
      entry.resourceType,
      entry.resourceId,
      JSON.stringify(entry.metadata),
    )
    .run();
}

export function getAuditLogs(
  db: D1Database,
  organizationId: string,
  opts: {
    limit: number;
    offset: number;
    action?: string;
  },
) {
  let sql = "SELECT * FROM audit_log WHERE organization_id = ?";
  const params: unknown[] = [organizationId];

  if (opts.action) {
    sql += " AND action = ?";
    params.push(opts.action);
  }

  sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(opts.limit, opts.offset);

  return db.prepare(sql).bind(...params).all();
}

export function deleteAuditLogsBefore(
  db: D1Database,
  organizationId: string,
  beforeDate: string,
) {
  return db
    .prepare(
      "DELETE FROM audit_log WHERE organization_id = ? AND created_at < ?",
    )
    .bind(organizationId, beforeDate)
    .run();
}
