import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engram } from "@getengram/sdk";

// engram#584: when daemon.db couldn't queue a line's messages (a full disk,
// a locked or read-only daemon.db), the failure was only logged and the
// watcher saved its resume offset past the line anyway. The messages were
// never queued and never read again. Now the failure reaches the watcher,
// which holds the file at the line and reads it again after a backoff.

// status.ts writes the REAL ~/.engram/status.json and exclusions.ts reads
// the real ~/.engram/config.json — keep both off the developer's machine.
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  recordCaptureStall: vi.fn(),
  recordCaptureResumed: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: (cwd?: string) => !!cwd && cwd.startsWith("/excluded"),
}));

import { DaemonDb, pendingConversationId } from "../daemon/db.js";
import { Parser, REDACTED_TOOL_OUTPUT } from "../daemon/parser.js";
import { CodexParser } from "../daemon/codex-parser.js";
import { Syncer } from "../daemon/syncer.js";
import { Watcher, RETRY_DELAYS_MS } from "../daemon/watcher.js";
import { QueueWriteError } from "../daemon/queue-error.js";
import { recordCaptureStall, recordCaptureResumed } from "../daemon/status.js";
import type { HostAdapter, SessionMeta } from "../daemon/types.js";

/** What SQLite says when the disk is full. */
const FULL = "database or disk is full";

// ── Transcript lines ───────────────────────────────────────────────────────
const cUser = (sessionId: string, text: string) => ({
  type: "user",
  sessionId,
  cwd: "/work/a",
  message: { role: "user", content: text },
});
const cAsst = (sessionId: string, id: string, text: string, stop: string | null = null) => ({
  type: "assistant",
  sessionId,
  cwd: "/work/a",
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
const xMeta = (payload: Record<string, unknown>) => ({ type: "session_meta", payload });
const xTurn = (cwd: string) => ({ type: "turn_context", payload: { turn_id: "t", cwd } });
const xMsg = (role: "user" | "assistant", t: string) => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text: t }],
  },
});

const UUID_A = "019f8e95-d0a3-70f3-88af-5f96100f86be";
const META: SessionMeta = { sessionId: "s1", cwd: "/work/a", projectDir: "a", host: "claude-code" };

let dir: string;
const opened: DaemonDb[] = [];
const watchers: Watcher[] = [];

function openDb(): DaemonDb {
  const db = new DaemonDb(join(dir, "daemon.db"));
  opened.push(db);
  return db;
}

const claudePath = (name: string) => join(dir, "-Users-x-proj", `${name}.jsonl`);
const codexPath = (uuid: string) =>
  join(dir, "2026", "11", "07", `rollout-2026-11-07T10-00-00-${uuid}.jsonl`);

const lineOf = (record: unknown) => JSON.stringify(record) + "\n";

function append(path: string, ...records: unknown[]): void {
  appendFileSync(path, records.map(lineOf).join(""));
}

/** What daemon.db holds for a session that has no conversation yet. */
const queued = (db: DaemonDb, sessionId: string) =>
  db.dequeue(pendingConversationId(sessionId), 100).map((r) => r.content);

/**
 * A watcher fed through a real Syncer into a real daemon.db, wired the way
 * worker-main.ts wires the daemon's, and driven directly instead of by
 * chokidar.
 */
function daemon(host: "claude" | "codex" = "claude", db: DaemonDb = openDb()) {
  const syncer = new Syncer(db, {} as Engram);
  const adapter: HostAdapter = {
    id: host,
    label: host,
    watchDir: dir,
    available: () => true,
    createParser: (cb) => (host === "claude" ? new Parser(cb) : new CodexParser(cb)),
  };
  const watcher = new Watcher(
    db,
    (sessionId, meta, messages) => {
      syncer.onMessages(sessionId, meta, messages).catch(() => {});
    },
    adapter,
  );
  watchers.push(watcher);
  const internals = watcher as unknown as { processFile(p: string, retrying?: boolean): void };
  return {
    db,
    watcher,
    /** A change event for the file. */
    read: (path: string) => internals.processFile(path),
    /** The backoff timer coming due. */
    retry: (path: string) => internals.processFile(path, true),
  };
}

