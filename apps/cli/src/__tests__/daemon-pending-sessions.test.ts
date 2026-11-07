import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine. detectOptOut and classifyError stay real.
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: () => false,
}));

import {
  DaemonDb,
  pendingConversationId,
  recoveredSessionMeta,
} from "../daemon/db.js";
import { Syncer } from "../daemon/syncer.js";
import { recordSuccess } from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#370: a session's conversation is created at flush time, and until
// then its messages wait under pending:<sessionId>. The session record used
// to live only in memory — a restart, or any failed create, stranded the
// queued messages forever. These tests pin "every queued message reaches the
// server exactly once, whatever happens in between".

type CreateParams = {
  title?: string;
  agentId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

class FakeEngram {
  /** Every create attempt, failed or not. */
  creates: CreateParams[] = [];
  conversations = new Map<string, CreateParams>();
  stored = new Map<string, string[]>();
  deleted: string[] = [];
  /** Errors for the next create attempts, in order. */
  failCreates: Error[] = [];
  /** Error for every create attempt while set. */
  createError: Error | null = null;
  /** While set, creates wait on it — lets a test act mid-create. */
  gate: Promise<void> | null = null;
  onCreate: (() => void) | null = null;
  private seq = 0;

  async createConversation(params: CreateParams) {
    this.creates.push(params);
    this.onCreate?.();
    if (this.gate) await this.gate;
    const err = this.failCreates.shift() ?? this.createError;
    if (err) throw err;
    const id = `conv_${++this.seq}`;
    this.conversations.set(id, params);
    return { conversationId: id };
  }

  async store(p: { conversationId: string; messages: Array<{ content: string }> }) {
    const list = this.stored.get(p.conversationId) ?? [];
    list.push(...p.messages.map((m) => m.content));
    this.stored.set(p.conversationId, list);
    return { stored: p.messages.length };
  }

  async deleteConversation(id: string) {
    this.deleted.push(id);
  }

  client(): Engram {
    return this as unknown as Engram;
  }

  /** Messages the server holds for a session, via daemon.db's mapping. */
  copyOf(db: DaemonDb, sessionId: string): string[] | undefined {
    const conv = db.getConversationId(sessionId);
    return conv ? this.stored.get(conv) : undefined;
  }
}

let dir: string;
let dbPath: string;
const opened: DaemonDb[] = [];

function openDb(): DaemonDb {
  const db = new DaemonDb(dbPath);
  opened.push(db);
  return db;
}

const meta = (sessionId: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  sessionId,
  projectDir: "myproj",
  cwd: "/work/myproj",
  gitBranch: "main",
  host: "claude-code",
  ...extra,
});

const msgs = (...contents: string[]): ParsedMessage[] =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Hold the next create in flight until `release()`. */
function holdCreate(client: FakeEngram) {
  let release!: () => void;
  client.gate = new Promise<void>((r) => (release = r));
  const started = new Promise<void>((r) => (client.onCreate = r));
  return { started, release: () => release() };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-pending-"));
  dbPath = join(dir, "daemon.db");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(recordSuccess).mockClear();
});

