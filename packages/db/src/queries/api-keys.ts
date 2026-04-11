export function insertApiKey(
  db: D1Database,
  id: string,
  organizationId: string,
  keyHash: string,
  keyPrefix: string,
  name: string
) {
  return db
    .prepare(
      "INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(id, organizationId, keyHash, keyPrefix, name)
    .run();
}

export function getApiKeyByHash(db: D1Database, keyHash: string) {
  return db
    .prepare(
      "SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))"
    )
    .bind(keyHash)
    .first();
}

export function updateApiKeyLastUsed(db: D1Database, id: string) {
  return db
    .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export function getApiKeysByOrg(db: D1Database, organizationId: string) {
  return db
    .prepare(
      "SELECT id, key_prefix AS prefix, name, expires_at, last_used_at, created_at FROM api_keys WHERE organization_id = ? AND revoked_at IS NULL ORDER BY created_at"
    )
    .bind(organizationId)
    .all();
}

export function getApiKeyCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT COUNT(*) as count FROM api_keys WHERE organization_id = ? AND revoked_at IS NULL")
    .bind(organizationId)
    .first<{ count: number }>();
}

export function revokeApiKey(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .run();
}
