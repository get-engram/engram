import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json and exclusions.ts reads
// the real ~/.engram/config.json — keep both off the developer's machine.
// A path exclusion is modelled as "cwd under /excluded".
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: (cwd?: string) => !!cwd && cwd.startsWith("/excluded"),
}));

import { DaemonDb, pendingConversationId } from "../daemon/db.js";
import { Parser, REDACTED_TOOL_OUTPUT } from "../daemon/parser.js";
import { CodexParser } from "../daemon/codex-parser.js";
import { Syncer } from "../daemon/syncer.js";
import { Watcher, readLines } from "../daemon/watcher.js";
import type {
  HostAdapter,
  OnMessages,
  ParsedMessage,
  SessionMeta,
} from "../daemon/types.js";

// engram#579: one parser serves every session file of its host, and the
// files are read interleaved. Session state used to be parser-wide, so lines
// could be filed under another session — or dropped with it when that
// session was opted out — and the watcher saved its resume offset past a
// reply the parser was still holding, so a crash lost it.

type Emitted = { sessionId: string; meta: SessionMeta; messages: ParsedMessage[] };

function collector() {
  const out: Emitted[] = [];
  const onMessages: OnMessages = (sessionId, meta, messages) =>
    out.push({ sessionId, meta, messages });
  return { out, onMessages };
}

const texts = (out: Emitted[]) => out.flatMap((o) => o.messages.map((m) => m.content));

// ── Claude Code lines ──────────────────────────────────────────────────────
const cUser = (sessionId: string, text: string, cwd = "/work/a") => ({
  type: "user",
  sessionId,
  cwd,
  message: { role: "user", content: text },
});
const cAsst = (
  sessionId: string,
  id: string,
  text: string,
  stop: string | null = null,
  cwd = "/work/a",
) => ({
  type: "assistant",
  sessionId,
  cwd,
  message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: stop },
});
const cToolUse = (sessionId: string, id: string, toolId: string, command: string) => ({
  type: "assistant",
  sessionId,
  cwd: "/work/a",
  message: {
    id,
    role: "assistant",
    content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command } }],
    stop_reason: "tool_use",
  },
});
const cToolResult = (sessionId: string, toolId: string, output: string) => ({
  type: "user",
  sessionId,
  cwd: "/work/a",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolId, content: output }],
  },
});

// ── Codex lines ────────────────────────────────────────────────────────────
const xMeta = (payload: Record<string, unknown>) => ({ type: "session_meta", payload });
const xTurn = (cwd: string) => ({ type: "turn_context", payload: { turn_id: "t", cwd } });
const xUser = (t: string) => ({
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] },
});
const xAsst = (t: string) => ({
  type: "response_item",
  payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: t }] },
});

const UUID_A = "019f8e95-d0a3-70f3-88af-5f96100f86be";
const UUID_B = "019f8e96-1111-7222-8333-944455556666";
const UUID_SUB = "019f8e97-aaaa-7bbb-8ccc-9ddddeeeefff";

let dir: string;
const opened: DaemonDb[] = [];

function openDb(): DaemonDb {
  const db = new DaemonDb(join(dir, "daemon.db"));
  opened.push(db);
  return db;
}

const claudePath = (name: string) => join(dir, "-Users-x-proj", `${name}.jsonl`);
const codexPath = (uuid: string) =>
  join(dir, "2026", "11", "07", `rollout-2026-11-07T10-00-00-${uuid}.jsonl`);

function append(path: string, ...records: unknown[]): void {
  appendFileSync(path, records.map((r) => (typeof r === "string" ? r : JSON.stringify(r)) + "\n").join(""));
}

