import type { LineParser, OnMessages, SessionMeta, ParsedMessage } from "./types.js";

// Codex writes one complete JSON object per line to
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Unlike Claude Code
// (one line per content block), each Codex line is self-contained, so
// no cross-line accumulation is needed (engram#261 / #260).

interface RolloutLine {
  type?: string; // session_meta | response_item | event_msg | turn_context | ...
  /**
   * A paginated rollout numbers its records from 0, its own session_meta
   * first. A legacy one doesn't number them.
   */
  ordinal?: unknown;
  payload?: {
    type?: string; // for response_item: "message"
    role?: string; // user | assistant | developer | tool
    content?: Array<{ text?: string; input_text?: string }>;
    session_id?: string;
    id?: string;
    cwd?: string;
    /** session_meta: the first record that is the subagent's own. */
    subagent_history_start_ordinal?: unknown;
  };
}

// Codex injects its own context blocks as "user" messages — skip them.
const CONTEXT_PREFIX = /^<(environment_context|recommended_plugins|user_instructions)/;

/** What a rollout file has said about its own session so far. */
interface RolloutState {
  sessionId: string | null;
  cwd: string | undefined;
  /**
   * The first record that is this subagent's own. The ones before it are its
   * parent's history, copied in as context (engram#583). null when the file
   * has no such boundary, or its own session_meta hasn't been read.
   */
  ownFrom: number | null;
}

/**
 * Parses Codex CLI rollout JSONL into Engram messages.
 * Emits per completed user/assistant message (one line = one message).
 *
 * The session and cwd come from the file's own `session_meta` and
 * `turn_context` lines, kept per file (engram#579). They used to be
 * parser-wide, so once a second rollout had started, lines from either file
 * were filed under whichever session last wrote `session_meta`, with
 * whichever cwd was seen last — misfiled, dropped with an opted-out
 * session, or captured past a path exclusion.
 *
 * The id is `session_id ?? id`, not the rollout filename: a subagent's or a
 * fork's rollout names its own id in the filename but carries its parent's
 * `session_id`, and its messages have always gone to the parent's
 * conversation.
 *
 * A subagent's rollout copies its parent's history in before its own turns.
 * Those messages are the parent's, captured from the parent's own rollout,
 * so appending them again would repeat them in the conversation. When the
 * rollout numbers its records (paginated), the subagent's own session_meta
 * says where its own records begin, and the messages before that are
 * skipped (engram#583). A legacy rollout has no numbers and no boundary, so
 * its copy is still captured: skipping by a guess could drop the
 * subagent's own turns (engram#671).
 */
export class CodexParser implements LineParser {
  /**
   * `session_meta` opens the file (a subagent's has two); the latest
   * `turn_context` sits just before the resume point.
   */
  readonly resumeContext = { headBytes: 1024 * 1024, tailBytes: 256 * 1024 };

  private onMessages: OnMessages;
  private files = new Map<string, RolloutState>();

  constructor(onMessages: OnMessages) {
    this.onMessages = onMessages;
  }

  processLine(line: string, filePath: string, _offset: number): void {
    const data = parse(line);
    if (!data) return;
    const state = this.stateOf(filePath);
    if (this.track(data, state)) return;

    const p = data.payload ?? {};
    if (data.type !== "response_item" || p.type !== "message") return;

    const role = p.role;
    if (role !== "user" && role !== "assistant") return; // skip developer/system/tool
    if (inherited(data, state)) return;

    const text = (p.content ?? [])
      .map((c) => c.text ?? c.input_text ?? "")
      .join("")
      .trim();
    if (!text || CONTEXT_PREFIX.test(text)) return;

    // The rollout filename's uuid is the last resort: a resumed read gets
    // the file's session_meta replayed first (restoreLine), so this is only
    // reached when that line could not be read at all.
    const sessionId = state.sessionId ?? this.sessionIdFromPath(filePath);
    if (!sessionId) return;

    const meta: SessionMeta = {
      sessionId,
      cwd: state.cwd,
      projectDir: state.cwd ?? "",
      host: "codex",
    };
    const message: ParsedMessage = { role, content: text };
    this.onMessages(sessionId, meta, [message]);
  }

  restoreLine(line: string, filePath: string): void {
    // Cheap pre-check: only these two record types carry state.
    if (!line.includes("session_meta") && !line.includes("turn_context")) return;
    const data = parse(line);
    if (data) this.track(data, this.stateOf(filePath));
  }

  bufferedFrom(_filePath: string): number | null {
    return null; // No buffering — each line emits immediately.
  }

  flush(_filePath?: string): void {
    // No buffering — each line emits immediately.
  }

  discard(_filePath: string): void {
    // Nothing buffered. The session id, cwd and boundary kept per file
    // aren't buffered content: they are already true of the lines read
    // again.
  }

  private stateOf(filePath: string): RolloutState {
    let state = this.files.get(filePath);
    if (!state) {
      state = { sessionId: null, cwd: undefined, ownFrom: null };
      this.files.set(filePath, state);
    }
    return state;
  }

  /** Applies a session_meta / turn_context line; true when it was one. */
  private track(data: RolloutLine, state: RolloutState): boolean {
    const p = data.payload ?? {};
    if (data.type === "session_meta") {
      state.sessionId = p.session_id ?? p.id ?? state.sessionId;
      // The session's starting directory. Messages can come before the
      // first turn_context, and without it they had no cwd at all — so a
      // path exclusion could not apply to them. A subagent's second
      // session_meta is its parent's, so the first one wins.
      if (p.cwd && state.cwd === undefined) state.cwd = p.cwd;
      // The boundary is this file's own session_meta's: its first record,
      // numbered 0. A subagent's parent's session_meta comes next. When the
      // parent is a subagent too, that one has a boundary of its own, which
      // isn't this file's. Going by the number rather than by which
      // session_meta came first, a resumed read that couldn't replay the
      // file's first line never takes the parent's (engram#583).
      if (data.ordinal === 0) state.ownFrom = startOrdinal(p.subagent_history_start_ordinal);
      return true;
    }
    if (data.type === "turn_context") {
      if (p.cwd) state.cwd = p.cwd;
      return true;
    }
    return false;
  }

  /** rollout-2026-07-23T04-46-50-<uuid>.jsonl → <uuid> */
  private sessionIdFromPath(filePath: string): string | null {
    const m = filePath.match(/rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/i);
    return m ? m[1] : null;
  }
}

/** A record numbered before this subagent's own: its parent's history. */
function inherited(data: RolloutLine, state: RolloutState): boolean {
  return state.ownFrom !== null && typeof data.ordinal === "number" && data.ordinal < state.ownFrom;
}

/** A boundary to skip to, or null: one at 0 has nothing before it. */
function startOrdinal(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parse(line: string): RolloutLine | null {
  try {
    const data: unknown = JSON.parse(line);
    return data && typeof data === "object" ? (data as RolloutLine) : null;
  } catch {
    return null;
  }
}
