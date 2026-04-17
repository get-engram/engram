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

/**
 * Single-query auth lookup: joins api_keys → organizations to return
 * key ID, org ID, and tier in one D1 round trip.
 */
export function getApiKeyWithOrg(db: D1Database, keyHash: string) {
  return db
    .prepare(
      `SELECT k.id AS key_id, k.organization_id, o.tier
       FROM api_keys k
       JOIN organizations o ON o.id = k.organization_id
       WHERE k.key_hash = ?
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))`
    )
    .bind(keyHash)
    .first<{ key_id: string; organization_id: string; tier: string }>();
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