/** A watcher over the temp dir, driven directly instead of by chokidar. */
function watcherFor(db: DaemonDb, host: "claude" | "codex", onMessages: OnMessages) {
  const adapter: HostAdapter = {
    id: host,
    label: host,
    watchDir: dir,
    available: () => true,
    createParser: (cb) => (host === "claude" ? new Parser(cb) : new CodexParser(cb)),
  };
  const watcher = new Watcher(db, onMessages, adapter);
  const read = (path: string) =>
    (watcher as unknown as { processFile(p: string): void }).processFile(path);
  return { watcher, read };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-579-"));
  for (const sub of [join(dir, "-Users-x-proj"), join(dir, "2026", "11", "07")]) {
    mkdirSync(sub, { recursive: true });
  }
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CodexParser keeps state per rollout file", () => {
  it("files each line under its own rollout's session and cwd when two interleave", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    const A = codexPath(UUID_A);
    const B = codexPath(UUID_B);
    const line = (path: string, r: unknown) => p.processLine(JSON.stringify(r), path, 0);

    line(A, xMeta({ id: UUID_A, session_id: UUID_A, cwd: "/work/a" }));
    line(B, xMeta({ id: UUID_B, session_id: UUID_B, cwd: "/work/b" }));
    line(A, xUser("a question"));
    line(B, xUser("b question"));
    line(A, xTurn("/work/a/sub"));
    line(A, xAsst("a answer"));
    line(B, xAsst("b answer"));

    expect(out.map((o) => [o.messages[0].content, o.sessionId, o.meta.cwd])).toEqual([
      ["a question", UUID_A, "/work/a"],
      ["b question", UUID_B, "/work/b"],
      ["a answer", UUID_A, "/work/a/sub"],
      ["b answer", UUID_B, "/work/b"],
    ]);
  });

  it("gives messages before the first turn_context the session_meta cwd", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    const A = codexPath(UUID_A);
    p.processLine(JSON.stringify(xMeta({ id: UUID_A, cwd: "/excluded/repo" })), A, 0);
    p.processLine(JSON.stringify(xUser("first prompt")), A, 0);
    expect(out[0].meta.cwd).toBe("/excluded/repo");
    expect(out[0].meta.projectDir).toBe("/excluded/repo");
  });

  it("files a subagent rollout under its parent's session_id, not its filename", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    const SUB = codexPath(UUID_SUB);
    // A subagent's rollout: its own meta (filename id, parent session_id),
    // then its parent's meta.
    p.processLine(
      JSON.stringify(xMeta({ id: UUID_SUB, session_id: UUID_A, cwd: "/work/sub" })),
      SUB,
      0,
    );
    p.processLine(JSON.stringify(xMeta({ id: UUID_A, cwd: "/work/parent" })), SUB, 0);
    p.processLine(JSON.stringify(xUser("delegated task")), SUB, 0);
    expect(out[0].sessionId).toBe(UUID_A);
    expect(out[0].meta.cwd).toBe("/work/sub");
  });

  it("restoreLine rebuilds a file's session and cwd without emitting", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    const SUB = codexPath(UUID_SUB);
    p.restoreLine(JSON.stringify(xMeta({ id: UUID_SUB, session_id: UUID_A, cwd: "/w" })), SUB);
    p.restoreLine(JSON.stringify(xUser("already captured")), SUB);
    // Passes the cheap pre-check, but is a message, not state.
    p.restoreLine(JSON.stringify(xUser("why does turn_context come after session_meta?")), SUB);
    p.restoreLine(JSON.stringify(xTurn("/w/later")), SUB);
    expect(out).toEqual([]);
    p.processLine(JSON.stringify(xAsst("next")), SUB, 0);
    expect(out.map((o) => [o.sessionId, o.meta.cwd])).toEqual([[UUID_A, "/w/later"]]);
  });

  it("ignores lines that are valid JSON but not records", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    for (const line of ["null", "[]", '"text"', "42", "true"]) {
      expect(() => p.processLine(line, codexPath(UUID_A), 0)).not.toThrow();
      expect(() => p.restoreLine(`${line} `, codexPath(UUID_A))).not.toThrow();
    }
    expect(out).toEqual([]);
  });

  it("still falls back to the filename uuid when no session_meta was ever seen", () => {
    const { out, onMessages } = collector();
    const p = new CodexParser(onMessages);
    p.processLine(JSON.stringify(xUser("orphan")), codexPath(UUID_B), 0);
    expect(out[0].sessionId).toBe(UUID_B);
  });
});

