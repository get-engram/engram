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
