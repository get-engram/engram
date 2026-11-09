import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationError, EngramError, type Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine. The classifiers stay real.
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  recordCaptureStall: vi.fn(),
  recordCaptureResumed: vi.fn(),
  recordSignedOut: vi.fn(),
  recordSignedIn: vi.fn(),
  updatePending: vi.fn(),
  recordNextRetry: vi.fn(),
  recordDeletesRefused: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: () => false,
}));

import { DaemonDb } from "../daemon/db.js";
import { FIXED_KEY_FP, Syncer, keyFingerprint, type KeySource } from "../daemon/syncer.js";
import {
  isScopeRefusal,
  recordDeletesRefused,
  recordFailure,
  recordSignedIn,
  recordSuccess,
} from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#597: an opt-out's delete refused because the API key may not
// delete conversations was tried again at every flush, every 2 s, and
// logged each time, for as long as the key was in use. A key's permissions
// don't change, so asking again only got the same answer.
//
// Now the delete is kept (the user asked for that conversation to be
// removed), it isn't tried again with that key, and the status says once
// that the key can't delete. A different key gets its own try, and so does
// a restart.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The delete tool's refusal of a key without the 'delete' scope
 *  (apps/mcp-server scopeError). */
const SCOPE_BODY = {
  error: "insufficient_scope",
  required: "delete",
  message:
    "This API key does not have the 'delete' permission. Create a key with this scope at getengram.app/dashboard.",
};

/** What the SDK throws (packages/sdk/src/transport.ts) for a tool's
 *  refusal: the tool's JSON body as the message, no code, no status. */
const refusal = (body: object) => new EngramError(JSON.stringify(body));
const httpError = (status: number) => new EngramError("", "undefined", status);
const offline = () => new EngramError("Network error: fetch failed");

type Op = "create" | "store" | "delete";
type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  /** Every request, with the key it carried. */
  requests: Array<{ op: Op; key: string }> = [];
  /** What each conversation holds. */
  stored = new Map<string, string[]>();
  /** Conversations deleted through the daemon. */
  deleted: string[] = [];
  /** Keys without the 'delete' scope. */
  cantDelete = new Set<string>();
  /** Thrown by every delete while set, before the key is looked at: the
   *  network. */
  deleteError: Error | null = null;
  /** While set, every delete waits for it. */
  deleteGate: Promise<void> | null = null;
  /** Thrown by every send while set. */
  storeError: Error | null = null;
  private seq = 0;

  /** A client for one key, as `new Engram({ apiKey })` makes. */
  client(key = "key-1"): Engram {
    return {
      createConversation: async () => {
        this.requests.push({ op: "create", key });
        const id = `conv_${++this.seq}`;
        this.stored.set(id, []);
        return { conversationId: id };
      },
      store: async (p: StoreParams) => {
        this.requests.push({ op: "store", key });
        if (this.storeError) throw this.storeError;
        this.stored.get(p.conversationId)?.push(...p.messages.map((m) => m.content));
        return { stored: p.messages.length };
      },
      deleteConversation: async (id: string) => {
        this.requests.push({ op: "delete", key });
        if (this.deleteGate) await this.deleteGate;
        if (this.deleteError) throw this.deleteError;
        // The delete tool checks the key's scope first.
        if (this.cantDelete.has(key)) throw refusal(SCOPE_BODY);
        if (!this.stored.has(id)) throw refusal({ error: "Conversation not found" });
        this.deleted.push(id);
        this.stored.delete(id);
      },
    } as unknown as Engram;
  }

  /** Deletes asked for, with `key` if given. */
  deletes(key?: string): number {
    return this.requests.filter((r) => r.op === "delete" && (key === undefined || r.key === key)).length;
  }

  /** True when a conversation on the server holds `content`. */
  holds(content: string): boolean {
    return [...this.stored.values()].some((m) => m.includes(content));
  }
}

let dir: string;
let db: DaemonDb;
let server: FakeServer;
let syncer: Syncer;