/** daemon.db fails to queue, the way a full disk does: once, at the first
 *  batch whose contents `when` accepts. */
function failQueueOnce(db: DaemonDb, when: (contents: string[]) => boolean = () => true) {
  const real = db.enqueuePendingSession.bind(db);
  let armed = true;
  return vi
    .spyOn(db, "enqueuePendingSession")
    .mockImplementation((sessionId, meta, messages) => {
      if (armed && when(messages.map((m) => m.content))) {
        armed = false;
        throw new Error(FULL);
      }
      real(sessionId, meta, messages);
    });
}

/** daemon.db fails to queue anything until the spy is restored. */
const failQueue = (db: DaemonDb) =>
  vi.spyOn(db, "enqueuePendingSession").mockImplementation(() => {
    throw new Error(FULL);
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-584-"));
  for (const sub of [join(dir, "-Users-x-proj"), join(dir, "2026", "11", "07")]) {
    mkdirSync(sub, { recursive: true });
  }
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // stop() also cancels any retry still scheduled.
  for (const w of watchers.splice(0)) w.stop();
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("Syncer.onMessages and a daemon.db that can't queue", () => {
  it("throws a QueueWriteError before it returns, carrying what SQLite said", () => {
    const db = openDb();
    const syncer = new Syncer(db, {} as Engram);
    failQueue(db);
    let caught: unknown;
    try {
      void syncer.onMessages("s1", META, [{ role: "user", content: "hi" }]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueueWriteError);
    expect((caught as QueueWriteError).reason).toBe(FULL);
    expect((caught as QueueWriteError).cause).toBeInstanceOf(Error);
  });

  it("throws for a session that already has a conversation, too", () => {
    const db = openDb();
    db.setSessionMap("s1", "conv_1", {});
    const syncer = new Syncer(db, {} as Engram);
    vi.spyOn(db, "enqueue").mockImplementation(() => {
      throw new Error(FULL);
    });
    expect(() => syncer.onMessages("s1", META, [{ role: "user", content: "hi" }])).toThrow(
      QueueWriteError,
    );
  });

  it("throws when daemon.db can't even be read", () => {
    const db = openDb();
    const syncer = new Syncer(db, {} as Engram);
    vi.spyOn(db, "isSessionExcluded").mockImplementation(() => {
      throw new Error("database is locked");
    });
    expect(() => syncer.onMessages("s1", META, [{ role: "user", content: "hi" }])).toThrow(
      "couldn't queue messages in daemon.db: database is locked",
    );
  });

  it("returns a settled promise once the messages are queued", async () => {
    const db = openDb();
    const syncer = new Syncer(db, {} as Engram);
    await expect(syncer.onMessages("s1", META, [{ role: "user", content: "hi" }])).resolves.toBeUndefined();
    expect(queued(db, "s1")).toEqual(["hi"]);
  });
});

describe("the watcher holds a file at a line that couldn't be queued", () => {
  it("an enqueue that throws once leaves the offset at the line, and the next read queues the line exactly once", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "first"));
    read(A);
    const second = statSync(A).size;
    append(A, cUser("s1", "second"), cUser("s1", "third"));

    failQueueOnce(db);
    read(A);
    expect(db.getFileOffset(A)).toBe(second);
    expect(queued(db, "s1")).toEqual(["first"]);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`(${FULL}); holding at byte ${second}, trying again in 5s`),
    );

    retry(A);
    expect(queued(db, "s1")).toEqual(["first", "second", "third"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
  });

  it("reports the stall, and that capture resumed", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    failQueueOnce(db);
    read(A);
    expect(recordCaptureStall).toHaveBeenCalledWith(A, FULL);
    expect(recordCaptureResumed).not.toHaveBeenCalled();

    retry(A);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
  });

  it("reads a buffered reply whose flush failed again from its first line", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "question"));
    read(A);
    const replyStart = statSync(A).size;
    append(A, cAsst("s1", "m1", "part one"), cAsst("s1", "m1", "part two"));
    read(A); // held by the parser until the reply ends
    append(A, cUser("s1", "follow-up"));

    failQueueOnce(db);
    read(A);
    expect(db.getFileOffset(A)).toBe(replyStart);
    expect(queued(db, "s1")).toEqual(["question"]);

    retry(A);
    expect(queued(db, "s1")).toEqual(["question", "part one\n\npart two", "follow-up"]);
  });

  it("doesn't queue a reply twice when the user line after it is what failed", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "question"), cAsst("s1", "m1", "answer"));
    read(A);
    const followUp = statSync(A).size;
    append(A, cUser("s1", "follow-up"));

    failQueueOnce(db, (c) => c.includes("follow-up"));
    read(A);
    expect(queued(db, "s1")).toEqual(["question", "answer"]);
    expect(db.getFileOffset(A)).toBe(followUp);

    retry(A);
    expect(queued(db, "s1")).toEqual(["question", "answer", "follow-up"]);
  });

  it("doesn't queue a reply twice when the next reply on the same line is what failed", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "question"), cAsst("s1", "m1", "first reply"));
    read(A);
    const next = statSync(A).size;
    append(A, cAsst("s1", "m2", "second reply", "end_turn"));

    failQueueOnce(db, (c) => c.includes("second reply"));
    read(A);
    expect(queued(db, "s1")).toEqual(["question", "first reply"]);
    expect(db.getFileOffset(A)).toBe(next);

    retry(A);
    expect(queued(db, "s1")).toEqual(["question", "first reply", "second reply"]);
  });

  it("still withholds a vault get's output when it is read again", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "read my key"), cToolUse("s1", "m1", "toolu_1", "engram vault get API_TOKEN"));
    read(A);
    append(A, cToolResult("s1", "toolu_1", "tok-123-abc"));

    failQueueOnce(db);
    read(A);
    retry(A);
    expect(queued(db, "s1")).toEqual(["read my key", REDACTED_TOOL_OUTPUT]);
  });

  it("doesn't read past an opt-out that couldn't be recorded", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    read(A);
    const optOut = statSync(A).size;
    append(A, cUser("s1", "don't save this to engram"), cUser("s1", "the plans"));

    vi.spyOn(db, "excludeSession").mockImplementationOnce(() => {
      throw new Error(FULL);
    });
    read(A);
    // The line after the opt-out must not be queued while the opt-out
    // hasn't taken.
    expect(queued(db, "s1")).toEqual(["hello"]);
    expect(db.isSessionExcluded("s1")).toBe(false);
    expect(db.getFileOffset(A)).toBe(optOut);

    retry(A);
    expect(db.isSessionExcluded("s1")).toBe(true);
    expect(queued(db, "s1")).toEqual([]);
  });

  it("holds a Codex rollout at the line too", () => {
    const { db, read, retry } = daemon("codex");
    const A = codexPath(UUID_A);
    append(A, xMeta({ id: UUID_A, cwd: "/work/a" }), xMsg("user", "first"));
    read(A);
    const answerAt = statSync(A).size + Buffer.byteLength(lineOf(xTurn("/work/a/sub")));
    append(A, xTurn("/work/a/sub"), xMsg("assistant", "second"));

    failQueueOnce(db);
    read(A);
    expect(db.getFileOffset(A)).toBe(answerAt);
    expect(queued(db, UUID_A)).toEqual(["first"]);

    retry(A);
    expect(queued(db, UUID_A)).toEqual(["first", "second"]);
  });

  it("keeps reading other files while one is held", () => {
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    const B = claudePath("b");
    append(A, cUser("sa", "a asks"));
    append(B, cUser("sb", "b asks"));

    failQueueOnce(db, (c) => c.includes("a asks"));
    read(A);
    read(B);
    expect(queued(db, "sa")).toEqual([]);
    expect(queued(db, "sb")).toEqual(["b asks"]);
    expect(db.getFileOffset(B)).toBe(statSync(B).size);

    retry(A);
    expect(queued(db, "sa")).toEqual(["a asks"]);
  });

  it("still skips a line the parser can't make sense of", () => {
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "before"));
    appendFileSync(A, "{not json\n");
    append(A, cUser("s1", "after"));
    read(A);
    expect(queued(db, "s1")).toEqual(["before", "after"]);
    expect(recordCaptureStall).not.toHaveBeenCalled();
  });
});

