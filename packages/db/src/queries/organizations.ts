export function insertOrganization(db: D1Database, id: string, name: string, referralSource?: string) {
  return db
    .prepare("INSERT INTO organizations (id, name, referral_source) VALUES (?, ?, ?)")
    .bind(id, name, referralSource ?? null)
    .run();
}

export function getOrganizationById(db: D1Database, id: string) {
  return db
    .prepare("SELECT * FROM organizations WHERE id = ?")
    .bind(id)
    .first();
}

export function insertOrganizationWithEmail(
  db: D1Database,
  id: string,
  name: string,
  email: string,
  referralSource?: string,
) {
  return db
    .prepare("INSERT INTO organizations (id, name, email, referral_source) VALUES (?, ?, ?, ?)")
    .bind(id, name, email, referralSource ?? null)
    .run();
}

export function getOrganizationByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM organizations WHERE email = ?")
    .bind(email)
    .first();
}

export function setOrganizationEmail(
  db: D1Database,
  id: string,
  email: string,
) {
  return db
    .prepare("UPDATE organizations SET email = ? WHERE id = ?")
    .bind(email, id)
    .run();
}

export function getOrganizationByStripeCustomer(
  db: D1Database,
  stripeCustomerId: string,
) {
  return db
    .prepare("SELECT * FROM organizations WHERE stripe_customer_id = ?")
    .bind(stripeCustomerId)
    .first();
}

export function setOrganizationStripeCustomer(
  db: D1Database,
  id: string,
  stripeCustomerId: string,
) {
  return db
    .prepare("UPDATE organizations SET stripe_customer_id = ? WHERE id = ?")
    .bind(stripeCustomerId, id)
    .run();
}

export function setOrganizationTier(
  db: D1Database,
  id: string,
  tier: "free" | "pro" | "team" | "enterprise",
  stripeSubscriptionId: string | null,
  seatLimit?: number,
) {
  return db
    .prepare(
      "UPDATE organizations SET tier = ?, stripe_subscription_id = ?, seat_limit = ? WHERE id = ?",
    )
    .bind(tier, stripeSubscriptionId, seatLimit ?? 1, id)
    .run();
}

export interface PrivacySettingsRow {
  assistant_can_read_bodies: number;
  assistant_can_read_cross_conversation: number;
}

export function getPrivacySettings(db: D1Database, organizationId: string) {
  return db
    .prepare(
      "SELECT assistant_can_read_bodies, assistant_can_read_cross_conversation FROM organizations WHERE id = ?",
    )
    .bind(organizationId)
    .first<PrivacySettingsRow>();
}

export function updatePrivacySettings(
  db: D1Database,
  organizationId: string,
  settings: {
    assistant_can_read_bodies: boolean;
    assistant_can_read_cross_conversation: boolean;
  },
) {
  return db
    .prepare(
      "UPDATE organizations SET assistant_can_read_bodies = ?, assistant_can_read_cross_conversation = ? WHERE id = ?",
    )
    .bind(
      settings.assistant_can_read_bodies ? 1 : 0,
      settings.assistant_can_read_cross_conversation ? 1 : 0,
      organizationId,
    )
    .run();
}

export function getVectorizeIdsByOrganization(
  db: D1Database,
  organizationId: string,
) {
  return db
    .prepare(
      "SELECT vectorize_id FROM conversation_chunks WHERE organization_id = ?",
    )
    .bind(organizationId)
    .all<{ vectorize_id: string }>();
}

export function deleteOrganizationById(db: D1Database, id: string) {
  return db.batch([
    // FTS delete must come before chunks (subquery references conversation_chunks)
    db.prepare(
      "DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM conversation_chunks WHERE organization_id = ?)",
    ).bind(id),
    // CASCADE handles the rest, but explicit deletes are safer for ordering
    db.prepare("DELETE FROM conversation_chunks WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM messages WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM conversation_tags WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM organizations WHERE id = ?").bind(id),
  ]);
}

export function softDeleteOrganization(db: D1Database, id: string) {
  return db
    .prepare(
      "UPDATE organizations SET deleted_at = datetime('now') WHERE id = ?",
    )
    .bind(id)
    .run();
}

export function restoreOrganization(db: D1Database, id: string) {
  return db
    .prepare("UPDATE organizations SET deleted_at = NULL WHERE id = ?")
    .bind(id)
    .run();
}

export function getExpiredOrganizations(db: D1Database) {
  return db
    .prepare(
      "SELECT id FROM organizations WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')",
    )
    .all<{ id: string }>();
}

export function getOrganizationStats(db: D1Database, organizationId: string) {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM conversations WHERE organization_id = ?) AS conversations,
        (SELECT COUNT(*) FROM messages WHERE organization_id = ?) AS messages,
        (SELECT COUNT(*) FROM conversation_chunks WHERE organization_id = ?) AS chunks`,
    )
    .bind(organizationId, organizationId, organizationId)
    .first<{ conversations: number; messages: number; chunks: number }>();
}

// ── Lifetime storage counter (engram#275) ─────────────────────────────
// The storage cap is the primary billing gate: memory fills up, nothing
// ever expires. These mirror the race-safe pattern in queries/usage.ts.

/**
 * Atomically increment the lifetime storage counter only if the new
 * total stays within `limit`. Returns the updated total, or null when
 * the increment would exceed the limit (memory full).
 */
export function atomicIncrementStorage(
  db: D1Database,
  organizationId: string,
  count: number,
  limit: number,
) {
  return db
    .prepare(
      `UPDATE organizations
       SET messages_stored_total = messages_stored_total + ?
       WHERE id = ? AND messages_stored_total + ? <= ?
       RETURNING messages_stored_total`,
    )
    .bind(count, organizationId, count, limit)
    .first<{ messages_stored_total: number }>();
}

/** Unconditional increment — for unlimited-storage tiers. */
export function incrementStorage(db: D1Database, organizationId: string, count: number) {
  return db
    .prepare(
      `UPDATE organizations SET messages_stored_total = messages_stored_total + ?
       WHERE id = ? RETURNING messages_stored_total`,
    )
    .bind(count, organizationId)
    .first<{ messages_stored_total: number }>();
}

/**
 * Free storage back up — on conversation delete, or to roll back a
 * reserved increment when the write that followed it failed.
 */
export function decrementStorage(db: D1Database, organizationId: string, count: number) {
  return db
    .prepare(
      `UPDATE organizations SET messages_stored_total = MAX(0, messages_stored_total - ?)
       WHERE id = ?`,
    )
    .bind(count, organizationId)
    .run();
}

export function getStorageUsed(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT messages_stored_total FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ messages_stored_total: number }>();
}
