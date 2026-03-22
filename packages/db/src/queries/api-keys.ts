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
