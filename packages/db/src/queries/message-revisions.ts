/**
 * message_revisions — every superseded body of an edited message.
 *
 * Editing used to overwrite the body in place, destroying the previous
 * wording in D1 and R2 alike. See migration 0041.
 */

export interface MessageRevisionRow {
  id: string;
  message_id: string;
  conversation_id: string;
  organization_id: string;
  revision: number;
  content: string;
  content_encoding: string | null;
  replaced_at: string;
}

/** The revision number to use for the body being superseded right now. */
export async function nextRevisionNumber(
  db: D1Database,
  messageId: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(revision) AS max_rev FROM message_revisions WHERE message_id = ?")
    .bind(messageId)
    .first<{ max_rev: number | null }>();
  return (row?.max_rev ?? 0) + 1;
}

export function insertMessageRevision(
  db: D1Database,
  params: {
    id: string;
    messageId: string;
    conversationId: string;
    organizationId: string;
    revision: number;
    content: string;
    contentEncoding: string | null;
  },
) {
  return db
    .prepare(
      `INSERT INTO message_revisions
         (id, message_id, conversation_id, organization_id, revision, content, content_encoding)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.id,
      params.messageId,
      params.conversationId,
      params.organizationId,
      params.revision,
      params.content,
      params.contentEncoding,
    )
    .run();
}

/** Full history for one message, oldest first. Org-scoped. */
export function listMessageRevisions(
  db: D1Database,
  messageId: string,
  organizationId: string,
) {
  return db
    .prepare(
      `SELECT id, message_id, conversation_id, organization_id, revision,
              content, content_encoding, replaced_at
         FROM message_revisions
        WHERE message_id = ? AND organization_id = ?
        ORDER BY revision ASC`,
    )
    .bind(messageId, organizationId)
    .all<MessageRevisionRow>();
}

/**
 * Revision ids whose bodies live in R2, for the deletion paths. D1 cascades
 * the rows; the objects have to be deleted explicitly or a user's "deleted"
 * text stays in the bucket.
 */
export function getR2RevisionIdsByMessage(db: D1Database, messageId: string) {
  return db
    .prepare(
      "SELECT id FROM message_revisions WHERE message_id = ? AND content_encoding LIKE 'r2:%'",
    )
    .bind(messageId)
    .all<{ id: string }>();
}

export function getR2RevisionIdsByConversation(
  db: D1Database,
  conversationId: string,
  organizationId: string,
) {
  return db
    .prepare(
      `SELECT id FROM message_revisions
        WHERE conversation_id = ? AND organization_id = ?
          AND content_encoding LIKE 'r2:%'`,
    )
    .bind(conversationId, organizationId)
    .all<{ id: string }>();
}

/** One bounded page of an org's revision rows, for the purge cron. */
export function getRevisionPurgeBatch(
  db: D1Database,
  organizationId: string,
  limit: number,
) {
  return db
    .prepare(
      `SELECT id, content_encoding FROM message_revisions
        WHERE organization_id = ? LIMIT ?`,
    )
    .bind(organizationId, limit)
    .all<{ id: string; content_encoding: string | null }>();
}

/**
 * D1 accepts at most 100 bound parameters per statement, so the id list is
 * chunked. An unchunked IN(...) of a purge batch is exactly the bug that made
 * the nightly token prune throw `too many SQL variables` every night for two
 * nights while reporting nothing (engram#483).
 */
const D1_IN_CHUNK = 90;

export function deleteRevisionRowsByIds(db: D1Database, ids: string[]) {
  if (ids.length === 0) return Promise.resolve([]);
  const stmts = [];
  for (let i = 0; i < ids.length; i += D1_IN_CHUNK) {
    const slice = ids.slice(i, i + D1_IN_CHUNK);
    const ph = slice.map(() => "?").join(",");
    stmts.push(
      db.prepare(`DELETE FROM message_revisions WHERE id IN (${ph})`).bind(...slice),
    );
  }
  return db.batch(stmts);
}
