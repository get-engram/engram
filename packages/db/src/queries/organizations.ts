export function insertOrganization(db: D1Database, id: string, name: string) {
  return db
    .prepare("INSERT INTO organizations (id, name) VALUES (?, ?)")
    .bind(id, name)
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
) {
  return db
    .prepare("INSERT INTO organizations (id, name, email) VALUES (?, ?, ?)")
    .bind(id, name, email)
    .run();
}

export function getOrganizationByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM organizations WHERE email = ?")
    .bind(email)
    .first();
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
) {
  return db
    .prepare(
      "UPDATE organizations SET tier = ?, stripe_subscription_id = ? WHERE id = ?",
    )
    .bind(tier, stripeSubscriptionId, id)
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