const meta = (sessionId: string): SessionMeta => ({
  sessionId,
  projectDir: "myproj",
  cwd: "/work/myproj",
  host: "claude-code",
});

const msgs = (...contents: string[]): ParsedMessage[] =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Move the clock and run one flush. */
async function flushAfter(ms: number): Promise<void> {
  later(ms);
  await syncer.flush();
}

/** Each of `sessions` captures one message, and a flush syncs them. */
async function synced(...sessions: string[]): Promise<void> {
  for (const s of sessions) await syncer.onMessages(s, meta(s), msgs(`${s}-m1`));
  await syncer.flush();
  for (const s of sessions) if (!server.holds(`${s}-m1`)) throw new Error(`${s} didn't sync`);
}

/** The user opts out of session `s` in chat. */
const optOut = (s: string) => syncer.onMessages(s, meta(s), msgs("engram: ignore"));

/** Let the daemon's pending work run until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setImmediate(r));
  expect(done()).toBe(true);
}

const logged = () => vi.mocked(console.log).mock.calls.map((c) => c.join(" "));
const errorLog = () => vi.mocked(console.error).mock.calls.map((c) => c.join(" "));
/** The daemon's log lines saying the key can't delete. */
const refusedLines = () => errorLog().filter((l) => l.includes("this API key can't delete conversations"));
/** Each count the status was given. */
const refusedCounts = () => vi.mocked(recordDeletesRefused).mock.calls.map((c) => c[0]);

/** A configured key that can change, of one account: every key here is
 *  the same account's (a rotated key). */
