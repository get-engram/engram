export function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function getOrCreateUsage(db: D1Database, id: string, organizationId: string) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `INSERT INTO usage (id, organization_id, period)
       VALUES (?, ?, ?)
       ON CONFLICT(organization_id, period) DO UPDATE SET updated_at = datetime('now')
       RETURNING *`
    )
    .bind(id, organizationId, period)
    .first();
}

export function getUsage(db: D1Database, organizationId: string) {
  const period = getCurrentPeriod();
  return db
    .prepare("SELECT * FROM usage WHERE organization_id = ? AND period = ?")
    .bind(organizationId, period)
    .first();
}

export function incrementMessagesStored(db: D1Database, organizationId: string, count: number) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `UPDATE usage SET messages_stored = messages_stored + ?, updated_at = datetime('now')
       WHERE organization_id = ? AND period = ?`
    )
    .bind(count, organizationId, period)
    .run();
}

export function incrementSearchesRun(db: D1Database, organizationId: string) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `UPDATE usage SET searches_run = searches_run + 1, updated_at = datetime('now')
       WHERE organization_id = ? AND period = ?`
    )
    .bind(organizationId, period)
    .run();
}

export function getUsageHistory(db: D1Database, organizationId: string, months: number = 6) {
  return db
    .prepare(
      `SELECT * FROM usage WHERE organization_id = ? ORDER BY period DESC LIMIT ?`
    )
    .bind(organizationId, months)
    .all();
}
