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

/**
 * The per-period counters that can be capped. Interpolated into SQL below,
 * so the set is closed: only these names, never caller input.
 */
type CappedCounter = "messages_stored" | "searches_run" | "chunks_indexed";

/**
 * Atomically add `count` to a counter only if the new total stays within
 * `limit`. Returns the updated value, or null if the limit would be
 * exceeded (the row is left untouched). One statement, so concurrent
 * requests cannot both pass the check and together exceed the limit.
 */
function atomicIncrementCounter(
  db: D1Database,
  column: CappedCounter,
  organizationId: string,
  count: number,
  limit: number,
) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `UPDATE usage
       SET ${column} = ${column} + ?, updated_at = datetime('now')
       WHERE organization_id = ? AND period = ?
         AND ${column} + ? <= ?
       RETURNING ${column}`
    )
    .bind(count, organizationId, period, count, limit)
    .first<Record<CappedCounter, number>>();
}

/** Unconditional add — for tiers with no cap on the counter. */
function incrementCounter(
  db: D1Database,
  column: CappedCounter,
  organizationId: string,
  count: number,
) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `UPDATE usage SET ${column} = ${column} + ?, updated_at = datetime('now')
       WHERE organization_id = ? AND period = ?`
    )
    .bind(count, organizationId, period)
    .run();
}

/**
 * Atomically increment messages_stored only if the new total stays within
 * the given limit. Returns the updated row if successful, null if the
 * limit would be exceeded. Prevents race conditions between concurrent
 * append requests.
 */
export function atomicIncrementMessages(
  db: D1Database,
  organizationId: string,
  count: number,
  limit: number,
): Promise<{ messages_stored: number } | null> {
  return atomicIncrementCounter(db, "messages_stored", organizationId, count, limit);
}

export function incrementSearchesRun(db: D1Database, organizationId: string) {
  return incrementCounter(db, "searches_run", organizationId, 1);
}

/**
 * Count one search only if the period's search budget allows it
 * (engram#451). Null = budget exhausted; the caller must not run the
 * search (the query embedding is the cost being bounded).
 */
export function atomicIncrementSearches(
  db: D1Database,
  organizationId: string,
  limit: number,
): Promise<{ searches_run: number } | null> {
  return atomicIncrementCounter(db, "searches_run", organizationId, 1, limit);
}

/** Unconditional indexing count — tiers with no indexing cap. */
export function incrementChunksIndexed(db: D1Database, organizationId: string, count: number) {
  return incrementCounter(db, "chunks_indexed", organizationId, count);
}

/**
 * Reserve `count` chunks of this period's indexing budget (engram#445,
 * #450). Null = the budget would be exceeded; nothing was counted and the
 * caller must not embed. Never decremented: a delete frees storage, not
 * indexing, so a save/delete loop cannot re-run the embedding model for
 * free.
 */
export function atomicIncrementChunksIndexed(
  db: D1Database,
  organizationId: string,
  count: number,
  limit: number,
): Promise<{ chunks_indexed: number } | null> {
  return atomicIncrementCounter(db, "chunks_indexed", organizationId, count, limit);
}

/**
 * Count one authenticated data-plane API request (engram#287). Single
 * round trip: creates the period row if needed, else bumps the counter.
 * The id is only used when this insert creates the row.
 */
export function incrementApiRequests(db: D1Database, id: string, organizationId: string) {
  const period = getCurrentPeriod();
  return db
    .prepare(
      `INSERT INTO usage (id, organization_id, period, api_requests)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(organization_id, period)
       DO UPDATE SET api_requests = api_requests + 1, updated_at = datetime('now')`
    )
    .bind(id, organizationId, period)
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
