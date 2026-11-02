/**
 * Mint a key row. `seatId` binds the key to a Team member's seat; a key
 * minted by a seat member MUST carry that seat (engram#441) — a null-seat key
 * authenticates as the organization owner, so letting a member mint one was
 * a privilege escalation. Owner-minted keys pass null.
 */
export function insertApiKey(
  db: D1Database,
  id: string,
  organizationId: string,
  keyHash: string,
  keyPrefix: string,
  name: string,
  scopes: string = "read,write,search,delete",
  seatId: string | null = null
) {
  return db
    .prepare(
      "INSERT INTO api_keys (id, organization_id, key_hash, key_prefix, name, scopes, seat_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, organizationId, keyHash, keyPrefix, name, scopes, seatId)
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
      `SELECT k.id AS key_id, k.organization_id, k.scopes, k.seat_id, o.tier
       FROM api_keys k
       JOIN organizations o ON o.id = k.organization_id
       WHERE k.key_hash = ?
         AND k.revoked_at IS NULL
         AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))`
    )
    .bind(keyHash)
    .first<{ key_id: string; organization_id: string; scopes: string; seat_id: string | null; tier: string }>();
}

export function updateApiKeyLastUsed(db: D1Database, id: string) {
  return db
    .prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

/**
 * Live keys for the org. With `seatId`, only that seat's own keys — a Team
 * member never sees the owner's (or another member's) credentials, not even
 * as prefixes (engram#441).
 */
export function getApiKeysByOrg(
  db: D1Database,
  organizationId: string,
  opts: { seatId?: string | null } = {}
) {
  if (opts.seatId) {
    return db
      .prepare(
        "SELECT id, key_prefix AS prefix, name, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE organization_id = ? AND seat_id = ? AND revoked_at IS NULL ORDER BY created_at"
      )
      .bind(organizationId, opts.seatId)
      .all();
  }
  return db
    .prepare(
      "SELECT id, key_prefix AS prefix, name, scopes, expires_at, last_used_at, created_at FROM api_keys WHERE organization_id = ? AND revoked_at IS NULL ORDER BY created_at"
    )
    .bind(organizationId)
    .all();
}

/** One key's ownership facts, org-scoped. Used by the revoke guards. */
export function getApiKeyById(db: D1Database, id: string, organizationId: string) {
  return db
    .prepare("SELECT id, seat_id, revoked_at FROM api_keys WHERE id = ? AND organization_id = ?")
    .bind(id, organizationId)
    .first<{ id: string; seat_id: string | null; revoked_at: string | null }>();
}

/**
 * Operator view of an org's keys, revoked ones included. Never the hash —
 * the prefix is enough for support to match what a user is looking at.
 */
export function listApiKeysForAdmin(db: D1Database, organizationId: string) {
  return db
    .prepare(
      "SELECT id, key_prefix AS prefix, name, scopes, seat_id, expires_at, last_used_at, created_at, revoked_at FROM api_keys WHERE organization_id = ? ORDER BY created_at"
    )
    .bind(organizationId)
    .all<{
      id: string;
      prefix: string;
      name: string;
      scopes: string;
      seat_id: string | null;
      expires_at: string | null;
      last_used_at: string | null;
      created_at: string;
      revoked_at: string | null;
    }>();
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

export function revokeApiKeysBySeat(db: D1Database, seatId: string) {
  return db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE seat_id = ? AND revoked_at IS NULL")
    .bind(seatId)
    .run();
}

/**
 * Revoke ALL of an org's API keys at once. Used on the admin/compliance
 * deletion paths so a "deleted" account's keys stop authenticating
 * immediately — the auth join deliberately does NOT check deleted_at (that
 * would break the self-service /restore path, which re-authenticates with the
 * same key), so cutting access on those paths has to be an explicit revoke.
 */
export function revokeApiKeysByOrg(db: D1Database, organizationId: string) {
  return db
    .prepare("UPDATE api_keys SET revoked_at = datetime('now') WHERE organization_id = ? AND revoked_at IS NULL")
    .bind(organizationId)
    .run();
}
