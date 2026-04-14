/** Message parsed from a Claude Code JSONL transcript line. */
export interface ParsedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}

/** Metadata extracted from the first line of a Claude Code session. */
export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  projectDir: string;
  version?: string;
}

/** Row from the pending_messages table. */
export interface PendingRow {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  metadata: string | null;
  created_at: string;
}

/** Stats returned by `engram status`. */
export interface DaemonStats {
  running: boolean;
  pid: number | null;
  trackedFiles: number;
  pendingMessages: number;
  sessionsMapped: number;
}