describe("Claude Parser keeps its reply buffer per transcript file", () => {
  it("emits a buffered reply under its own session when another file's line comes between", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    const A = claudePath("a");
    const B = claudePath("b");
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "part one")), A, 100);
    p.processLine(JSON.stringify(cUser("sess-b", "b asks", "/work/b")), B, 0);
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "part two", "end_turn")), A, 200);

    expect(out.map((o) => [o.sessionId, o.messages.map((m) => m.content)])).toEqual([
      ["sess-b", ["b asks"]],
      ["sess-a", ["part one\n\npart two"]],
    ]);
  });

  it("a new message id ends the previous reply, and the buffer moves to the new one", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    const A = claudePath("a");
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_1", "first reply")), A, 0);
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_2", "second reply")), A, 120);
    expect(texts(out)).toEqual(["first reply"]);
    expect(p.bufferedFrom(A)).toBe(120);
    p.flush();
    expect(texts(out)).toEqual(["first reply", "second reply"]);
  });

  it("reports where a file's buffered reply starts, and nothing for other files", () => {
    const p = new Parser(() => {});
    const A = claudePath("a");
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "one")), A, 4096);
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "two")), A, 5000);
    expect(p.bufferedFrom(A)).toBe(4096);
    expect(p.bufferedFrom(claudePath("b"))).toBeNull();
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "three", "end_turn")), A, 6000);
    expect(p.bufferedFrom(A)).toBeNull();
  });

  it("flush(path) emits one file's buffer; flush() emits every file's", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    const A = claudePath("a");
    const B = claudePath("b");
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "from a")), A, 0);
    p.processLine(JSON.stringify(cAsst("sess-b", "msg_b", "from b")), B, 0);
    p.flush(A);
    expect(out.map((o) => o.sessionId)).toEqual(["sess-a"]);
    expect(p.bufferedFrom(B)).toBe(0);
    p.flush();
    expect(out.map((o) => o.sessionId)).toEqual(["sess-a", "sess-b"]);
  });

  it("a user line ends its own file's buffered reply, before the user line", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    const A = claudePath("a");
    p.processLine(JSON.stringify(cAsst("sess-a", "msg_a", "reply")), A, 0);
    p.processLine(JSON.stringify(cUser("sess-a", "next question")), A, 300);
    expect(texts(out)).toEqual(["reply", "next question"]);
    expect(p.bufferedFrom(A)).toBeNull();
  });

  it("ignores lines that are valid JSON but not records", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    for (const line of ["null", "[]", '"text"', "42", "true"]) {
      expect(() => p.processLine(line, claudePath("a"), 0)).not.toThrow();
    }
    // Lines restoreLine's pre-check lets through.
    for (const line of [
      '["tool_use"]',
      '"tool_use"',
      '{"type":"assistant","message":null,"note":"tool_use"}',
      '{"type":"assistant","message":{"content":"tool_use"}}',
    ]) {
      expect(() => p.restoreLine(line, claudePath("a"))).not.toThrow();
    }
    expect(out).toEqual([]);
  });

  it("a replayed vault get keeps its later output withheld", () => {
    const { out, onMessages } = collector();
    const p = new Parser(onMessages);
    const A = claudePath("a");
    p.restoreLine(JSON.stringify(cToolUse("sess-a", "msg_t", "toolu_1", "engram vault get DB_PASS")), A);
    expect(out).toEqual([]);
    p.processLine(JSON.stringify(cToolResult("sess-a", "toolu_1", "correct-horse-battery")), A, 0);
    expect(texts(out)).toEqual([REDACTED_TOOL_OUTPUT]);
  });
});

