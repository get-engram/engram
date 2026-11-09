import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createPrivateFileSync, PRIVATE_DIR_MODE, restrictSync } from "../private-files.js";
import { claudeProjectDir } from "./parser.js";
import type { ParsedMessage, PendingRow, SessionMeta } from "./types.js";

/** Queue id for messages whose conversation doesn't exist yet. */
export function pendingConversationId(sessionId: string): string {
  return `pending:${sessionId}`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS file_offsets (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session_map (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_dir TEXT,
  cwd TEXT,
  git_branch TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_unsent
  ON pending_messages(conversation_id) WHERE sent_at IS NULL;

-- Sessions the user opted out of ("don't save this to engram"). Once a row
-- exists, the syncer drops every future message for the session. If part of
-- the session had already synced, delete_pending holds the server-side
-- conversation id until the remote delete succeeds (it must survive the
-- daemon being offline or restarted — "don't save this" is a promise).
CREATE TABLE IF NOT EXISTS excluded_sessions (
  session_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  delete_pending TEXT,
  created_at TEXT NOT NULL
);

-- Sessions whose conversation hasn't been created on the server yet
-- (engram#370). Their messages wait in pending_messages under
-- 'pending:<session_id>'. A row here is written in the same transaction as
-- those messages and removed in the same transaction that moves them onto
-- the real conversation, so neither a restart nor a failed create can
-- strand them: the flush loop retries every row here until it lands.
CREATE TABLE IF NOT EXISTS pending_sessions (
  session_id TEXT PRIMARY KEY,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Schema version 1 (engram#594): every queued capture, session mapping and
 * pending remote delete records WHICH API key it belongs to, so a capture
 * queued while one account was signed in is never sent with another
 * account's key.
 *
 * key_fp is the SHA-256 hex of the key, the same hash the server keeps in
 * api_keys.key_hash; the key itself is never stored here. NULL or '' means
 * "no key": a row from before version 1, or one queued while signed out.
 * The next key the daemon runs with claims those (claimLegacy).
 *
 * session_map is rebuilt with the conversation id as its key, because one
 * transcript session can now have a conversation in each account that
 * captured part of it, and an opt-out has to find every one of them.
 */
const SESSION_MAP_V1 = `
CREATE TABLE session_map_v1 (
  conversation_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  key_fp TEXT NOT NULL DEFAULT '',
  project_dir TEXT,
  cwd TEXT,
  git_branch TEXT,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO session_map_v1
  (conversation_id, session_id, key_fp, project_dir, cwd, git_branch, created_at)
  SELECT conversation_id, session_id, '', project_dir, cwd, git_branch, created_at
    FROM session_map ORDER BY created_at, rowid;
DROP TABLE session_map;
ALTER TABLE session_map_v1 RENAME TO session_map;
`;

const SCHEMA_V1 = `
CREATE INDEX IF NOT EXISTS idx_session_map_session
  ON session_map(session_id, key_fp);

CREATE INDEX IF NOT EXISTS idx_pending_unsent_key
  ON pending_messages(key_fp, conversation_id) WHERE sent_at IS NULL;

-- Conversations to delete on the server because their session was opted
-- out (engram#462), each under the key of the account that holds it. A
-- delete is only ever sent with that account's key; one for an account
-- that isn't signed in waits here until it is.
CREATE TABLE IF NOT EXISTS remote_deletes (
  conversation_id TEXT PRIMARY KEY,
  key_fp TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);
`;

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

/** Bring a daemon.db up to version 1 in ONE transaction: a crash part-way
 *  leaves it at version 0, exactly as it was, and the next start retries. */
function migrate(db: Database.Database): void {
  db.transaction(() => {
    if ((db.pragma("user_version", { simple: true }) as number) >= 1) return;
    if (!hasColumn(db, "pending_messages", "key_fp")) {
      db.exec("ALTER TABLE pending_messages ADD COLUMN key_fp TEXT");
    }
    if (!hasColumn(db, "session_map", "key_fp")) db.exec(SESSION_MAP_V1);
    db.exec(SCHEMA_V1);
    db.pragma("user_version = 1");
  }).immediate();
}

type SessionPlace = { projectDir?: string; cwd?: string; gitBranch?: string };

export class DaemonDb {
  private db: Database.Database;
  /** False only for a read-only open of a daemon.db that an older daemon
   *  still owns (no key_fp yet). That daemon sends every queued row with
   *  its own key, so they all count as pending, none as held. */
  private keyed: boolean;

  /**
   * `readonly` is for the CLI reading a daemon's database while the daemon
   * runs: it changes nothing (no schema, no migration, no -wal file of its
   * own making) and throws instead of creating a file that isn't there.
   */
  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    if (options.readonly) {
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.keyed = hasColumn(this.db, "pending_messages", "key_fp");
      return;
    }
    // The queue holds captured transcript text, so its files are the
    // user's alone (engram#627). The database file is created 0600 before
    // SQLite opens it, and SQLite gives the -wal and -shm files it creates
    // the database file's mode. Files from before the fix are set to 0600
    // first. By path on purpose: opening and closing the database file
    // here would drop locks this process holds on it through SQLite.
    mkdirSync(dirname(dbPath), { recursive: true, mode: PRIVATE_DIR_MODE });
    createPrivateFileSync(dbPath);
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) restrictSync(file);
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    migrate(this.db);
    this.keyed = true;
  }

  // ── File offsets ──

  getFileOffset(filePath: string): number {
    const row = this.db
      .prepare("SELECT byte_offset FROM file_offsets WHERE file_path = ?")
      .get(filePath) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? 0;
  }

  setFileOffset(filePath: string, offset: number): void {
    this.db
      .prepare(
        `INSERT INTO file_offsets (file_path, byte_offset, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(file_path)
         DO UPDATE SET byte_offset = excluded.byte_offset, updated_at = excluded.updated_at`,
      )
      .run(filePath, offset);
  }

  // ── Session map ──

  /** The session's conversation in the account `keyFp` belongs to (the
   *  newest, if more than one was ever created there). */
  getConversationId(sessionId: string, keyFp: string): string | null {
    const row = this.db
      .prepare(
        `SELECT conversation_id FROM session_map
          WHERE session_id = ? AND key_fp = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(sessionId, keyFp) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  setSessionMap(
    sessionId: string,
    conversationId: string,
    meta: SessionPlace,
    keyFp: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_map
           (conversation_id, session_id, key_fp, project_dir, cwd, git_branch, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        conversationId,
        sessionId,
        keyFp,
        meta.projectDir ?? null,
        meta.cwd ?? null,
        meta.gitBranch ?? null,
      );
  }

  /** True when the session already has a conversation under a key other
   *  than `keyFp` — one that may turn out to be the same account's. */
  mappedUnderOtherKey(sessionId: string, keyFp: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM session_map WHERE session_id = ? AND key_fp <> ? LIMIT 1")
        .get(sessionId, keyFp) !== undefined
    );
  }

  // ── Excluded sessions (engram#462) ──

  isSessionExcluded(sessionId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM excluded_sessions WHERE session_id = ?")
        .get(sessionId) !== undefined
    );
  }

  /** Record the opt-out. An existing row is kept as it is: a delete it still
   *  carries from before version 1 is claimed later (claimLegacy). */
  markSessionExcluded(sessionId: string, reason: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO excluded_sessions
           (session_id, reason, delete_pending, created_at)
         VALUES (?, ?, NULL, datetime('now'))`,
      )
      .run(sessionId, reason);
  }

  /** Conversations still to delete on the server with the key `keyFp`
   *  (the opt-out arrived after part of the session had synced), oldest
   *  first. */
  getPendingRemoteDeletes(
    keyFp: string,
  ): Array<{ conversation_id: string; session_id: string | null }> {
    return this.db
      .prepare(
        `SELECT conversation_id, session_id FROM remote_deletes
          WHERE key_fp = ? ORDER BY created_at, rowid`,
      )
      .all(keyFp) as Array<{ conversation_id: string; session_id: string | null }>;
  }

  clearPendingRemoteDelete(conversationId: string): void {
    this.db
      .prepare("DELETE FROM remote_deletes WHERE conversation_id = ?")
      .run(conversationId);
  }

  /**
   * Drop every local row for a conversation, sent or not — used when the
   * user opts a session out. Returns how many of them had never been sent
   * (engram#628): a sent row is only this machine's record of a message the
   * server already has, and counting those told the user that messages
   * were dropped before they could be sent when none were.
   */
  deleteAllForConversation(conversationId: string): number {
    return this.db.transaction(() => {
      const { c: unsent } = this.db
        .prepare("SELECT COUNT(*) AS c FROM pending_messages WHERE conversation_id = ? AND sent_at IS NULL")
        .get(conversationId) as { c: number };
      this.db.prepare("DELETE FROM pending_messages WHERE conversation_id = ?").run(conversationId);
      return unsent;
    })();
  }

  /**
   * Opt a session out on this machine, in ONE transaction (engram#584):
   * mark it excluded, record a server-side delete for its conversation in
   * EVERY account that has one (each under that account's key), and drop
   * everything queued for it, whichever key it was queued under. Returns
   * those conversations and how many of the messages dropped had never been
   * sent.
   *
   * As separate steps, a failure part-way could mark the session excluded
   * and leave its queue in place, still due to be sent. Nothing would ever
   * drop it: an excluded session returns before the drop is reached.
   */
  excludeSession(
    sessionId: string,
    reason: string,
  ): { conversations: Array<{ conversationId: string; keyFp: string }>; dropped: number } {
    return this.db.transaction(() => {
      this.markSessionExcluded(sessionId, reason);
      const conversations = (
        this.db
          .prepare(
            "SELECT conversation_id, key_fp FROM session_map WHERE session_id = ? ORDER BY rowid",
          )
          .all(sessionId) as Array<{ conversation_id: string; key_fp: string }>
      ).map((r) => ({ conversationId: r.conversation_id, keyFp: r.key_fp }));
      const remember = this.db.prepare(
        `INSERT OR IGNORE INTO remote_deletes (conversation_id, key_fp, session_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      );
      let dropped = this.dropPendingSession(sessionId);
      for (const c of conversations) {
        remember.run(c.conversationId, c.keyFp || null, sessionId);
        dropped += this.deleteAllForConversation(c.conversationId);
      }
      return { conversations, dropped };
    })();
  }

  /** A create that was in flight when its session was opted out: delete
   *  the new conversation on the server (with the key that created it) and
   *  drop whatever is queued for the session, in ONE transaction. */
  excludeCreatedConversation(sessionId: string, conversationId: string, keyFp: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO remote_deletes (conversation_id, key_fp, session_id, created_at)
           VALUES (?, ?, ?, datetime('now'))`,
        )
        .run(conversationId, keyFp, sessionId);
      this.dropPendingSession(sessionId);
      this.deleteAllForConversation(conversationId);
    })();
  }

  // ── Pending sessions (engram#370) ──

  /** Queue messages for a session that has no conversation yet, recording
   *  the session in the same transaction (latest metadata wins). */
  enqueuePendingSession(
    sessionId: string,
    meta: SessionMeta,
    messages: ParsedMessage[],
    keyFp: string | null,
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO pending_sessions (session_id, meta, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(session_id)
       DO UPDATE SET meta = excluded.meta, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      upsert.run(sessionId, JSON.stringify({ ...meta, sessionId }));
      this.enqueue(pendingConversationId(sessionId), messages, keyFp);
    })();
  }

  /** Sessions waiting for their conversation that have messages queued
   *  under `keyFp`, oldest first. A row whose metadata can't be read still
   *  comes back (with placeholder metadata): its messages must never be
   *  stranded by a bad meta blob. */
  getPendingSessions(keyFp: string | null): Array<{ sessionId: string; meta: SessionMeta }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, meta FROM pending_sessions ps
          WHERE EXISTS (
            SELECT 1 FROM pending_messages pm
             WHERE pm.sent_at IS NULL AND pm.key_fp IS ?
               AND pm.conversation_id = 'pending:' || ps.session_id)
          ORDER BY created_at, session_id`,
      )
      .all(keyFp) as Array<{ session_id: string; meta: string }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      meta: parseStoredMeta(r.session_id, r.meta),
    }));
  }

  /**
   * Finish a pending session for one account in ONE transaction: record the
   * mapping (when `meta` is given — a fresh create), move the messages
   * queued under `keyFp` onto the real conversation, and forget the
   * pending row once nothing is left under the temporary id. Messages
   * another key queued for the same session stay where they are, for that
   * account. A crash can't leave messages under the temporary id with
   * nothing left to retry them. Returns the number of messages moved.
   */
  completePendingSession(
    sessionId: string,
    conversationId: string,
    keyFp: string,
    meta?: SessionPlace,
  ): number {
    return this.db.transaction(() => {
      if (meta) this.setSessionMap(sessionId, conversationId, meta, keyFp);
      const pendingId = pendingConversationId(sessionId);
      const moved = this.db
        .prepare(
          `UPDATE pending_messages SET conversation_id = ?
            WHERE conversation_id = ? AND sent_at IS NULL AND key_fp = ?`,
        )
        .run(conversationId, pendingId, keyFp).changes;
      const left = this.db
        .prepare(
          "SELECT 1 FROM pending_messages WHERE conversation_id = ? AND sent_at IS NULL LIMIT 1",
        )
        .get(pendingId);
      if (left === undefined) {
        this.db.prepare("DELETE FROM pending_sessions WHERE session_id = ?").run(sessionId);
      }
      return moved;
    })();
  }

  /** Drop a pending session and everything queued under its temporary id
   *  (opt-out). Returns how many of those messages had never been sent. */
  dropPendingSession(sessionId: string): number {
    return this.db.transaction(() => {
      const dropped = this.deleteAllForConversation(
        pendingConversationId(sessionId),
      );
      this.db
        .prepare("DELETE FROM pending_sessions WHERE session_id = ?")
        .run(sessionId);
      return dropped;
    })();
  }

  /**
   * Messages queued under 'pending:<id>' with no pending_sessions row —
   * left by a daemon older than engram#370, whose session record lived only
   * in memory and died with that process. Give each such session a row so
   * the flush loop creates its conversation like any other; the metadata is
   * rebuilt from the transcript path when daemon.db still tracks one.
   * Returns the adopted session ids.
   */
  adoptOrphanedPendingRows(): string[] {
    const orphans = this.db
      .prepare(
        `SELECT DISTINCT substr(conversation_id, 9) AS session_id
           FROM pending_messages
          WHERE sent_at IS NULL
            AND substr(conversation_id, 1, 8) = 'pending:'
            AND substr(conversation_id, 9) NOT IN (SELECT session_id FROM pending_sessions)`,
      )
      .all() as Array<{ session_id: string }>;
    if (orphans.length === 0) return [];

    const candidates = this.db.prepare(
      "SELECT file_path FROM file_offsets WHERE instr(file_path, ?) > 0 ORDER BY updated_at DESC",
    );
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pending_sessions (session_id, meta, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))`,
    );
    this.db.transaction(() => {
      for (const { session_id } of orphans) {
        const paths = session_id
          ? (candidates.all(session_id) as Array<{ file_path: string }>).map(
              (r) => r.file_path,
            )
          : [];
        const filePath = paths.find((p) => isTranscriptOf(p, session_id));
        insert.run(session_id, JSON.stringify(recoveredSessionMeta(session_id, filePath)));
      }
    })();
    return orphans.map((o) => o.session_id);
  }

  // ── Pending messages ──

  /** Queue messages under the key of the account signed in when they were
   *  captured (`null`: none was). */
  enqueue(conversationId: string, messages: ParsedMessage[], keyFp: string | null): void {
    const stmt = this.db.prepare(
      `INSERT INTO pending_messages
         (conversation_id, role, content, tool_call_id, tool_name, metadata, created_at, key_fp)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)`,
    );

    const insertMany = this.db.transaction((msgs: ParsedMessage[]) => {
      for (const m of msgs) {
        stmt.run(
          conversationId,
          m.role,
          m.content,
          m.toolCallId ?? null,
          m.toolName ?? null,
          m.metadata ? JSON.stringify(m.metadata) : null,
          keyFp,
        );
      }
    });

    insertMany(messages);
  }

  /** Conversation ids with unsent messages queued under `keyFp`. */
  getPendingConversationIds(keyFp: string | null): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT conversation_id FROM pending_messages WHERE sent_at IS NULL AND key_fp IS ?",
      )
      .all(keyFp) as { conversation_id: string }[];
    return rows.map((r) => r.conversation_id);
  }

  /** Dequeue up to `limit` unsent messages a conversation has under `keyFp`. */
  dequeue(conversationId: string, limit: number, keyFp: string | null): PendingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pending_messages
         WHERE conversation_id = ? AND sent_at IS NULL AND key_fp IS ?
         ORDER BY id ASC LIMIT ?`,
      )
      .all(conversationId, keyFp, limit) as PendingRow[];
  }

  /** Replace queued messages' content with its scrubbed text (engram#588). */
  updateContents(rows: Array<{ id: number; content: string }>): void {
    if (rows.length === 0) return;
    const stmt = this.db.prepare("UPDATE pending_messages SET content = ? WHERE id = ?");
    this.db.transaction((rs: Array<{ id: number; content: string }>) => {
      for (const r of rs) stmt.run(r.content, r.id);
    })(rows);
  }

  markSent(ids: number[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(
        `UPDATE pending_messages SET sent_at = datetime('now')
         WHERE id IN (${placeholders})`,
      )
      .run(...ids);
  }

  /** Unsent messages queued under `keyFp`; every unsent message when no
   *  key is given. */
  getPendingCount(keyFp?: string): number {
    if (keyFp === undefined || !this.keyed) return this.count("1 = 1");
    return this.count("key_fp IS ?", keyFp);
  }

  /** Unsent messages waiting for an account other than `keyFp` (`null`:
   *  every unsent message — nobody is signed in to send them). */
  getHeldCount(keyFp: string | null): number {
    if (!this.keyed) return 0;
    if (keyFp === null) return this.count("1 = 1");
    return this.count("key_fp IS NOT ?", keyFp);
  }

  private count(where: string, ...params: Array<string | null>): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS c FROM pending_messages WHERE sent_at IS NULL AND ${where}`)
        .get(...params) as { c: number }
    ).c;
  }

  // ── Which key a queued row belongs to (engram#594) ──

  /** Every other key something here is queued or mapped under. */
  otherKeyFps(keyFp: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT key_fp FROM pending_messages
            WHERE sent_at IS NULL AND key_fp IS NOT NULL AND key_fp <> '' AND key_fp <> ?
           UNION
           SELECT key_fp FROM session_map WHERE key_fp <> '' AND key_fp <> ?
           UNION
           SELECT key_fp FROM remote_deletes
            WHERE key_fp IS NOT NULL AND key_fp <> '' AND key_fp <> ?`,
        )
        .all(keyFp, keyFp, keyFp) as Array<{ key_fp: string }>
    ).map((r) => r.key_fp);
  }

  /** Hand everything queued or mapped under `fromFps` to `toFp`, in ONE
   *  transaction — for keys the server confirmed are the same account's
   *  (a rotated or re-issued key). */
  adoptKeys(
    fromFps: string[],
    toFp: string,
  ): { messages: number; sessions: number; deletes: number } {
    const messagesStmt = this.db.prepare(
      "UPDATE pending_messages SET key_fp = ? WHERE sent_at IS NULL AND key_fp = ?",
    );
    const sessionsStmt = this.db.prepare("UPDATE session_map SET key_fp = ? WHERE key_fp = ?");
    const deletesStmt = this.db.prepare("UPDATE remote_deletes SET key_fp = ? WHERE key_fp = ?");
    return this.db.transaction(() => {
      const moved = { messages: 0, sessions: 0, deletes: 0 };
      for (const from of new Set(fromFps)) {
        if (!from || from === toFp) continue;
        moved.messages += messagesStmt.run(toFp, from).changes;
        moved.sessions += sessionsStmt.run(toFp, from).changes;
        moved.deletes += deletesStmt.run(toFp, from).changes;
      }
      return moved;
    })();
  }

  /**
   * Give `keyFp` everything that belongs to no key: rows from before
   * version 1 and rows queued while signed out, the session mappings from
   * before version 1, and the opt-out deletes an older daemon left in
   * excluded_sessions. ONE transaction.
   */
  claimLegacy(keyFp: string): void {
    this.db.transaction(() => {
      // Two statements so each is an index search, not a scan of the queue.
      this.db
        .prepare("UPDATE pending_messages SET key_fp = ? WHERE sent_at IS NULL AND key_fp IS NULL")
        .run(keyFp);
      this.db
        .prepare("UPDATE pending_messages SET key_fp = ? WHERE sent_at IS NULL AND key_fp = ''")
        .run(keyFp);
      this.db.prepare("UPDATE session_map SET key_fp = ? WHERE key_fp = ''").run(keyFp);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO remote_deletes (conversation_id, key_fp, session_id, created_at)
           SELECT delete_pending, ?, session_id, created_at
             FROM excluded_sessions WHERE delete_pending IS NOT NULL`,
        )
        .run(keyFp);
      this.db
        .prepare("UPDATE excluded_sessions SET delete_pending = NULL WHERE delete_pending IS NOT NULL")
        .run();
      this.db
        .prepare("UPDATE remote_deletes SET key_fp = ? WHERE key_fp IS NULL OR key_fp = ''")
        .run(keyFp);
    })();
  }

  // ── Stats ──

  /**
   * `pendingMessages` are the unsent messages `keyFp` will send, and
   * `heldMessages` the ones waiting for another account. No `keyFp`: every
   * unsent message is pending. `null`: nobody is signed in, so every unsent
   * message is held.
   */
  getStats(keyFp?: string | null): {
    trackedFiles: number;
    pendingMessages: number;
    heldMessages: number;
    sessionsMapped: number;
  } {
    const files = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM file_offsets")
        .get() as { c: number }
    ).c;
    const sessions = (
      this.db
        .prepare("SELECT COUNT(DISTINCT session_id) as c FROM session_map")
        .get() as { c: number }
    ).c;
    let pending: number;
    let held: number;
    if (keyFp === undefined || !this.keyed) {
      pending = this.getPendingCount();
      held = 0;
    } else if (keyFp === null) {
      pending = 0;
      held = this.getHeldCount(null);
    } else {
      pending = this.getPendingCount(keyFp);
      held = this.getHeldCount(keyFp);
    }
    return {
      trackedFiles: files,
      pendingMessages: pending,
      heldMessages: held,
      sessionsMapped: sessions,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Placeholder metadata for a session whose own was lost. */
function unknownSessionMeta(sessionId: string): SessionMeta {
  return { sessionId, projectDir: "", recovered: true };
}

function parseStoredMeta(sessionId: string, raw: string): SessionMeta {
  try {
    const meta = JSON.parse(raw) as unknown;
    if (
      meta &&
      typeof meta === "object" &&
      typeof (meta as SessionMeta).projectDir === "string"
    ) {
      return { ...(meta as SessionMeta), sessionId };
    }
  } catch {
    // fall through to the placeholder
  }
  return unknownSessionMeta(sessionId);
}

/** True when `filePath` is the transcript file named for `sessionId`:
 *  Claude Code writes `<id>.jsonl`, Codex `rollout-<time>-<id>.jsonl`. */
function isTranscriptOf(filePath: string, sessionId: string): boolean {
  const name = basename(filePath);
  return name === `${sessionId}.jsonl` || name.endsWith(`-${sessionId}.jsonl`);
}

/**
 * Best-effort metadata for an orphaned session (engram#370). The transcript
 * path tells us the host and, for Claude Code, the project; anything we
 * can't tell stays empty (the conversation is titled by host). Exported for
 * tests.
 */
export function recoveredSessionMeta(
  sessionId: string,
  filePath: string | undefined,
): SessionMeta {
  // One separator for the checks below: Windows paths use backslashes
  // (engram#602).
  const normalized = filePath?.replace(/\\/g, "/");
  if (filePath && normalized?.includes("/.claude/projects/")) {
    return {
      sessionId,
      projectDir: claudeProjectDir(filePath),
      host: "claude-code",
      recovered: true,
    };
  }
  if (normalized && /(^|\/)rollout-[^/]*\.jsonl$/.test(normalized)) {
    return { sessionId, projectDir: "", host: "codex", recovered: true };
  }
  return unknownSessionMeta(sessionId);
}