afterEach(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("pending sessions are durable (engram#370)", () => {
  it("messages queued before a restart reach the server after it", async () => {
    const before = openDb();
    await new Syncer(before, new FakeEngram().client()).onMessages(
      "s1",
      meta("s1"),
      msgs("question", "answer"),
    );
    before.close(); // the daemon dies before its first flush

    const db = openDb();
    const server = new FakeEngram();
    await new Syncer(db, server.client()).flush();

    expect(server.creates).toHaveLength(1);
    expect(server.copyOf(db, "s1")).toEqual(["question", "answer"]);
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
    // The session's own metadata survived the restart (not rebuilt).
    const created = server.conversations.get(db.getConversationId("s1")!)!;
    expect(created.title).toMatch(/^myproj \(/);
    expect(created.metadata).toMatchObject({ cwd: "/work/myproj", gitBranch: "main" });
    expect(created.metadata).not.toHaveProperty("recovered");
  });

  it("a failed create keeps the session, retries it on a schedule, and doesn't hold up others", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    await syncer.onMessages("s-a", meta("s-a"), msgs("a1"));
    await syncer.onMessages("s-b", meta("s-b"), msgs("b1"));
    server.failCreates = [new Error("fetch failed")]; // s-a's create (oldest first)

    await syncer.flush();
    expect(server.creates).toHaveLength(2);
    expect(server.copyOf(db, "s-a")).toBeUndefined();
    expect(server.copyOf(db, "s-b")).toEqual(["b1"]);
    expect(db.getPendingSessions().map((s) => s.sessionId)).toEqual(["s-a"]);
    expect(recordSuccess).not.toHaveBeenCalled();

    // Inside the retry delay: no new attempt, and still not "healthy".
    later(10_000);
    await syncer.flush();
    expect(server.creates).toHaveLength(2);
    expect(recordSuccess).not.toHaveBeenCalled();

    // The waiting session keeps collecting messages.
    await syncer.onMessages("s-a", meta("s-a"), msgs("a2"));

    later(25_000); // past the first 30 s delay
    await syncer.flush();
    expect(server.creates).toHaveLength(3);
    expect(server.copyOf(db, "s-a")).toEqual(["a1", "a2"]);
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalled();
  });

  it("an auth failure keeps every session for after the key is fixed", async () => {
    const db = openDb();
    const rejected = new FakeEngram();
    rejected.createError = new Error("401 Unauthorized");
    const syncer = new Syncer(db, rejected.client());
    await syncer.onMessages("s1", meta("s1"), msgs("keep"));
    await syncer.flush();
    expect(db.getPendingSessions()).toHaveLength(1);

    // `engram login` + daemon restart
    const server = new FakeEngram();
    await new Syncer(db, server.client()).flush();
    expect(server.copyOf(db, "s1")).toEqual(["keep"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a full memory keeps every waiting session, not just the first batch, and the backoff holds", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    const ids = Array.from({ length: 7 }, (_, i) => `s${i}`); // > one batch of 5
    for (const id of ids) await syncer.onMessages(id, meta(id), msgs(`m-${id}`));
    server.createError = new Error('402 {"error":"storage_full","used":100,"limit":100}');

    await syncer.flush();
    expect(db.getPendingSessions()).toHaveLength(7);
    const attempts = server.creates.length;

    // The billing backoff must hold: a flush 2 s later doesn't call again.
    later(2_000);
    await syncer.flush();
    expect(server.creates).toHaveLength(attempts);

    // Space freed; once the backoff ends, every session lands.
    server.createError = null;
    later(5 * 60_000);
    await syncer.flush();
    for (const id of ids) expect(server.copyOf(db, id)).toEqual([`m-${id}`]);
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("messages that arrive while the create is in flight land in the same conversation", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    const hold = holdCreate(server);

    await syncer.onMessages("s1", meta("s1"), msgs("first"));
    const flushing = syncer.flush();
    await hold.started;
    await syncer.onMessages("s1", meta("s1"), msgs("second"));
    hold.release();
    await flushing;

    expect(server.creates).toHaveLength(1);
    expect(server.copyOf(db, "s1")).toEqual(["first", "second"]);
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("an opt-out while the session waits drops it: nothing is created or sent", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    await syncer.onMessages("s1", meta("s1"), msgs("private"));
    await syncer.onMessages("s1", meta("s1"), msgs("don't save this to engram"));
    // Dropped at once, not left for the flush to clean up.
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
    await syncer.flush();

    expect(server.creates).toHaveLength(0);
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("an opt-out during the create sends nothing and deletes the new conversation", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    const hold = holdCreate(server);

    await syncer.onMessages("s1", meta("s1"), msgs("private"));
    const flushing = syncer.flush();
    await hold.started;
    await syncer.onMessages("s1", meta("s1"), msgs("don't save this to engram"));
    hold.release();
    await flushing;
    await syncer.flush(); // step 0 carries out the scheduled remote delete

    expect(server.deleted).toEqual(["conv_1"]);
    expect(server.stored.get("conv_1")).toBeUndefined();
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a waiting session whose stored metadata is unreadable still syncs", async () => {
    const db = openDb();
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    await syncer.onMessages("s1", meta("s1"), msgs("keep me"));
    const raw = new Database(dbPath);
    raw.prepare("UPDATE pending_sessions SET meta = '{' WHERE session_id = 's1'").run();
    raw.close();

    await syncer.flush();
    expect(server.copyOf(db, "s1")).toEqual(["keep me"]);
    expect(server.conversations.get("conv_1")?.metadata).toMatchObject({
      sessionId: "s1",
      recovered: true,
    });
  });
});

describe("rows orphaned by an older daemon (engram#370)", () => {
  const claudeId = "0a1b2c3d-0000-4000-8000-000000000001";
  const codexId = "0a1b2c3d-0000-4000-8000-000000000002";
  const lostId = "0a1b2c3d-0000-4000-8000-000000000003";

  it("adopts them and syncs each with metadata rebuilt from its transcript path", async () => {
    const db = openDb();
    // What a pre-#370 daemon left behind: rows under pending:<id>, no record.
    db.enqueue(pendingConversationId(claudeId), msgs("c1", "c2"));
    db.enqueue(pendingConversationId(codexId), msgs("x1"));
    db.enqueue(pendingConversationId(lostId), msgs("l1"));
    db.setFileOffset(`/Users/u/.claude/projects/-Users-u-code-myproj/${claudeId}.jsonl`, 10);
    db.setFileOffset(
      `/Users/u/.codex/sessions/2026/07/23/rollout-2026-07-23T04-46-50-${codexId}.jsonl`,
      10,
    );
    // Contains the id but is not its transcript — must not lend its project.
    db.setFileOffset(`/Users/u/.claude/projects/-Users-u-code-other/${lostId}-notes.jsonl`, 10);

    const server = new FakeEngram();
    await new Syncer(db, server.client()).flush();

    const conv = (id: string) => server.conversations.get(db.getConversationId(id)!)!;
    expect(conv(claudeId).title).toMatch(/^myproj \(/);
    expect(conv(claudeId).agentId).toBe("claude-code");
    expect(conv(claudeId).metadata).toMatchObject({ sessionId: claudeId, recovered: true });
    expect(conv(codexId).agentId).toBe("codex");
    expect(conv(codexId).metadata).toMatchObject({ sessionId: codexId, recovered: true });
    expect(conv(lostId).title).toMatch(/^claude-code \(/);
    expect(conv(lostId).metadata).toMatchObject({ projectDir: "", recovered: true });

    expect(server.copyOf(db, claudeId)).toEqual(["c1", "c2"]);
    expect(server.copyOf(db, codexId)).toEqual(["x1"]);
    expect(server.copyOf(db, lostId)).toEqual(["l1"]);
    expect(db.getPendingCount()).toBe(0);
    expect(db.getPendingSessions()).toEqual([]);
  });

  it("moves an already-mapped session's leftover rows without a second conversation", async () => {
    const db = openDb();
    db.setSessionMap("s1", "conv_existing", { projectDir: "p" });
    db.enqueue(pendingConversationId("s1"), msgs("left", "over"));

    const server = new FakeEngram();
    await new Syncer(db, server.client()).flush();

    expect(server.creates).toHaveLength(0);
    expect(server.stored.get("conv_existing")).toEqual(["left", "over"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a failed orphan check is retried and isn't reported healthy meanwhile", async () => {
    const db = openDb();
    db.enqueue(pendingConversationId("s1"), msgs("old"));
    const server = new FakeEngram();
    const syncer = new Syncer(db, server.client());
    const adopt = vi
      .spyOn(db, "adoptOrphanedPendingRows")
      .mockImplementationOnce(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      });

    await syncer.flush();
    expect(server.creates).toHaveLength(0);
    expect(db.getPendingCount()).toBe(1);
    expect(recordSuccess).not.toHaveBeenCalled();

    await syncer.flush();
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(server.copyOf(db, "s1")).toEqual(["old"]);
    expect(recordSuccess).toHaveBeenCalled();
  });

  it("never creates a conversation for an opted-out session's leftover rows", async () => {
    const db = openDb();
    db.markSessionExcluded("s1", "in-chat opt-out");
    db.enqueue(pendingConversationId("s1"), msgs("private"));

    const server = new FakeEngram();
    await new Syncer(db, server.client()).flush();

    expect(server.creates).toHaveLength(0);
    expect(db.getPendingCount()).toBe(0);
    expect(db.getPendingSessions()).toEqual([]);
  });

  it("leaves a live session's own record alone", () => {
    const db = openDb();
    db.enqueuePendingSession("s1", meta("s1", { projectDir: "real" }), msgs("m"));
    expect(db.adoptOrphanedPendingRows()).toEqual([]);
    expect(db.getPendingSessions()).toEqual([
      { sessionId: "s1", meta: meta("s1", { projectDir: "real" }) },
    ]);
  });
});

describe("DaemonDb pending-session writes are all-or-nothing", () => {
  it("a session is never recorded without its messages, or the reverse", () => {
    const db = openDb();
    const bad = [{ role: "user", content: null }] as unknown as ParsedMessage[];
    expect(() => db.enqueuePendingSession("s1", meta("s1"), bad)).toThrow();
    expect(db.getPendingSessions()).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a failed completion leaves the messages queued under the session", () => {
    const db = openDb();
    db.enqueuePendingSession("s1", meta("s1"), msgs("a", "b"));
    const raw = new Database(dbPath);
    raw.exec(
      "CREATE TRIGGER no_forget BEFORE DELETE ON pending_sessions BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    raw.close();

    expect(() => db.completePendingSession("s1", "conv_1", { projectDir: "p" })).toThrow();
    expect(db.getConversationId("s1")).toBeNull();
    expect(db.dequeue(pendingConversationId("s1"), 10)).toHaveLength(2);
    expect(db.getPendingSessions()).toHaveLength(1);
  });
});

describe("recoveredSessionMeta", () => {
  it("reads host and project from a Claude Code transcript path", () => {
    expect(
      recoveredSessionMeta("s", "/Users/u/.claude/projects/-Users-u-code-engram/s.jsonl"),
    ).toEqual({ sessionId: "s", projectDir: "engram", host: "claude-code", recovered: true });
  });

  it("recognises a Codex rollout", () => {
    expect(
      recoveredSessionMeta("s", "/Users/u/.codex/sessions/2026/07/23/rollout-2026-07-23T04-46-50-s.jsonl"),
    ).toEqual({ sessionId: "s", projectDir: "", host: "codex", recovered: true });
  });

  it("falls back to an empty placeholder", () => {
    const placeholder = { sessionId: "s", projectDir: "", recovered: true };
    expect(recoveredSessionMeta("s", undefined)).toEqual(placeholder);
    expect(recoveredSessionMeta("s", "/tmp/s.jsonl")).toEqual(placeholder);
  });
});
