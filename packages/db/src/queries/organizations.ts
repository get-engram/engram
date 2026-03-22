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
