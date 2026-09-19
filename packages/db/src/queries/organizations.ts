export function insertOrganization(
  db: D1Database,
  id: string,
  name: string,
  referralSource?: string,
  country?: string | null,
) {
  return db
    .prepare("INSERT INTO organizations (id, name, referral_source, country) VALUES (?, ?, ?, ?)")
    .bind(id, name, referralSource ?? null, country ?? null)
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
  country?: string | null,
) {
  return db
    .prepare(
      "INSERT INTO organizations (id, name, email, referral_source, country) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(id, name, email, referralSource ?? null, country ?? null)
    .run();
}

/**
 * Fill in an organization's country the first time we see a request from it.
 *
 * Only ever writes when country IS NULL, which does two things: it backfills
 * accounts created before the column existed, and it makes the value "where
 * this account signed up from" rather than "where they last happened to be" —
 * a stable attribute that does not flicker when someone travels or uses a VPN.
 *
 * The WHERE clause means the common case (already set) writes no rows, so this
 * is cheap to call on every authenticated request.
 */
export function touchOrganizationCountry(
  db: D1Database,
  id: string,
  country: string,
) {
  return db
    .prepare("UPDATE organizations SET country = ? WHERE id = ? AND country IS NULL")
    .bind(country, id)
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

/** One rowid-cursored page of an org's vector ids — same streaming purpose as
 *  getR2MessageIdsByOrganizationPage, for the GDPR purge's Vectorize deletes. */
export function getVectorizeIdsByOrganizationPage(
  db: D1Database,
  organizationId: string,
  afterRowid: number,
  limit: number,
) {
  return db
    .prepare(
      "SELECT rowid AS rid, vectorize_id FROM conversation_chunks WHERE organization_id = ? AND rowid > ? ORDER BY rowid LIMIT ?",
    )
    .bind(organizationId, afterRowid, limit)
    .all<{ rid: number; vectorize_id: string }>();
}

export function deleteOrganizationById(db: D1Database, id: string) {
  return db.batch([
    // FTS delete must come before chunks (subquery references conversation_chunks)
    db.prepare(
      "DELETE FROM chunks_fts_v2 WHERE rowid IN (SELECT fts_rowid FROM conversation_chunks WHERE organization_id = ? AND fts_rowid IS NOT NULL)",
    ).bind(id),
    // CASCADE handles the rest, but explicit deletes are safer for ordering
    db.prepare("DELETE FROM conversation_chunks WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM messages WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM conversation_tags WHERE organization_id = ?").bind(id),
    db.prepare("DELETE FROM conversations WHERE organization_id = ?").bind(id),
    // email_log has no FK (its org_id predates the constraint), so the
    // cascade never touches it — without this line a purged org left its
    // recipient email addresses behind, which is exactly the personal data
    // an erasure request is about. Every other org-linked table cascades.
    db.prepare("DELETE FROM email_log WHERE org_id = ?").bind(id),
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

export function getExpiredOrganizations(db: D1Database, limit = 50) {
  // Bounded per run: a large backlog is worked down over successive nightly
  // runs rather than attempted all at once, so the purge can't blow the
  // worker's CPU/time budget on a bad night and strand everything.
  return db
    .prepare(
      "SELECT id FROM organizations WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days') ORDER BY deleted_at LIMIT ?",
    )
    .bind(limit)
    .all<{ id: string }>();
}

// ── Resumable purge (bounded per run) ────────────────────────────────────
// A large org's data is drained in bounded batches across successive cron runs
// rather than deleted all at once. The old purge attempted a whole org in one
// invocation; a ~6k-message org exceeded the worker's CPU/time budget, threw,
// was caught by the per-org guard, and was skipped EVERY night — so large
// deleted orgs were never actually erased. These helpers let the purge take a
// fixed bite per run and only finalize (drop the org) once nothing remains.

/** A bounded batch of an org's chunk rows, with the ids needed to also remove
 *  their FTS rows and Vectorize vectors. */
export function getChunkPurgeBatch(db: D1Database, organizationId: string, limit: number) {
  return db
    .prepare(
      "SELECT id, vectorize_id, fts_rowid FROM conversation_chunks WHERE organization_id = ? LIMIT ?",
    )
    .bind(organizationId, limit)
    .all<{ id: string; vectorize_id: string | null; fts_rowid: number | null }>();
}

// D1 caps bound parameters per statement (a large IN(...) throws "too many SQL
// variables"). Keep every IN-list statement well under that; the batch itself
// can hold many such statements.
const D1_IN_CHUNK = 90;

function inDeleteStatements<T extends string | number>(
  db: D1Database,
  sqlPrefix: string,
  values: T[],
) {
  const stmts = [];
  for (let i = 0; i < values.length; i += D1_IN_CHUNK) {
    const slice = values.slice(i, i + D1_IN_CHUNK);
    const ph = slice.map(() => "?").join(",");
    stmts.push(db.prepare(`${sqlPrefix} (${ph})`).bind(...slice));
  }
  return stmts;
}

/** Delete a batch of chunk rows AND their FTS index rows in one atomic batch.
 *  IN-lists are chunked to stay under D1's bound-parameter limit.
 *  (Vectorize vectors are deleted separately by the caller — different store.) */
export function deleteChunkRowsAndFts(
  db: D1Database,
  chunkIds: string[],
  ftsRowids: number[],
) {
  const stmts = [
    ...inDeleteStatements(db, "DELETE FROM chunks_fts_v2 WHERE rowid IN", ftsRowids),
    ...inDeleteStatements(db, "DELETE FROM conversation_chunks WHERE id IN", chunkIds),
  ];
  return stmts.length ? db.batch(stmts) : Promise.resolve([]);
}

/** A bounded batch of an org's message rows (id + encoding, so the caller can
 *  purge the R2 body for r2:-encoded messages before dropping the row). */
export function getMessagePurgeBatch(db: D1Database, organizationId: string, limit: number) {
  return db
    .prepare(
      "SELECT id, content_encoding FROM messages WHERE organization_id = ? LIMIT ?",
    )
    .bind(organizationId, limit)
    .all<{ id: string; content_encoding: string | null }>();
}

/** Delete a batch of message rows by id (IN-lists chunked under D1's limit). */
export function deleteMessageRowsByIds(db: D1Database, messageIds: string[]) {
  if (messageIds.length === 0) return Promise.resolve([]);
  return db.batch(inDeleteStatements(db, "DELETE FROM messages WHERE id IN", messageIds));
}

/** How much heavy data (messages, chunks) an org still has — the purge only
 *  finalizes (drops the org + remaining small tables) when both are zero. */
export function countOrgHeavyData(db: D1Database, organizationId: string) {
  return db
    .prepare(
      "SELECT (SELECT COUNT(*) FROM messages WHERE organization_id = ?) AS messages, (SELECT COUNT(*) FROM conversation_chunks WHERE organization_id = ?) AS chunks",
    )
    .bind(organizationId, organizationId)
    .first<{ messages: number; chunks: number }>();
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

/**
 * Recompute an org's denormalized counters from the actual rows. The counters
 * (messages_stored_total, conversation_count) are maintained incrementally, so
 * any operation that moves rows without touching them drifts the counters —
 * most sharply org-merge, which relocated messages and conversations between
 * orgs but never adjusted either side's totals (that's how a merged org ended
 * up ~75k messages undercounted). Setting them to the live COUNT is exact and
 * idempotent, so it both fixes a merge and heals pre-existing drift. Safe to
 * call repeatedly and safe to wire into a periodic reconcile.
 */
export function reconcileOrgCounters(db: D1Database, organizationId: string) {
  return db
    .prepare(
      `UPDATE organizations SET
         messages_stored_total = (SELECT COUNT(*) FROM messages WHERE organization_id = ?),
         conversation_count = (SELECT COUNT(*) FROM conversations WHERE organization_id = ?)
       WHERE id = ?`,
    )
    .bind(organizationId, organizationId, organizationId)
    .run();
}
