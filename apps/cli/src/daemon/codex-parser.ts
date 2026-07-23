import type { LineParser, OnMessages, SessionMeta, ParsedMessage } from "./types.js";

// Codex writes one complete JSON object per line to
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Unlike Claude Code
// (one line per content block), each Codex line is self-contained, so
// no cross-line accumulation is needed (engram#261 / #260).

interface RolloutLine {
  type?: string; // session_meta | response_item | event_msg | turn_context | ...
  payload?: {
    type?: string; // for response_item: "message"
    role?: string; // user | assistant | developer | tool
    content?: Array<{ text?: string; input_text?: string }>;
    session_id?: string;
    id?: string;
    cwd?: string;
  };
}

// Codex injects its own context blocks as "user" messages — skip them.
const CONTEXT_PREFIX = /^<(environment_context|recommended_plugins|user_instructions)/;

/**
 * Parses Codex CLI rollout JSONL into Engram messages.
 * Emits per completed user/assistant message (one line = one message).
 */
export class CodexParser implements LineParser {
  private onMessages: OnMessages;
  private sessionId: string | null = null;
  private cwd: string | undefined;

  constructor(onMessages: OnMessages) {
    this.onMessages = onMessages;
  }

  processLine(line: string, filePath: string): void {
    let data: RolloutLine;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    const p = data.payload ?? {};

    if (data.type === "session_meta") {
      this.sessionId = p.session_id ?? p.id ?? this.sessionId;
      return;
    }
    if (data.type === "turn_context" && p.cwd) {
      this.cwd = p.cwd;
      return;
    }
    if (data.type !== "response_item" || p.type !== "message") return;

    const role = p.role;
    if (role !== "user" && role !== "assistant") return; // skip developer/system/tool

    const text = (p.content ?? [])
      .map((c) => c.text ?? c.input_text ?? "")
      .join("")
      .trim();
    if (!text || CONTEXT_PREFIX.test(text)) return;

    // Fall back to the rollout filename's uuid if session_meta wasn't seen
    // (offset-based reads can start mid-file).
    const sessionId = this.sessionId ?? this.sessionIdFromPath(filePath);
    if (!sessionId) return;

    const meta: SessionMeta = {
      sessionId,
      cwd: this.cwd,
      projectDir: this.cwd ?? "",
      host: "codex",
    };
    const message: ParsedMessage = { role, content: text };
    this.onMessages(sessionId, meta, [message]);
  }

  flush(): void {
    // No buffering — each line emits immediately.
  }

  /** rollout-2026-07-23T04-46-50-<uuid>.jsonl → <uuid> */
  private sessionIdFromPath(filePath: string): string | null {
    const m = filePath.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i);
    return m ? m[1] : null;
  }
}
