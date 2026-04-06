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
    .prepare(
      "INSERT INTO organizations (id, name, email) VALUES (?, ?, ?)",
    )
    .bind(id, name, email)
    .run();
}

export function getOrganizationByEmail(db: D1Database, email: string) {
  return db
    .prepare("SELECT * FROM organizations WHERE email = ?")
    .bind(email)
    .first();
}
