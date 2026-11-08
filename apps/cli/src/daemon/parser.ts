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
//
// The key file is matched by its name alone, without regard to case
// (engram#619): `type %USERPROFILE%\.Engram\vault-key`, `cd ~/.engram && cat
// vault-key` and a Read of its path all print the key, and macOS and Windows
// ignore case in file names. ENGRAM_VAULT_KEY is the same key, kept in the
// environment.
const REVEALS_SECRET = /\bvault\s+(?:get|keygen)\b|\bvault-key\b|\bENGRAM_VAULT_KEY\b/i;

/**
 * Every string in a tool call's input, nested ones included: a shell
 * command, a file-reading tool's path, an MCP tool's arguments. Looking only
 * at `command` let a Read of the key file through (engram#619).
 */
function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === "string") out.push(value);
  else if (value && typeof value === "object" && depth < 8) {
    for (const v of Object.values(value)) stringsOf(v, out, depth + 1);
  }
  return out;
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
  /** Session and metadata of the lines the message came from. */
  sessionId: string;
  meta: SessionMeta;
  /** Byte offset of the message's first line in its file. */
  from: number;
}

/**
 * Parses Claude Code JSONL transcript lines into Engram messages.
 *
 * Claude Code writes one line per content block, so a single assistant
 * response may span multiple lines sharing the same `message.id`. We
 * accumulate blocks and flush when the message is complete (stop_reason
 * is set) or a new message begins.
 *
 * One parser reads every transcript of the host, interleaved: a session's
 * subagents and workflows write files of their own next to it. So the
 * accumulator is kept per file, and a message is emitted under the session
 * of its own lines (engram#579). It used to be a single accumulator emitted
 * under whichever session the parser had seen last, from any file — a
 * reply could be filed under another session, or dropped along with it when
 * that session was opted out.
 */
export class Parser implements LineParser {
  /**
   * Every line names its session, so resuming a file needs no context but
   * the recent tool calls: a `vault get` whose output is still to come.
   * Wide enough to reach back past parallel tool calls with large outputs;
   * past it, the value-exact scrubber (scrubber.ts) still applies.
   */
  readonly resumeContext = { headBytes: 0, tailBytes: 2 * 1024 * 1024 };

  /** The buffered assistant message of each file that has one. */
  private pending = new Map<string, PendingAssistant>();

  /**
   * tool_use ids whose result must not be captured. Bounded: an id is
   * removed the moment its result is seen, and a session produces a few
   * hundred tool calls at most. Tool ids are unique, so one set serves
   * every file.
   */
  private secretToolIds = new Set<string>();
  private onMessages: OnMessages;

  constructor(onMessages: OnMessages) {
    this.onMessages = onMessages;
  }

  processLine(line: string, filePath: string, offset: number): void {
    let data: JsonlLine;
    try {
      data = JSON.parse(line);
    } catch {
      return; // malformed line, skip
    }
    if (!data || typeof data !== "object") return; // valid JSON, not a record

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
    if (!data.message) return;

    if (data.type === "user") {
      // A user turn ends this file's buffered assistant message
      this.flushPending(filePath);
      this.processUserLine(sessionId, meta, data);
    } else if (data.type === "assistant") {
      this.processAssistantLine(sessionId, meta, data, filePath, offset);
    }
  }

  /**
   * Replays a line an earlier daemon process already handled — the watcher
   * does this for the lines just before where it resumes a file. Only one
   * thing spans lines across a restart: which tool calls print a secret.
   * Without it, a `vault get` whose output was written after the daemon
   * restarted had that output captured. Never emits.
   */
  restoreLine(line: string, _filePath: string): void {
    // Cheap pre-check: only tool_use and tool_result lines matter here.
    if (!line.includes("tool_")) return;
    let data: JsonlLine;
    try {
      data = JSON.parse(line);
    } catch {
      return;
    }
    const content = data?.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (data.type === "assistant" && block.type === "tool_use") {
        this.trackSecretTool(block);
      } else if (data.type === "user" && block.type === "tool_result" && block.tool_use_id) {
        this.secretToolIds.delete(block.tool_use_id);
      }
    }
  }

  bufferedFrom(filePath: string): number | null {
    return this.pending.get(filePath)?.from ?? null;
  }

  /** Emit buffered assistant messages: one file's, or every file's. */
  flush(filePath?: string): void {
    if (filePath !== undefined) {
      this.flushPending(filePath);
      return;
    }
    for (const path of [...this.pending.keys()]) this.flushPending(path);
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
    filePath: string,
    offset: number,
  ): void {
    const msg = data.message!;
    const messageId = msg.id ?? "";
    const content = msg.content;

    // A new message ID in this file ends the previous one
    let pending = this.pending.get(filePath);
    if (pending && pending.messageId !== messageId) {
      this.flushPending(filePath);
      pending = undefined;
    }

    // Initialize accumulator if needed
    if (!pending) {
      pending = { messageId, textParts: [], toolUses: [], sessionId, meta, from: offset };
      this.pending.set(filePath, pending);
    }
    pending.sessionId = sessionId;
    pending.meta = meta;

    // Accumulate content blocks
    if (typeof content === "string") {
      if (content.trim()) {
        pending.textParts.push(content);
      }
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text?.trim()) {
          pending.textParts.push(block.text);
        } else if (block.type === "tool_use") {
          if (block.name) {
            pending.toolUses.push({
              name: block.name,
              input: block.input,
            });
          }
          this.trackSecretTool(block);
        }
        // Skip thinking blocks — internal reasoning, not conversation
      }
    }

    // If stop_reason is set, message is complete
    if (msg.stop_reason) {
      this.flushPending(filePath);
    }
  }

  private trackSecretTool(block: ContentBlock): void {
    if (block.id && stringsOf(block.input).some((s) => REVEALS_SECRET.test(s))) {
      this.secretToolIds.add(block.id);
    }
  }

  private flushPending(filePath: string): void {
    const pending = this.pending.get(filePath);
    if (!pending) return;
    this.pending.delete(filePath);

    const { textParts, toolUses, sessionId, meta } = pending;
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
      this.onMessages(sessionId, meta, messages);
    }
  }

  private extractProjectDir(filePath: string): string {
    return claudeProjectDir(filePath);
  }
}

/**
 * Project name from a Claude Code transcript path:
 * ~/.claude/projects/-Users-op-code-engram/session.jsonl → "engram"
 * C:\Users\op\.claude\projects\C--Users-op-code-engram\session.jsonl → "engram"
 * (the last segment of the hyphen-encoded project directory). Either
 * separator: split on "/" alone, every Windows conversation was filed under
 * "unknown" (engram#602).
 */
export function claudeProjectDir(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    const dirName = parts[projectsIdx + 1];
    // Take the last segment of the hyphenated path
    const segments = dirName.split("-").filter(Boolean);
    return segments[segments.length - 1] ?? dirName;
  }
  return "unknown";
}
