/**
 * How far an import got (engram#751), recorded on the conversation in the
 * same batch as the messages that got it there.
 *
 * `engram import` sends each conversation's messages in batches and puts
 * `import_cursor` in the metadata of each batch's last message:
 * `{ v: 1, next, digest }`. `next` is how many of the source conversation's
 * messages are stored once that batch is; `digest` is a SHA-256 of those
 * messages' roles and lengths, never their words (the CLI's ImportDigest
 * says why: a hash of the text, kept beside the [VAULT:…] and [REDACTED]
 * stand-ins, would let anyone who can read the conversation test guesses
 * at a short secret). appendMessages takes it off the message and writes it
 * to the conversation's metadata in the batch that stores the messages, so
 * it is recorded exactly when they are. A re-run reads it and sends only
 * the rest, and only while the file still begins with what was sent.
 *
 * A batch is stored only where the import is: it must start at the cursor
 * recorded on the conversation or, before there is one, at its message
 * count. One planned before something else added to the conversation (the
 * same batch sent again, or a second import of the same file running at
 * the same time) is refused whole, so an import never stores a message
 * twice.
 *
 * A count of stored messages can't stand in for the cursor: deleting a
 * message lowers message_count, so a re-run that trusted the count would
 * send a message twice, or bring back one the user deleted.
 */

export const IMPORT_CURSOR_KEY = "import_cursor";

export interface ImportCursor {
  v: 1;
  /** How many of the source conversation's messages are stored. */
  next: number;
  /** SHA-256, hex, of those messages' roles and lengths, never their words. */
  digest: string;
}

const DIGEST = /^[0-9a-f]{64}$/;

/** A cursor exactly as the CLI writes it, or null for anything else. */
export function parseImportCursor(value: unknown): ImportCursor | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (typeof c.next !== "number" || !Number.isSafeInteger(c.next) || c.next < 1) return null;
  if (typeof c.digest !== "string" || !DIGEST.test(c.digest)) return null;
  return { v: 1, next: c.next, digest: c.digest };
}

/**
 * Take import_cursor off every message. It describes the conversation, not
 * a message, so it never stays in a message's metadata. Only the batch's
 * last message may carry one, since only it marks the point every message
 * of the batch is stored by; a cursor anywhere else is dropped, as is one
 * that isn't exactly the CLI's shape, or that counts fewer messages than
 * the batch it ends (no batch can end there).
 */
export function takeImportCursor<T extends { metadata?: Record<string, unknown> }>(
  messages: T[],
): { messages: T[]; cursor: ImportCursor | null } {
  let cursor: ImportCursor | null = null;
  const taken = messages.map((m, i) => {
    if (!m.metadata || !Object.prototype.hasOwnProperty.call(m.metadata, IMPORT_CURSOR_KEY)) return m;
    const { [IMPORT_CURSOR_KEY]: value, ...rest } = m.metadata;
    if (i === messages.length - 1) {
      const parsed = parseImportCursor(value);
      if (parsed && parsed.next >= messages.length) cursor = parsed;
    }
    return { ...m, metadata: rest };
  });
  return { messages: taken, cursor };
}

/**
 * Whether an import's batch starting at the source conversation's `from`th
 * message starts where the conversation's import is: at the cursor
 * recorded on it or, where none is, at its message count. `conversation`
 * is its row as D1 returns it, read before the batch. Where the row's
 * metadata isn't a JSON object, no cursor can be recorded on it, so none
 * is checked: the same rules as recordImportCursorStatement's.
 */
export function importStartsAt(conversation: Record<string, unknown>, from: number): boolean {
  const raw = conversation.metadata;
  let metadata: unknown;
  try {
    metadata = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return true;
  }
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const recorded = (metadata as Record<string, unknown>)[IMPORT_CURSOR_KEY];
  const next =
    recorded !== null && typeof recorded === "object" && !Array.isArray(recorded)
      ? (recorded as Record<string, unknown>).next
      : undefined;
  return Number.isSafeInteger(next) ? next === from : conversation.message_count === from;
}

/**
 * The statement that records `cursor` on the conversation, last in the
 * append's batch, after the statements that store and count its messages.
 * The batch starts at the source conversation's `from`th message.
 *
 * It is also the batch's own check that it starts where the import is:
 * where the recorded cursor's `next` (or, with none recorded, the count
 * before this batch: the count now, less the batch) isn't `from`, it
 * raises an error, and the whole batch, messages and all, is undone.
 * appendMessages makes the same check before it stores anything
 * (importStartsAt); this one catches a batch that got in between. An
 * import_cursor without a whole-number `next` isn't one the CLI wrote, so
 * it counts as none, and is replaced.
 *
 * Where the conversation's metadata isn't a JSON object, it matches no row
 * and the append still commits: a cursor can go unrecorded, but it never
 * costs the messages it came with. The WHERE clause reaches the JSON
 * functions only through json_valid, because they raise an error on
 * malformed JSON; the only error this statement means to raise is json()
 * of the text 'import_moved'.
 */
export function recordImportCursorStatement(
  db: D1Database,
  conversationId: string,
  organizationId: string,
  cursor: ImportCursor,
  from: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE conversations
          SET metadata = json_set(metadata, '$.import_cursor', json(
                CASE WHEN CASE WHEN json_type(metadata, '$.import_cursor.next') = 'integer'
                               THEN json_extract(metadata, '$.import_cursor.next') = ?
                               ELSE message_count = ? END
                     THEN ? ELSE 'import_moved' END))
        WHERE id = ? AND organization_id = ?
          AND CASE WHEN json_valid(metadata) THEN json_type(metadata) = 'object' ELSE 0 END`,
    )
    .bind(from, cursor.next, JSON.stringify(cursor), conversationId, organizationId);
}