describe("Watcher saves its resume offset only past emitted content", () => {
  it("saves up to a buffered reply, and a restart after a crash re-reads it whole", () => {
    const db = openDb();
    const A = claudePath("a");
    append(A, cUser("sess-a", "question"));
    const replyStart = statSync(A).size;
    append(A, cAsst("sess-a", "msg_a", "first block"));

    const first = collector();
    watcherFor(db, "claude", first.onMessages).read(A);
    expect(texts(first.out)).toEqual(["question"]);
    expect(db.getFileOffset(A)).toBe(replyStart);

    // Crash: no stop(), no flush. A new process resumes from daemon.db.
    append(A, cAsst("sess-a", "msg_a", "second block", "end_turn"));
    const second = collector();
    watcherFor(db, "claude", second.onMessages).read(A);
    expect(texts(second.out)).toEqual(["first block\n\nsecond block"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
  });

  it("never reads its own buffered lines twice while running", () => {
    const db = openDb();
    const A = claudePath("a");
    const { out, onMessages } = collector();
    const { read } = watcherFor(db, "claude", onMessages);
    append(A, cAsst("sess-a", "msg_a", "one"));
    read(A);
    append(A, cAsst("sess-a", "msg_a", "two"));
    read(A);
    append(A, cAsst("sess-a", "msg_a", "three", "end_turn"));
    read(A);
    expect(texts(out)).toEqual(["one\n\ntwo\n\nthree"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
  });

  it("a graceful stop emits the buffer and saves past it, so a restart doesn't repeat it", () => {
    const db = openDb();
    const A = claudePath("a");
    append(A, cAsst("sess-a", "msg_a", "unfinished"));
    const first = collector();
    const w1 = watcherFor(db, "claude", first.onMessages);
    w1.read(A);
    expect(first.out).toEqual([]);
    w1.watcher.stop();
    expect(texts(first.out)).toEqual(["unfinished"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);

    append(A, cUser("sess-a", "after restart"));
    const second = collector();
    watcherFor(db, "claude", second.onMessages).read(A);
    expect(texts(second.out)).toEqual(["after restart"]);
  });

  it("ignores change events after stop()", () => {
    const db = openDb();
    const A = claudePath("a");
    const { out, onMessages } = collector();
    const w = watcherFor(db, "claude", onMessages);
    w.watcher.stop();
    append(A, cUser("sess-a", "late"));
    w.read(A);
    expect(out).toEqual([]);
    expect(db.getFileOffset(A)).toBe(0);
  });

  it("resumes a Codex subagent rollout under its parent session and cwd", () => {
    const db = openDb();
    const SUB = codexPath(UUID_SUB);
    append(
      SUB,
      xMeta({ id: UUID_SUB, session_id: UUID_A, cwd: "/work/sub" }),
      xMeta({ id: UUID_A, cwd: "/work/parent" }),
      xUser("delegated task"),
    );
    const first = collector();
    watcherFor(db, "codex", first.onMessages).read(SUB);
    expect(first.out.map((o) => [o.sessionId, o.meta.cwd])).toEqual([[UUID_A, "/work/sub"]]);

    append(SUB, xAsst("done"));
    const second = collector();
    watcherFor(db, "codex", second.onMessages).read(SUB);
    expect(second.out.map((o) => [o.messages[0].content, o.sessionId, o.meta.cwd])).toEqual([
      ["done", UUID_A, "/work/sub"],
    ]);
  });

  it("resumes past the head window using the head's session and the tail's cwd", () => {
    const db = openDb();
    const A = codexPath(UUID_A);
    append(A, xMeta({ id: UUID_A, session_id: "sess-parent", cwd: "/work/start" }));
    // Enough other records that the head window (1 MiB) and the tail window
    // (256 KiB before the resume point) don't meet: the session comes only
    // from the head, the cwd only from the tail.
    const filler = JSON.stringify({ type: "event_msg", payload: { type: "token_count", pad: "x".repeat(4000) } });
    appendFileSync(A, `${filler}\n`.repeat(400));
    append(A, xTurn("/work/moved"), xUser("q"));
    expect(statSync(A).size).toBeGreaterThan(1024 * 1024 + 256 * 1024);
    watcherFor(db, "codex", () => {}).read(A);

    append(A, xAsst("a"));
    const second = collector();
    watcherFor(db, "codex", second.onMessages).read(A);
    expect(second.out.map((o) => [o.sessionId, o.meta.cwd])).toEqual([["sess-parent", "/work/moved"]]);
  });

  it("withholds a vault get's output written after a restart", () => {
    const db = openDb();
    const A = claudePath("a");
    append(A, cToolUse("sess-a", "msg_t", "toolu_9", "npx engram vault get API_TOKEN"));
    watcherFor(db, "claude", () => {}).read(A);

    append(A, cToolResult("sess-a", "toolu_9", "tok-123-abc"));
    const second = collector();
    watcherFor(db, "claude", second.onMessages).read(A);
    expect(texts(second.out)).toEqual([REDACTED_TOOL_OUTPUT]);
  });

  it("skips a line the parser can't handle instead of stopping at it", () => {
    const db = openDb();
    const A = claudePath("a");
    append(A, cUser("sess-a", "before"), "null", "[1,2]", cUser("sess-a", "after"));
    const { out, onMessages } = collector();
    watcherFor(db, "claude", onMessages).read(A);
    expect(texts(out)).toEqual(["before", "after"]);

    // Even a parser that throws doesn't wedge the file.
    const B = claudePath("b");
    append(B, cUser("sess-b", "one"), cUser("sess-b", "two"));
    const seen: string[] = [];
    const adapter: HostAdapter = {
      id: "t",
      label: "t",
      watchDir: dir,
      available: () => true,
      createParser: () => ({
        resumeContext: { headBytes: 0, tailBytes: 0 },
        processLine(line: string) {
          if (line.includes('"one"')) throw new Error("boom");
          seen.push(line);
        },
        restoreLine() {},
        bufferedFrom: () => null,
        flush() {},
      }),
    };
    const w = new Watcher(db, () => {}, adapter);
    (w as unknown as { processFile(p: string): void }).processFile(B);
    expect(seen).toHaveLength(1);
    expect(db.getFileOffset(B)).toBe(statSync(B).size);
  });
});

describe("Watcher bookkeeping", () => {
  /** A parser that records calls and reports whatever buffer it is told to. */
  function spyParser() {
    const calls = { processed: 0, restored: 0 };
    let buffered: number | null = null;
    const parser = {
      resumeContext: { headBytes: 1024, tailBytes: 1024 },
      processLine() {
        calls.processed++;
      },
      restoreLine() {
        calls.restored++;
      },
      bufferedFrom: () => buffered,
      flush() {},
    };
    const adapter: HostAdapter = {
      id: "spy",
      label: "spy",
      watchDir: dir,
      available: () => true,
      createParser: () => parser,
    };
    return {
      calls,
      setBuffered: (b: number | null) => {
        buffered = b;
      },
      watcher: (db: DaemonDb) => {
        const w = new Watcher(db, () => {}, adapter);
        return (path: string) => (w as unknown as { processFile(p: string): void }).processFile(path);
      },
    };
  }

  it("never moves a saved offset back", () => {
    const db = openDb();
    const A = claudePath("a");
    const spy = spyParser();
    const read = spy.watcher(db);
    append(A, cUser("s", "one"));
    read(A);
    const firstEnd = statSync(A).size;
    expect(db.getFileOffset(A)).toBe(firstEnd);

    // A parser reporting a buffer that starts before what is already saved
    // must not pull the resume point back: that would re-queue lines.
    spy.setBuffered(0);
    append(A, cUser("s", "two"));
    read(A);
    expect(db.getFileOffset(A)).toBe(firstEnd);
  });

  it("replays context only on a new process's first read of a file part-way in", () => {
    const db = openDb();
    const A = claudePath("a");
    append(A, cUser("s", "one"), cUser("s", "two"));
    const first = spyParser();
    const read1 = first.watcher(db);
    read1(A); // from the start of the file: nothing to restore
    append(A, cUser("s", "three"));
    read1(A); // same process: its own state is current
    expect(first.calls).toEqual({ processed: 3, restored: 0 });

    const second = spyParser();
    const read2 = second.watcher(db);
    append(A, cUser("s", "four"));
    read2(A);
    read2(A);
    append(A, cUser("s", "five"));
    read2(A);
    expect(second.calls).toEqual({ processed: 2, restored: 3 });
  });
});

describe("an opted-out or excluded session next to a live one (via the Syncer)", () => {
  function syncerWatcher(db: DaemonDb, host: "claude" | "codex") {
    const syncer = new Syncer(db, {} as Engram);
    return watcherFor(db, host, (s, m, msgs) => {
      void syncer.onMessages(s, m, msgs);
    });
  }
  const queued = (db: DaemonDb, sessionId: string) =>
    db.dequeue(pendingConversationId(sessionId), 100).map((r) => r.content);

  it("Claude: a live session's reply isn't dropped with an opted-out neighbour", () => {
    const db = openDb();
    db.markSessionExcluded("sess-b", "test");
    const A = claudePath("a");
    const B = claudePath("b");
    const { read } = syncerWatcher(db, "claude");
    append(A, cUser("sess-a", "a asks"), cAsst("sess-a", "msg_a", "a answers"));
    read(A);
    append(B, cUser("sess-b", "b asks"));
    read(B);
    append(A, cAsst("sess-a", "msg_a", "and finishes", "end_turn"));
    read(A);

    expect(queued(db, "sess-a")).toEqual(["a asks", "a answers\n\nand finishes"]);
    expect(queued(db, "sess-b")).toEqual([]);
  });

  it("Codex: an excluded folder's rollout stays out, and its live neighbour stays in", () => {
    const db = openDb();
    const A = codexPath(UUID_A);
    const B = codexPath(UUID_B);
    const { read } = syncerWatcher(db, "codex");
    append(A, xMeta({ id: UUID_A, cwd: "/work/a" }), xUser("a1"));
    read(A);
    append(B, xMeta({ id: UUID_B, cwd: "/excluded/b" }), xUser("b1 before any turn_context"));
    read(B);
    append(A, xAsst("a2"));
    read(A);
    append(B, xTurn("/excluded/b"), xAsst("b2"));
    read(B);

    expect(queued(db, UUID_A)).toEqual(["a1", "a2"]);
    expect(queued(db, UUID_B)).toEqual([]);
  });
});

describe("readLines", () => {
  function withFile(content: Buffer, fn: (fd: number) => void) {
    const p = join(dir, "lines.bin");
    writeFileSync(p, content);
    const fd = openSync(p, "r");
    try {
      fn(fd);
    } finally {
      closeSync(fd);
    }
  }

  it("returns complete lines with raw byte offsets, even across bad UTF-8", () => {
    // "é" is 2 bytes; 0xff is not valid UTF-8 and decodes to a 3-byte U+FFFD.
    const content = Buffer.concat([
      Buffer.from("é1\n"),
      Buffer.from([0xff, 0x0a]),
      Buffer.from("third\npartial"),
    ]);
    withFile(content, (fd) => {
      const r = readLines(fd, 0, content.length);
      expect(r.lines.map((l) => l.offset)).toEqual([0, 4, 6]);
      expect(r.lines[2].text).toBe("third");
      expect(r.end).toBe(12);
    });
  });

  it("skips a line that the start falls inside", () => {
    const content = Buffer.from("aaaa\nbbbb\ncccc\n");
    withFile(content, (fd) => {
      expect(readLines(fd, 2, content.length).lines).toEqual([
        { text: "bbbb", offset: 5 },
        { text: "cccc", offset: 10 },
      ]);
      expect(readLines(fd, 2, content.length).end).toBe(15);
      expect(readLines(fd, 5, content.length).lines.map((l) => l.text)).toEqual(["bbbb", "cccc"]);
      expect(readLines(fd, 7, 10)).toEqual({ lines: [], end: 7 });
    });
  });
});