function keySource(initial: string): KeySource & { configured: string | undefined } {
  const keys = {
    current: initial,
    configured: initial as string | undefined,
    async read(): Promise<string | undefined> {
      return keys.configured;
    },
    connect: (key: string) => server.client(key),
    async ownedKeys(_key: string, hashes: string[]): Promise<string[]> {
      return hashes;
    },
  };
  return keys;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-delete-scope-"));
  db = new DaemonDb(join(dir, "daemon.db"));
  server = new FakeServer();
  server.cantDelete.add("key-1");
  syncer = new Syncer(db, server.client());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const f of [recordSuccess, recordFailure, recordSignedIn, recordDeletesRefused]) {
    vi.mocked(f).mockClear();
  }
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("an opt-out the API key may not delete (engram#597)", () => {
  it("is refused once and kept, and not tried again with that key however long it runs", async () => {
    await synced("s1");
    await optOut("s1");
    expect(server.deletes()).toBe(1);

    // It used to be tried again at every flush, and logged each time.
    for (const ms of [2_000, 2_000, 30_000, 10 * MIN, HOUR, DAY, 3 * DAY]) await flushAfter(ms);
    expect(server.deletes()).toBe(1);

    // Kept: the user asked for that conversation to be removed.
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);
    expect(server.deleted).toEqual([]);

    // Said once in the log, and in the status, which is given the same
    // count at each flush (status.ts writes it only when it changes).
    expect(refusedLines()).toEqual([
      "[engram] opt-out delete refused for conv_1: this API key can't delete conversations. " +
        "1 opt-out delete kept on this machine, waiting for a key that can; not retried with this one. " +
        "Run 'engram status' for details.",
    ]);
    expect(new Set(refusedCounts())).toEqual(new Set([1]));
  });

  it("doesn't hold up syncing: the key still saves, and that is no failure", async () => {
    await synced("s1");
    await optOut("s1");

    await syncer.onMessages("s2", meta("s2"), msgs("s2-m1"));
    await flushAfter(2_000);
    await syncer.onMessages("s2", meta("s2"), msgs("s2-m2"));
    await flushAfter(2_000);
    expect(server.holds("s2-m1")).toBe(true);
    expect(server.holds("s2-m2")).toBe(true);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledTimes(3);
  });

  it("an opt-out made meanwhile asks nothing of the server, is counted, and the log says why", async () => {
    await synced("s1", "s2");
    await optOut("s1");
    const deletes = server.deletes();

    await optOut("s2");
    await flushAfter(2_000);
    expect(server.deletes()).toBe(deletes);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(2);
    expect(refusedCounts().at(-1)).toBe(2);
    expect(logged()).toContain(
      "[engram] session s2 excluded (in-chat opt-out) — 0 queued messages dropped; " +
        "the synced copy waits to be deleted: this API key can't delete conversations",
    );
    expect(refusedLines()).toHaveLength(1);
  });

  it("is tried once more after a restart, with one request for all that wait", async () => {
    await synced("s1", "s2", "s3");
    for (const s of ["s1", "s2", "s3"]) await optOut(s);
    expect(server.deletes()).toBe(1);
    expect(refusedCounts().at(-1)).toBe(3);

    // The daemon restarts with the same key.
    syncer = new Syncer(db, server.client());
    await flushAfter(2_000);
    expect(server.deletes()).toBe(2);
    for (const ms of [2_000, HOUR]) await flushAfter(ms);
    expect(server.deletes()).toBe(2);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(3);
    expect(refusedLines()).toHaveLength(2);
    expect(refusedLines()[1]).toContain("3 opt-out deletes kept on this machine");
  });

  it("is tried by each new key: one that may delete removes them all", async () => {
    const keys = keySource("key-a");
    server.cantDelete = new Set(["key-a", "key-c"]);
    syncer = new Syncer(db, null, null, keys);
    await synced("s1", "s2");
    await optOut("s1");
    await optOut("s2");
    expect(server.deletes("key-a")).toBe(1);
    expect(refusedCounts().at(-1)).toBe(2);

    // Another key without the permission: it gets its own try, and says so.
    keys.configured = "key-c";
    for (const ms of [2_000, 2_000, HOUR]) await flushAfter(ms);
    expect(server.deletes("key-c")).toBe(1);
    expect(refusedLines()).toHaveLength(2);
    expect(db.getPendingRemoteDeletes(keyFingerprint("key-c"))).toHaveLength(2);

    // A key that may delete. Signing in with it clears the status's
    // refusal, and it deletes both.
    vi.mocked(recordSignedIn).mockClear();
    keys.configured = "key-b";
    await flushAfter(2_000);
    expect(recordSignedIn).toHaveBeenCalledTimes(1);
    expect(server.deletes("key-b")).toBe(2);
    expect(server.deleted.sort()).toEqual(["conv_1", "conv_2"]);
    for (const key of ["key-a", "key-b", "key-c"]) {
      expect(db.getPendingRemoteDeletes(keyFingerprint(key))).toEqual([]);
    }
    expect(refusedLines()).toHaveLength(2);
  });

  it("two passes over the deletes, both refused, say it once and count them all", async () => {
    await synced("s1", "s2");
    // Offline when the user opts out of s1: kept, and tried again later.
    server.deleteError = offline();
    await optOut("s1");
    expect(server.deletes()).toBe(1);
    server.deleteError = null;

    // A flush's delete is in flight when the user opts out of s2, whose
    // own pass asks for the first delete again.
    let open = () => {};
    server.deleteGate = new Promise<void>((r) => (open = r));
    later(HOUR);
    const flushing = syncer.flush();
    await until(() => server.deletes() === 2);
    const optingOut = optOut("s2");
    await until(() => server.deletes() === 3);
    server.deleteGate = null;
    open();
    await Promise.all([flushing, optingOut]);

    expect(refusedLines()).toHaveLength(1);
    expect(refusedLines()[0]).toContain("2 opt-out deletes kept on this machine");
    // Counted from daemon.db by both: s2's opt-out is waiting too.
    expect(refusedCounts()).toEqual([2, 2]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(2);

    // Neither pass went on to the next delete, nor does a flush after.
    await flushAfter(2_000);
    expect(server.deletes()).toBe(3);
  });

  it("a pass between deletes when another pass is refused goes no further", async () => {
    await synced("s1", "s2", "s3");
    // Offline when the user opts out of s1 and s2: both kept, tried again later.
    server.deleteError = offline();
    await optOut("s1");
    await optOut("s2");
    expect(server.deletes()).toBe(2);
    server.deleteError = null;

    // A flush asks for the first again, and its answer is slow to come…
    let answerFlush = () => {};
    server.deleteGate = new Promise<void>((r) => (answerFlush = r));
    later(HOUR);
    const flushing = syncer.flush();
    await until(() => server.deletes() === 3);
    // …while the user opts out of s3, and that pass is refused first.
    let answerOptOut = () => {};
    server.deleteGate = new Promise<void>((r) => (answerOptOut = r));
    const optingOut = optOut("s3");
    await until(() => server.deletes() === 4);
    server.deleteGate = null;
    answerOptOut();
    await optingOut;
    expect(refusedLines()).toHaveLength(1);

    // The flush's request is lost on the network. It doesn't go on to the
    // second delete: the key can't delete.
    server.deleteError = offline();
    answerFlush();
    await flushing;
    expect(server.deletes()).toBe(4);
    server.deleteError = null;
    for (const ms of [2_000, HOUR]) await flushAfter(ms);
    expect(server.deletes()).toBe(4);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(3);
    expect(refusedLines()).toHaveLength(1);
  });

  it("other failures are still tried again: a network error, then the refusal", async () => {
    await synced("s1");
    server.deleteError = offline();
    await optOut("s1");
    expect(server.deletes()).toBe(1);
    expect(refusedLines()).toEqual([]);

    server.deleteError = null;
    await flushAfter(HOUR);
    expect(server.deletes()).toBe(2);
    expect(refusedLines()).toHaveLength(1);
    await flushAfter(HOUR);
    expect(server.deletes()).toBe(2);
  });

  it("is the server's answer: a rate limit before it doesn't make the next one wait longer", async () => {
    // Every wait at the top of its range: 5 s, then 10 (engram#596).
    vi.spyOn(Math, "random").mockReturnValue(1 - 1e-9);
    const holds = () => errorLog().filter((l) => l.includes("rate limited — sending nothing for"));
    await synced("s1", "s2");
    server.deleteError = httpError(429);
    await optOut("s1");
    expect(holds()).toHaveLength(1);
    expect(holds()[0]).toContain("sending nothing for 5s,");

    server.deleteError = null;
    await flushAfter(5_000);
    expect(server.deletes()).toBe(2);
    expect(refusedLines()).toHaveLength(1);

    // The refusal went through, so the schedule starts over: the next rate
    // limit waits 5 s, not 10.
    server.storeError = httpError(429);
    await syncer.onMessages("s2", meta("s2"), msgs("s2-m2"));
    await flushAfter(2_000);
    expect(holds()).toHaveLength(2);
    expect(holds()[1]).toContain("sending nothing for 5s,");
  });
});

describe("isScopeRefusal (engram#597)", () => {
  it.each([
    ["the delete tool's refusal", refusal(SCOPE_BODY), true],
    ["the refusal after other text", new EngramError(`Tool error: ${JSON.stringify(SCOPE_BODY)}`), true],
    ["a refusal for another permission", refusal({ error: "insufficient_scope", required: "write" }), true],
    ["the phrase in plain text", new Error("insufficient_scope"), false],
    ["the phrase quoted in plain text", new Error('the server said "insufficient_scope"'), false],
    ["the phrase as a message, not the code", refusal({ error: "forbidden", message: "insufficient_scope" }), false],
    ["a missing conversation", refusal({ error: "Conversation not found" }), false],
    ["a full memory", refusal({ error: "storage_full" }), false],
    ["a rejected key", new AuthenticationError(), false],
    ["an HTTP 403", new EngramError("", "undefined", 403), false],
    ["a string", "insufficient_scope", false],
    ["nothing", undefined, false],
  ])("%s: %s", (_, err, expected) => {
    expect(isScopeRefusal(err)).toBe(expected);
  });
});