describe("retrying a held file", () => {
  it("backs off 5 s, 30 s, 2 min, then every 5 min, and writes to the file don't hurry it", () => {
    vi.useFakeTimers();
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    const enqueue = failQueue(db);
    read(A);
    expect(enqueue).toHaveBeenCalledTimes(1);

    // The host keeps writing; each write is a change event.
    append(A, cUser("s1", "more"));
    read(A);
    expect(enqueue).toHaveBeenCalledTimes(1);

    let calls = 1;
    for (const delay of [...RETRY_DELAYS_MS, RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]]) {
      vi.advanceTimersByTime(delay - 1);
      expect(enqueue).toHaveBeenCalledTimes(calls);
      vi.advanceTimersByTime(1);
      expect(enqueue).toHaveBeenCalledTimes(++calls);
    }

    enqueue.mockRestore();
    vi.advanceTimersByTime(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
    expect(queued(db, "s1")).toEqual(["hello", "more"]);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a change event once the wait is over reads the file, and the timer is cancelled", () => {
    vi.useFakeTimers();
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    failQueueOnce(db);
    read(A);
    expect(vi.getTimerCount()).toBe(1);

    vi.setSystemTime(Date.now() + RETRY_DELAYS_MS[0]);
    read(A);
    expect(queued(db, "s1")).toEqual(["hello"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets go of a held file that is deleted", () => {
    vi.useFakeTimers();
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    failQueue(db);
    read(A);
    rmSync(A);

    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets go of a held file that is cut short", () => {
    vi.useFakeTimers();
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    failQueue(db);
    read(A);
    writeFileSync(A, "");

    vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop() cancels the retry", () => {
    vi.useFakeTimers();
    const { db, read, watcher } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "hello"));
    failQueue(db);
    read(A);
    expect(vi.getTimerCount()).toBe(1);
    watcher.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("stopping while daemon.db can't queue", () => {
  it("doesn't throw or save past the reply it couldn't queue, and the next start queues it once", () => {
    const first = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", "question"));
    first.read(A);
    const replyStart = statSync(A).size;
    append(A, cAsst("s1", "m1", "answer"));
    first.read(A); // the parser holds the reply

    const enqueue = failQueue(first.db);
    expect(() => first.watcher.stop()).not.toThrow();
    expect(first.db.getFileOffset(A)).toBe(replyStart);
    enqueue.mockRestore();

    const second = daemon("claude", first.db);
    second.read(A);
    second.watcher.stop();
    expect(queued(first.db, "s1")).toEqual(["question", "answer"]);
  });
});

describe("DaemonDb.excludeSession", () => {
  it("opts a session out in one transaction: all of it, or none of it", () => {
    const db = openDb();
    db.enqueuePendingSession("s1", META, [{ role: "user", content: "hello" }]);

    vi.spyOn(db, "dropPendingSession").mockImplementationOnce(() => {
      throw new Error(FULL);
    });
    expect(() => db.excludeSession("s1", "in-chat opt-out")).toThrow(FULL);
    // Excluded with its queue still in place, the queue would be sent:
    // an excluded session never reaches the drop again.
    expect(db.isSessionExcluded("s1")).toBe(false);
    expect(queued(db, "s1")).toEqual(["hello"]);

    expect(db.excludeSession("s1", "in-chat opt-out")).toEqual({ conversationId: null, dropped: 1 });
    expect(db.isSessionExcluded("s1")).toBe(true);
    expect(queued(db, "s1")).toEqual([]);
  });
});
