import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ParsedMessage, PendingRow } from "./types.js";

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
