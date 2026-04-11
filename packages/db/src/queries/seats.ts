export function insertSeat(
  db: D1Database,
  id: string,
  organizationId: string,
  email: string,
  role: string = "member"
) {
  return db
    .prepare(
      "INSERT INTO seats (id, organization_id, email, role) VALUES (?, ?, ?, ?)"
    )
    .bind(id, organizationId, email, role)
    .run();
}

export function getSeatsByOrg(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT * FROM seats WHERE organization_id = ? ORDER BY invited_at")
    .bind(organizationId)
    .all();
}

export function getSeatByEmail(db: D1Database, organizationId: string, email: string) {
  return db
    .prepare("SELECT * FROM seats WHERE organization_id = ? AND email = ?")
    .bind(organizationId, email)
    .first();
}

export function getSeatCount(db: D1Database, organizationId: string) {
  return db
    .prepare("SELECT COUNT(*) as count FROM seats WHERE organization_id = ?")
    .bind(organizationId)
    .first<{ count: number }>();
}

export function acceptSeat(db: D1Database, id: string) {
  return db
    .prepare("UPDATE seats SET accepted_at = datetime('now') WHERE id = ?")
    .bind(id)
    .run();
}

export function deleteSeat(db: D1Database, id: string) {
  return db
    .prepare("DELETE FROM seats WHERE id = ?")
    .bind(id)
    .run();
}
