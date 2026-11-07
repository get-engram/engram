import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
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

export class DaemonDb {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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

  getConversationId(sessionId: string): string | null {
    const row = this.db
      .prepare("SELECT conversation_id FROM session_map WHERE session_id = ?")
      .get(sessionId) as { conversation_id: string } | undefined;
    return row?.conversation_id ?? null;
  }

  setSessionMap(
    sessionId: string,
    conversationId: string,
    meta: { projectDir?: string; cwd?: string; gitBranch?: string },
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_map
           (session_id, conversation_id, project_dir, cwd, git_branch, created_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        sessionId,
        conversationId,
        meta.projectDir ?? null,
        meta.cwd ?? null,
        meta.gitBranch ?? null,
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

  markSessionExcluded(
    sessionId: string,
    reason: string,
    deletePendingConversationId?: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO excluded_sessions
           (session_id, reason, delete_pending, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(sessionId, reason, deletePendingConversationId ?? null);
  }

  /** Conversations that still need a server-side delete (opt-out arrived
   *  after part of the session had synced). */
  getPendingRemoteDeletes(): Array<{ session_id: string; delete_pending: string }> {
    return this.db
      .prepare(
        "SELECT session_id, delete_pending FROM excluded_sessions WHERE delete_pending IS NOT NULL",
      )
      .all() as Array<{ session_id: string; delete_pending: string }>;
  }

  clearPendingRemoteDelete(sessionId: string): void {
    this.db
      .prepare(
        "UPDATE excluded_sessions SET delete_pending = NULL WHERE session_id = ?",
      )
      .run(sessionId);
  }

  /** Drop every queued (sent or not) local row for a conversation — used when
   *  the user opts a session out. */
  deleteAllForConversation(conversationId: string): number {
    return this.db
      .prepare("DELETE FROM pending_messages WHERE conversation_id = ?")
      .run(conversationId).changes;
  }

  // ── Pending sessions (engram#370) ──

  /** Queue messages for a session that has no conversation yet, recording
   *  the session in the same transaction (latest metadata wins). */
  enqueuePendingSession(
    sessionId: string,
    meta: SessionMeta,
    messages: ParsedMessage[],
  ): void {
    const upsert = this.db.prepare(
      `INSERT INTO pending_sessions (session_id, meta, created_at, updated_at)
       VALUES (?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(session_id)
       DO UPDATE SET meta = excluded.meta, updated_at = excluded.updated_at`,
    );
    this.db.transaction(() => {
      upsert.run(sessionId, JSON.stringify({ ...meta, sessionId }));
      this.enqueue(pendingConversationId(sessionId), messages);
    })();
  }

  /** Sessions still waiting for their conversation, oldest first. A row
   *  whose metadata can't be read still comes back (with placeholder
   *  metadata): its messages must never be stranded by a bad meta blob. */
  getPendingSessions(): Array<{ sessionId: string; meta: SessionMeta }> {
    const rows = this.db
      .prepare(
        "SELECT session_id, meta FROM pending_sessions ORDER BY created_at, session_id",
      )
      .all() as Array<{ session_id: string; meta: string }>;
    return rows.map((r) => ({
      sessionId: r.session_id,
      meta: parseStoredMeta(r.session_id, r.meta),
    }));
  }

  /**
   * Finish a pending session in ONE transaction: record the mapping (when
   * `meta` is given — a fresh create), move its queued messages onto the
   * real conversation, and forget the pending row. A crash can't leave
   * messages under the temporary id with nothing left to retry them.
   * Returns the number of messages moved.
   */
  completePendingSession(
    sessionId: string,
    conversationId: string,
    meta?: { projectDir?: string; cwd?: string; gitBranch?: string },
  ): number {
    return this.db.transaction(() => {
      if (meta) this.setSessionMap(sessionId, conversationId, meta);
      const moved = this.db
        .prepare(
          "UPDATE pending_messages SET conversation_id = ? WHERE conversation_id = ? AND sent_at IS NULL",
        )
        .run(conversationId, pendingConversationId(sessionId)).changes;
      this.db
        .prepare("DELETE FROM pending_sessions WHERE session_id = ?")
        .run(sessionId);
      return moved;
    })();
  }

  /** Drop a pending session and everything queued under its temporary id
   *  (opt-out). Returns the number of messages dropped. */
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

  enqueue(conversationId: string, messages: ParsedMessage[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO pending_messages
         (conversation_id, role, content, tool_call_id, tool_name, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
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
        );
      }
    });

    insertMany(messages);
  }

  /** Get conversation IDs that have unsent messages. */
  getPendingConversationIds(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT conversation_id FROM pending_messages WHERE sent_at IS NULL",
      )
      .all() as { conversation_id: string }[];
    return rows.map((r) => r.conversation_id);
  }

  /** Dequeue up to `limit` unsent messages for a conversation. */
  dequeue(conversationId: string, limit: number): PendingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM pending_messages
         WHERE conversation_id = ? AND sent_at IS NULL
         ORDER BY id ASC LIMIT ?`,
      )
      .all(conversationId, limit) as PendingRow[];
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

  /** Count of unsent messages across all conversations. */
  getPendingCount(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) as c FROM pending_messages WHERE sent_at IS NULL")
        .get() as { c: number }
    ).c;
  }

  // ── Stats ──

  getStats(): {
    trackedFiles: number;
    pendingMessages: number;
    sessionsMapped: number;
  } {
    const files = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM file_offsets")
        .get() as { c: number }
    ).c;
    const pending = (
      this.db
        .prepare(
          "SELECT COUNT(*) as c FROM pending_messages WHERE sent_at IS NULL",
        )
        .get() as { c: number }
    ).c;
    const sessions = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM session_map")
        .get() as { c: number }
    ).c;
    return {
      trackedFiles: files,
      pendingMessages: pending,
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
  if (filePath?.includes("/.claude/projects/")) {
    return {
      sessionId,
      projectDir: claudeProjectDir(filePath),
      host: "claude-code",
      recovered: true,
    };
  }
  if (filePath && /(^|\/)rollout-[^/]*\.jsonl$/.test(filePath)) {
    return { sessionId, projectDir: "", host: "codex", recovered: true };
  }
  return unknownSessionMeta(sessionId);
}
