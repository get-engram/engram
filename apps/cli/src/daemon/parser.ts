import type { ParsedMessage, SessionMeta, OnMessages, LineParser } from "./types.js";

// Line types we skip entirely
const SKIP_TYPES = new Set([
  "file-history-snapshot",
  "progress",
  "queue-operation",
  "last-prompt",
]);

interface ImageSource {
  type?: string;        // "base64" | "url" | "file"
  media_type?: string;  // "image/png", …
  data?: string;        // base64 payload
  url?: string;
  file_id?: string;
}

interface ContentBlock {
  type: string;
  /** tool_use blocks carry an id; tool_result blocks point at it. */
  id?: string;
  text?: string;
  source?: ImageSource;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
  signature?: string;
}

/**
 * Engram stores text, so an image cannot be kept as pixels — but it must not
 * vanish either. A turn that read "what is wrong with this?" next to a
 * screenshot is nonsense on its own, and that is exactly what recall used to
 * return. This records that something visual was attached, with enough detail
 * to recognise it later and to decide whether it is worth running OCR over.
 */
function describeImage(block: ContentBlock): string {
  const src = block.source ?? {};
  const kind = (src.media_type || "image").replace(/^image\//, "").toUpperCase();
  // base64 encodes 3 bytes per 4 chars; close enough to show scale.
  const bytes = src.data ? Math.floor((src.data.length * 3) / 4) : 0;
  const size = bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : bytes > 0 ? `${bytes} B` : "";
  const where = src.url ? ` ${src.url}` : "";
  return `[image attached: ${kind}${size ? `, ${size}` : ""}${where}]`;
}

/**
 * Commands whose entire purpose is to print a secret. Their output must
 * never be captured, no matter what it looks like.
 *
 * `engram vault get NAME` decrypts and prints a vault value; `engram vault
 * keygen` prints the vault KEY. Both are first-party, and docs/vault.md
 * tells users to run the first one from inside an agent session. Before
 * this check, that session's transcript — tool output included — was shipped
 * to the server and vector-indexed, so the one feature built to keep a
 * secret out of memory was the one putting it there. The server-side regex
 * cannot help: a password or a PIN has no shape to match.
 *
 * Reading the key file directly is the same leak by a different door.
 */
//
// Matched on the subcommand, not the binary name: `node dist/index.js vault
// get`, `npx engram vault get` and `./engram vault get` all print the same
// value. Withholding the output of some other tool's `vault get` by mistake
// is a harmless over-redaction; missing one of these is the leak.
const REVEALS_SECRET = /\bvault\s+(get|keygen)\b|\.engram\/vault-key\b/;

function commandOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const cmd = (input as { command?: unknown }).command;
  return typeof cmd === "string" ? cmd : "";
}

export const REDACTED_TOOL_OUTPUT =
  "[output withheld by engram: this command prints a secret]";

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

/**
 * Parses Claude Code JSONL transcript lines into Engram messages.
 *
 * Claude Code writes one line per content block, so a single assistant
 * response may span multiple lines sharing the same `message.id`. We
 * accumulate blocks and flush when the message is complete (stop_reason
 * is set) or a new message begins.
 */
export class Parser implements LineParser {
  private pending: PendingAssistant | null = null;

  /**
   * tool_use ids whose result must not be captured. Bounded: an id is
   * removed the moment its result is seen, and a session produces a few
   * hundred tool calls at most.
   */
  private secretToolIds = new Set<string>();
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
      host: "claude-code",
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

    // Array content. Claude Code switches a user turn from a plain string to
    // an array of blocks the moment anything is attached — an image, most
    // commonly. This loop used to look only for tool_result, so every such
    // turn was dropped WHOLE: not just the image, but the question typed
    // alongside it. Measured on the owner's own transcripts before the fix:
    // 214 user turns and 413,471 characters of their own words never reached
    // Engram, 106 of those turns because a screenshot was attached.
    if (!Array.isArray(content)) return;

    const messages: ParsedMessage[] = [];
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && block.text?.trim()) {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push(describeImage(block));
      } else if (block.type === "tool_result") {
        const withheld =
          !!block.tool_use_id && this.secretToolIds.delete(block.tool_use_id);
        const text = withheld
          ? REDACTED_TOOL_OUTPUT
          : typeof block.content === "string"
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

    // The user's own words come first; tool results are the machinery that
    // followed them.
    if (parts.length > 0) {
      messages.unshift({ role: "user", content: parts.join("\n\n") });
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
          if (block.id && REVEALS_SECRET.test(commandOf(block.input))) {
            this.secretToolIds.add(block.id);
          }
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
