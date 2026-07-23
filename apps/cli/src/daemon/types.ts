/** Message parsed from a Claude Code JSONL transcript line. */
export interface ParsedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  metadata?: Record<string, unknown>;
}

/** Metadata extracted from a captured session (any host). */
export interface SessionMeta {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  projectDir: string;
  version?: string;
  /** Host that produced the session (engram#261): "claude-code", "codex". */
  host?: string;
}

/** Emits fully-parsed messages for a session as they complete. */
export type OnMessages = (
  sessionId: string,
  meta: SessionMeta,
  messages: ParsedMessage[],
) => void;

/**
 * A per-line transcript parser for one host format (engram#261). The
 * watcher feeds it complete lines from a session file; it emits messages
 * via the OnMessages callback it was constructed with.
 */
export interface LineParser {
  processLine(line: string, filePath: string): void;
  /** Flush any buffered partial message (e.g. a multi-block assistant turn). */
  flush(): void;
}

/**
 * A capturable host (engram#261). Each adapter knows where its host
 * writes session transcripts and how to parse them. New hosts plug in
 * by adding an adapter — the watcher/syncer are host-agnostic.
 */
export interface HostAdapter {
  /** Stable id, used as the conversation agent_id + tag. */
  id: string;
  /** Human label for status output. */
  label: string;
  /** Directory watched recursively for *.jsonl session files. */
  watchDir: string;
  /** True when this host is actually installed (watchDir exists). */
  available(): boolean;
  /** Build a parser bound to this sync callback. */
  createParser(onMessages: OnMessages): LineParser;
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
