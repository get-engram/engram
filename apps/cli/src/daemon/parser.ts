import type { ParsedMessage, SessionMeta } from "./types.js";

// Line types we skip entirely
const SKIP_TYPES = new Set([
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "last-prompt",
]);

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  signature?: string;
}

interface JsonlLine {
  type: string;
  message?: {
    id?: string;
    role?: string;
    content?: string | ContentBlock[];
    stop_reason?: string | null;
  };
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  subtype?: string;
}

/** Accumulator for multi-block assistant messages. */
interface PendingAssistant {
  messageId: string;
  textParts: string[];
  toolUses: { name: string; input: unknown }[];
}

export type OnMessages = (
  sessionId: string,
  meta: SessionMeta,
  messages: ParsedMessage[],
) => void;

/**
 * Parses Claude Code JSONL transcript lines into Engram messages.
 *
 * Claude Code writes one line per content block, so a single assistant
 * response may span multiple lines sharing the same `message.id`. We
 * accumulate blocks and flush when the message is complete (stop_reason
 * is set) or a new message begins.
 */
export class Parser {
  private pending: PendingAssistant | null = null;
  private lastSessionId: string | null = null;
  private lastMeta: SessionMeta | null = null;
  private onMessages: OnMessages;

  constructor(onMessages: OnMessages) {
    this.onMessages = onMessages;
  }

  processLine(line: string, filePath: string): void {
    let data: JsonlLine;
    try {
      data = JSON.parse(line);
    } catch {
      return; // malformed line, skip
    }

    // Skip noise
    if (SKIP_TYPES.has(data.type)) return;
    if (data.type === "system" && data.subtype) return; // turn_duration etc.

    // Extract session metadata
    const sessionId = data.sessionId;
    if (!sessionId) return;

    const projectDir = this.extractProjectDir(filePath);
    const meta: SessionMeta = {
      sessionId,
      cwd: data.cwd,
      gitBranch: data.gitBranch,
      projectDir,
      version: data.version,
    };
    this.lastSessionId = sessionId;
    this.lastMeta = meta;

    if (!data.message) return;

    if (data.type === "user") {
      // Flush any pending assistant message first
      this.flushPending();
      this.processUserLine(sessionId, meta, data);
    } else if (data.type === "assistant") {
      this.processAssistantLine(sessionId, meta, data);
    }
  }

  /** Flush any remaining accumulated assistant message. */
  flush(): void {
    this.flushPending();
  }

  private processUserLine(
    sessionId: string,
    meta: SessionMeta,
    data: JsonlLine,
  ): void {
    const content = data.message!.content;

    if (typeof content === "string") {
      // Plain user text
      if (content.trim()) {
        this.onMessages(sessionId, meta, [
          { role: "user", content },
        ]);
      }
      return;
    }

    // Array content — could contain tool_result blocks
    if (!Array.isArray(content)) return;

    const messages: ParsedMessage[] = [];
    for (const block of content) {
      if (block.type === "tool_result") {
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        if (text.trim()) {
          messages.push({
            role: "tool",
            content: text,
            toolCallId: block.tool_use_id,
          });
        }
      }
    }

    if (messages.length > 0) {
      this.onMessages(sessionId, meta, messages);
    }
  }

  private processAssistantLine(
    sessionId: string,
    meta: SessionMeta,
    data: JsonlLine,
  ): void {
    const msg = data.message!;
    const messageId = msg.id ?? "";
    const content = msg.content;

    // If this is a new message ID, flush the previous one
    if (this.pending && this.pending.messageId !== messageId) {
      this.flushPending();
    }

    // Initialize accumulator if needed
    if (!this.pending) {
      this.pending = { messageId, textParts: [], toolUses: [] };
    }

    // Accumulate content blocks
    if (typeof content === "string") {
      if (content.trim()) {
        this.pending.textParts.push(content);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          this.pending.textParts.push(block.text);
        } else if (block.type === "tool_use" && block.name) {
          this.pending.toolUses.push({
            name: block.name,
            input: block.input,
          });
        }
        // Skip thinking blocks — internal reasoning, not conversation
      }
    }

    // If stop_reason is set, message is complete
    if (msg.stop_reason) {
      this.flushPending();
    }
  }

  private flushPending(): void {
    if (!this.pending || !this.lastSessionId || !this.lastMeta) return;

    const { textParts, toolUses } = this.pending;
    const messages: ParsedMessage[] = [];

    // Emit text content as assistant message
    const text = textParts.join("\n\n").trim();
    if (text) {
      const metadata: Record<string, unknown> | undefined =
        toolUses.length > 0
          ? { tools_used: toolUses.map((t) => t.name) }
          : undefined;

      messages.push({ role: "assistant", content: text, metadata });
    }

    if (messages.length > 0) {
      this.onMessages(this.lastSessionId, this.lastMeta, messages);
    }

    this.pending = null;
  }

  private extractProjectDir(filePath: string): string {
    // ~/.claude/projects/-Users-op-code-engram/session.jsonl
    // We want "engram" from the project dir name
    const parts = filePath.split("/");
    const projectsIdx = parts.indexOf("projects");
    if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
      const dirName = parts[projectsIdx + 1];
      // Take the last segment of the hyphenated path
      const segments = dirName.split("-").filter(Boolean);
      return segments[segments.length - 1] ?? dirName;
    }
    return "unknown";
  }
}
