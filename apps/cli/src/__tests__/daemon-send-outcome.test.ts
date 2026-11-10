import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationError, EngramError, NotFoundError, type Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine. classifyError stays real.
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
import { FIXED_KEY_FP, Syncer, keyFingerprint, type Account } from "../daemon/syncer.js";
import { DEFAULT_BASE_URL } from "../server-url.js";
import { RETRY_BASE_MS } from "../daemon/backoff.js";
import {
  recordFailure,
  recordNextRetry,
  recordSignedIn,
  recordSignedOut,
  recordSuccess,
} from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#580: a send that failed used to leave the flush looking like a
// successful sync. Status read "healthy" while nothing was saved, and the
// billing backoff a full memory had just entered was cleared again, so the
// account was retried every 2 s for as long as it stayed full. These tests
// pin "a flush is a sync only when everything it tried went out".

/** The bodies the server's append_messages returns (SDK error messages). */
const STORAGE_FULL = JSON.stringify({
  error: "storage_full",
  message: "Engram's memory is full (10,000 messages).",
  limit: 10_000,
  used: 10_000,
  tier: "free",
});
const MONTHLY_LIMIT = JSON.stringify({
  error: "message_limit_exceeded",
  message: "Message limit reached (100000/100000 this month on the pro plan).",
  limit: 100_000,
  used: 100_000,
  tier: "pro",
});

/**
 * What the SDK throws (packages/sdk/src/transport.ts) for a tool's refusal:
 * the tool's JSON body as the message, with no code and no status.
 */
const refusal = (body: object) => new EngramError(JSON.stringify(body));

/**
 * What the SDK throws for an HTTP error whose JSON body has a string
 * `error`, like the rate limiter's 429: the message is empty, the code is
 * the string "undefined", and only the status says what happened.
 */
const httpError = (status: number) => new EngramError("", "undefined", status);

/** What the SDK throws while Engram is paused for maintenance: the tool's
 *  refusal (apps/mcp-server assertWritesEnabled). */
const writesPaused = () =>
  refusal({ error: "writes_paused", message: "Engram is paused for a few minutes of scheduled maintenance." });

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };
type Op = "create" | "store" | "delete" | "owned";

/** Every key these tests use. */
const TEST_KEYS = ["key-1", "key-old", "key-new", "key-typo"];

class FakeServer {
  /** Every send attempt, failed or not. */
  sends: StoreParams[] = [];
  creates = 0;
  stored = new Map<string, string[]>();
  /** Error for every send while set. */
  sendError: Error | null = null;
  /** Error for every conversation create while set. */
  createError: Error | null = null;
  /** Per-send failure, decided from what is being sent. */
  failWhen: ((p: StoreParams) => Error | null) | null = null;
  /** Per-send latency in real milliseconds (only Date is faked). */
  delayWhen: ((p: StoreParams) => number) | null = null;
  /** Error for every delete while set. */
  deleteError: Error | null = null;
  /** Conversations deleted. */
  deleted: string[] = [];
  /**
   * The keys the server accepts; null accepts any. Any other key gets what
   * the SDK throws for an HTTP 401 or 403: AuthenticationError.
   */
  acceptedKeys: Set<string> | null = null;
  /** Every request, with the key it carried. */
  requests: Array<{ op: Op; key: string }> = [];
  /** Each key's account; a key not listed is an account of its own. */
  accounts = new Map<string, string>();
  private seq = 0;

  /** POST /api/account/owned-keys, as worker-main.ts asks it: which of
   *  `hashes` are fingerprints of keys of `key`'s account. */
  async ownedKeys(key: string, hashes: string[]): Promise<string[]> {
    this.requests.push({ op: "owned", key });
    if (this.acceptedKeys && !this.acceptedKeys.has(key)) {
      throw Object.assign(new Error("HTTP 401"), { status: 401 });
    }
    const account = (k: string) => this.accounts.get(k) ?? k;
    const same = TEST_KEYS.filter((k) => account(k) === account(key)).map(keyFingerprint);
    return hashes.filter((h) => same.includes(h));
  }

  /** A client for one key, as `new Engram({ apiKey })` makes. */
  client(key = "key-1"): Engram {
    const admit = (op: Op) => {
      this.requests.push({ op, key });
      if (this.acceptedKeys && !this.acceptedKeys.has(key)) throw new AuthenticationError();
    };
    return {
      createConversation: async () => {
        admit("create");
        if (this.createError) throw this.createError;
        this.creates++;
        return { conversationId: `conv_${++this.seq}` };
      },
      store: async (p: StoreParams) => {
        this.sends.push(p);
        admit("store");
        const delay = this.delayWhen?.(p) ?? 0;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        const err = this.failWhen?.(p) ?? this.sendError;
        if (err) throw err;
        const list = this.stored.get(p.conversationId) ?? [];
        list.push(...p.messages.map((m) => m.content));
        this.stored.set(p.conversationId, list);
        return { stored: p.messages.length };
      },
      deleteConversation: async (id: string) => {
        admit("delete");
        if (this.deleteError) throw this.deleteError;
        this.deleted.push(id);
        this.stored.delete(id);
      },
    } as unknown as Engram;
  }

  /** Messages the server holds for a session in the account of the key
   *  `keyFp`, via daemon.db's mapping. */
  copyOf(db: DaemonDb, sessionId: string, keyFp = FIXED_KEY_FP): string[] | undefined {
    const conv = db.getConversationId(sessionId, keyFp);
    return conv ? this.stored.get(conv) : undefined;
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

/** Move the clock, run one flush, and return how many sends were made. */
async function flushAfter(ms: number): Promise<number> {
  later(ms);
  await syncer.flush();
  return server.sends.length;
}

const failureTypes = () => vi.mocked(recordFailure).mock.calls.map((c) => c[1]);

/** What the daemon logged as errors, one line per call. */
const errorLog = () => vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-send-outcome-"));
  db = new DaemonDb(join(dir, "daemon.db"));
  server = new FakeServer();
  syncer = new Syncer(db, server.client());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(recordSuccess).mockClear();
  vi.mocked(recordFailure).mockClear();
  vi.mocked(recordNextRetry).mockClear();
  vi.mocked(recordSignedIn).mockClear();
  vi.mocked(recordSignedOut).mockClear();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("a failed send is not a successful sync (engram#580)", () => {
  it("a full memory backs off instead of retrying every 2 s, and capture resumes within a minute of space being freed", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("before"));
    server.sendError = new Error(STORAGE_FULL);

    expect(await flushAfter(0)).toBe(1);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(failureTypes()).toEqual(["storage_full"]);

    // The backoff holds: the 2 s flush loop doesn't send again.
    expect(await flushAfter(2_000)).toBe(1);
    expect(await flushAfter(30_000)).toBe(1);
    expect(recordSuccess).not.toHaveBeenCalled();

    // Captures keep queueing meanwhile; nothing is dropped.
    await syncer.onMessages("s1", meta("s1"), msgs("during"));
    expect(db.getPendingCount()).toBe(2);

    // The user frees space; the next flush after the minute sends all of it.
    server.sendError = null;
    expect(await flushAfter(30_000)).toBe(2);
    expect(server.copyOf(db, "s1")).toEqual(["before", "during"]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // The success reset the schedule: filling up again waits one minute.
    await syncer.onMessages("s1", meta("s1"), msgs("after"));
    server.sendError = new Error(STORAGE_FULL);
    expect(await flushAfter(2_000)).toBe(3);
    expect(await flushAfter(59_000)).toBe(3);
    expect(await flushAfter(2_000)).toBe(4);
  });

  it("a memory that stays full is retried after 1, then 2, then every 5 minutes", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m"));
    server.sendError = new Error(STORAGE_FULL);

    expect(await flushAfter(0)).toBe(1);
    expect(await flushAfter(59_000)).toBe(1);
    expect(await flushAfter(2_000)).toBe(2); // 1 min
    expect(await flushAfter(118_000)).toBe(2);
    expect(await flushAfter(3_000)).toBe(3); // 2 min
    expect(await flushAfter(298_000)).toBe(3);
    expect(await flushAfter(3_000)).toBe(4); // 5 min
    expect(await flushAfter(298_000)).toBe(4);
    expect(await flushAfter(3_000)).toBe(5); // still 5 min, never the 1 h cap
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(new Set(failureTypes())).toEqual(new Set(["storage_full"]));
  });

  it("a plan's monthly limit keeps the longer schedule: 5, 15, then 60 minutes", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m"));
    server.sendError = new Error(MONTHLY_LIMIT);

    expect(await flushAfter(0)).toBe(1);
    expect(await flushAfter(5 * 60_000 - 2_000)).toBe(1);
    expect(await flushAfter(3_000)).toBe(2); // 5 min
    expect(await flushAfter(15 * 60_000 - 2_000)).toBe(2);
    expect(await flushAfter(3_000)).toBe(3); // 15 min
    expect(await flushAfter(60 * 60_000 - 2_000)).toBe(3);
    expect(await flushAfter(3_000)).toBe(4); // 1 h
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(new Set(failureTypes())).toEqual(new Set(["billing"]));
  });

  it("sends that hit the limit together back off once, and the rest aren't sent", async () => {
    const ids = Array.from({ length: 7 }, (_, i) => `s${i}`); // > one group of 5
    for (const id of ids) await syncer.onMessages(id, meta(id), msgs(`m-${id}`));
    server.sendError = new Error(STORAGE_FULL);

    // The first group of five is in flight together and all five fail; the
    // other two sessions are never sent.
    expect(await flushAfter(0)).toBe(5);

    // One minute, not five: five parallel failures are one escalation.
    server.sendError = null;
    expect(await flushAfter(61_000)).toBe(12);
    for (const id of ids) expect(server.copyOf(db, id)).toEqual([`m-${id}`]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a full memory", STORAGE_FULL],
    ["a rejected key", "401 Unauthorized"],
  ])("%s hit by one conversation stops another's remaining batches", async (_, error) => {
    // "big" needs two batches (25 per batch); "small" fails on its first.
    const big = Array.from({ length: 30 }, (_, i) => `big-${i}`);
    await syncer.onMessages("s-big", meta("s-big"), msgs(...big));
    await syncer.onMessages("s-small", meta("s-small"), msgs("small"));
    const isSmall = (p: StoreParams) => p.messages.some((m) => m.content === "small");
    server.failWhen = (p) => (isSmall(p) ? new Error(error) : null);
    // big's first batch is still in flight when small's send fails.
    server.delayWhen = (p) => (isSmall(p) ? 0 : 20);

    await syncer.flush();
    const bigSends = server.sends.filter((p) => !isSmall(p));
    expect(bigSends).toHaveLength(1);
    expect(server.copyOf(db, "s-big")).toEqual(big.slice(0, 25));
    expect(db.getPendingCount()).toBe(5 + 1);
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it("one conversation's failed send keeps the flush from counting as a sync", async () => {
    await syncer.onMessages("s-a", meta("s-a"), msgs("a1"));
    await syncer.onMessages("s-b", meta("s-b"), msgs("b1"));
    server.failWhen = (p) =>
      p.messages.some((m) => m.content === "b1") ? new Error("fetch failed") : null;

    await syncer.flush();
    expect(server.copyOf(db, "s-a")).toEqual(["a1"]);
    expect(server.copyOf(db, "s-b")).toBeUndefined();
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(failureTypes()).toEqual(["network"]);

    // An ordinary failure holds only its own conversation, for a few
    // seconds the first time (engram#596).
    server.failWhen = null;
    await flushAfter(RETRY_BASE_MS);
    expect(server.copyOf(db, "s-b")).toEqual(["b1"]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("a rejected key pauses syncing, and status never reads healthy", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    server.sendError = new Error("401 Unauthorized");

    expect(await flushAfter(0)).toBe(2);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(new Set(failureTypes())).toEqual(new Set(["auth"]));

    // Nothing is sent or created for ten minutes; a session that starts
    // meanwhile waits in daemon.db.
    await syncer.onMessages("s3", meta("s3"), msgs("m3"));
    expect(await flushAfter(10 * 60_000 - 1_000)).toBe(2);
    expect(server.creates).toBe(2);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(db.getPendingCount()).toBe(3);
    expect(db.getPendingSessions(FIXED_KEY_FP).map((s) => s.sessionId)).toEqual(["s3"]);

    // Two sends rejected together were one pause: the key is tried again
    // after ten minutes, not thirty.
    expect(await flushAfter(2_000)).toBe(5);
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  it("a send that throws before reaching the server isn't a sync either", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    vi.spyOn(db, "dequeue").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await syncer.flush();
    expect(server.sends).toHaveLength(0);
    expect(recordSuccess).not.toHaveBeenCalled();

    await flushAfter(2_000);
    expect(server.copyOf(db, "s1")).toEqual(["m1"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });
});

/** The daemon's key source (worker-main.ts): the key `engram auth login`
 *  last saved to config.json, and a client for each key. */
function keySource(initial: string) {
  const keys = {
    current: { key: initial, server: DEFAULT_BASE_URL } as Account | undefined,
    configured: initial as string | undefined,
    readError: null as Error | null,
    reads: 0,
    connected: [] as string[],
    async read(): Promise<Account | undefined> {
      keys.reads++;
      if (keys.readError) throw keys.readError;
      return keys.configured === undefined ? undefined : { key: keys.configured, server: DEFAULT_BASE_URL };
    },
    connect(account: Account): Engram {
      keys.connected.push(account.key);
      return server.client(account.key);
    },
    ownedKeys(account: Account, hashes: string[]): Promise<string[]> {
      return server.ownedKeys(account.key, hashes);
    },
  };
  return keys;
}

describe("a rejected key pauses, and recovers without a restart (engram#587)", () => {
  let keys: ReturnType<typeof keySource>;
  const requests = () => server.requests.length;

  beforeEach(() => {
    keys = keySource("key-old");
    server.acceptedKeys = new Set(["key-new"]);
    syncer = new Syncer(db, server.client("key-old"), null, keys);
  });

  it("the SDK's rejected-key error pauses syncing instead of retrying every 2 s", async () => {
    // AuthenticationError's message is "Invalid or missing API key": no
    // "401", so it used to read as a network error and was retried forever.
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    expect(server.requests).toEqual([{ op: "create", key: "key-old" }]);
    expect(failureTypes()).toEqual(["auth"]);

    for (let i = 0; i < 30; i++) await flushAfter(2_000);
    expect(requests()).toBe(1);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(db.getPendingCount()).toBe(1);
  });

  it("retries the same key after 10 minutes, then 30, then every hour", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    const attempts = async (ms: number) => {
      await flushAfter(ms);
      return requests();
    };

    expect(await attempts(0)).toBe(1);
    expect(await attempts(10 * 60_000 - 2_000)).toBe(1);
    expect(await attempts(3_000)).toBe(2); // 10 min
    expect(await attempts(30 * 60_000 - 2_000)).toBe(2);
    expect(await attempts(3_000)).toBe(3); // 30 min
    expect(await attempts(60 * 60_000 - 2_000)).toBe(3);
    expect(await attempts(3_000)).toBe(4); // 1 h
    expect(await attempts(60 * 60_000 - 2_000)).toBe(4);
    expect(await attempts(3_000)).toBe(5); // still 1 h
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(new Set(failureTypes())).toEqual(new Set(["auth"]));

    // The same key is accepted again (a revocation undone): the next retry
    // sends everything.
    server.acceptedKeys = null;
    expect(await attempts(60 * 60_000)).toBe(5 + 2); // create + store
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // And the schedule starts over: a new rejection pauses ten minutes.
    server.acceptedKeys = new Set();
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    expect(await attempts(2_000)).toBe(8);
    expect(await attempts(10 * 60_000 - 1_000)).toBe(8);
    expect(await attempts(2_000)).toBe(9);
  });

  it("switches to a key saved by 'engram auth login' at the next flush, without a restart", async () => {
    server.accounts.set("key-new", "key-old"); // a re-issued key of the same account
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    expect(failureTypes()).toEqual(["auth"]);

    // Every flush reads the key, paused or not.
    await flushAfter(2_000);
    expect(keys.reads).toBe(2);
    expect(keys.connected).toEqual([]);

    // The user runs `engram auth login`. It saves the key and leaves the
    // daemon running.
    keys.configured = "key-new";
    await flushAfter(2_000);
    expect(keys.connected).toEqual(["key-new"]);
    expect(server.requests.slice(1)).toEqual([
      { op: "owned", key: "key-new" }, // the server says key-old is this account's
      { op: "create", key: "key-new" },
      { op: "store", key: "key-new" },
    ]);
    expect(server.copyOf(db, "s1", keyFingerprint("key-new"))).toEqual(["m1"]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // The key stays in use; it isn't connected again while it's configured.
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    await flushAfter(2_000);
    expect(keys.connected).toEqual(["key-new"]);
    expect(server.copyOf(db, "s1", keyFingerprint("key-new"))).toEqual(["m1", "m2"]);
  });

  it("a key for another account sends only what's captured under it; the old key's queue waits for its account", async () => {
    server.acceptedKeys = null; // both keys work
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    server.sendError = new EngramError("Network error: fetch failed"); // m2 isn't sent
    await flushAfter(2_000);
    server.sendError = null;
    const before = server.requests.length;

    // `engram auth login` with a key for another account.
    keys.configured = "key-new";
    await flushAfter(2_000);
    expect(keys.connected).toEqual(["key-new"]);
    // It asked whether key-old is its account's, heard no, and sent nothing.
    expect(server.requests.slice(before)).toEqual([{ op: "owned", key: "key-new" }]);
    expect(db.getPendingCount(keyFingerprint("key-old"))).toBe(1);

    // The session goes on in the other account, in a conversation of its own.
    await syncer.onMessages("s1", meta("s1"), msgs("m3"));
    await flushAfter(2_000);
    expect(server.copyOf(db, "s1", keyFingerprint("key-new"))).toEqual(["m3"]);
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1"]);
    expect(server.requests.filter((r) => r.op === "store" && r.key === "key-new")).toHaveLength(1);

    // Signing in to the first account again sends what waited for it.
    keys.configured = "key-old";
    await flushAfter(2_000);
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1", "m2"]);
    expect(server.copyOf(db, "s1", keyFingerprint("key-new"))).toEqual(["m3"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a removed or empty key signs out at once; a config.json it can't read changes nothing", async () => {
    server.acceptedKeys = null; // the key works
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1"]);

    // A config.json that can't be read isn't a logout: the key in use stays.
    keys.readError = new Error("EACCES: permission denied");
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    await flushAfter(2_000);
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1", "m2"]);
    expect(recordSignedOut).not.toHaveBeenCalled();

    // `engram auth logout`, then a config.json saved with an empty key:
    // nothing more is sent, and what's queued stays on this machine.
    keys.readError = null;
    keys.configured = undefined;
    const sent = server.requests.length;
    await flushAfter(2_000);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    await syncer.onMessages("s1", meta("s1"), msgs("m3"));
    await flushAfter(2_000);
    keys.configured = "";
    await flushAfter(2_000);
    expect(server.requests).toHaveLength(sent);
    expect(db.getPendingCount()).toBe(1);
    expect(keys.connected).toEqual([]);

    // Signing in again is picked up without a restart, and what was queued
    // meanwhile goes to that key's account.
    keys.configured = "key-old";
    await flushAfter(2_000);
    expect(keys.connected).toEqual(["key-old"]);
    expect(recordSignedIn).toHaveBeenCalledTimes(1);
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1", "m2", "m3"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a flush with nothing to send doesn't clear a rejected key's status", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    expect(failureTypes()).toEqual(["auth"]);

    // The user opts the session out before it ever synced: nothing is left
    // to send, and nothing reached the server to delete.
    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(db.getPendingCount()).toBe(0);
    expect(db.getPendingRemoteDeletes(keyFingerprint("key-old"))).toEqual([]);

    // The pause ends with nothing to try the key on. Nothing proved the key
    // works, so status keeps asking for a login.
    await flushAfter(10 * 60_000);
    expect(requests()).toBe(1);
    expect(recordSuccess).not.toHaveBeenCalled();
  });

  /** s1 synced and s2 hit a full memory; then the old key was revoked, and
   *  an opt-out of s1 found out. */
  async function fullThenRevoked(): Promise<void> {
    server.acceptedKeys = new Set(["key-old", "key-new"]);
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    server.sendError = new Error(STORAGE_FULL);
    await flushAfter(2_000);
    expect(failureTypes()).toEqual(["storage_full"]);

    server.acceptedKeys = new Set(["key-new"]);
    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(failureTypes()).toEqual(["storage_full", "auth"]);
    server.sendError = null;
  }

  it("a new key also lifts a plan-limit backoff, so a different account syncs at once", async () => {
    await fullThenRevoked();

    // The user logs in to another account, one with room. What is captured
    // from then on is sent at once, inside the old key's minute of backoff.
    keys.configured = "key-new";
    await flushAfter(2_000);
    await syncer.onMessages("s3", meta("s3"), msgs("m3"));
    await flushAfter(2_000);
    expect(server.copyOf(db, "s3", keyFingerprint("key-new"))).toEqual(["m3"]);

    // The full account's queue and its opt-out's delete wait for that
    // account's key: neither goes out with the other account's.
    expect(server.copyOf(db, "s2", keyFingerprint("key-new"))).toBeUndefined();
    expect(db.getPendingCount(keyFingerprint("key-old"))).toBe(1);
    expect(server.deleted).toEqual([]);
    expect(server.requests.filter((r) => r.op === "delete" && r.key === "key-new")).toEqual([]);
    expect(db.getPendingRemoteDeletes(keyFingerprint("key-old"))).toEqual([
      { conversation_id: "conv_1", session_id: "s1" },
    ]);
  });

  it("a re-issued key of the same account lifts the backoff too, and sends what the old key queued", async () => {
    server.accounts.set("key-new", "key-old");
    await fullThenRevoked();

    keys.configured = "key-new";
    await flushAfter(2_000);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(server.copyOf(db, "s2", keyFingerprint("key-new"))).toEqual(["m2"]);
    expect(db.getPendingCount()).toBe(0);
    expect(db.getPendingRemoteDeletes(keyFingerprint("key-new"))).toEqual([]);
  });

  it("after the pause, a send that goes through clears the status", async () => {
    // s1 is already synced, so the retry is a send and nothing else.
    server.acceptedKeys = new Set(["key-old"]);
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    vi.mocked(recordSuccess).mockClear();

    server.acceptedKeys = new Set(); // revoked
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    await flushAfter(2_000);
    expect(failureTypes()).toEqual(["auth"]);

    server.acceptedKeys = new Set(["key-old"]); // the revocation is undone
    await flushAfter(10 * 60_000 + 1_000);
    expect(server.requests.slice(-1)).toEqual([{ op: "store", key: "key-old" }]);
    expect(server.copyOf(db, "s1", keyFingerprint("key-old"))).toEqual(["m1", "m2"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("a create that goes through starts the schedule over, even when its send fails", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush(); // the create is rejected: ten minutes

    // Accepted after the pause: the create goes through, the send doesn't.
    server.acceptedKeys = new Set(["key-old"]);
    server.sendError = new EngramError("Network error: fetch failed");
    await flushAfter(10 * 60_000 + 1_000);
    expect(server.creates).toBe(1);

    // Rejected again, once the send's own wait is over (engram#596): ten
    // minutes, as after any key that worked, not thirty.
    server.sendError = null;
    server.acceptedKeys = new Set();
    await flushAfter(RETRY_BASE_MS);
    const n = requests();
    await flushAfter(10 * 60_000 - 1_000);
    expect(requests()).toBe(n);
    await flushAfter(2_000);
    expect(requests()).toBe(n + 1);
  });

  it("a new key that's rejected too starts the schedule over, and isn't tried again meanwhile", async () => {
    server.acceptedKeys = new Set(); // no key works
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush(); // ten minutes
    await flushAfter(10 * 60_000 + 1_000); // thirty
    expect(requests()).toBe(2);

    keys.configured = "key-typo"; // a login with a mistyped key
    await flushAfter(10_000);
    expect(keys.connected).toEqual(["key-typo"]);
    // Its first request, asking whether key-old is its account's, is refused.
    expect(server.requests.slice(-1)).toEqual([{ op: "owned", key: "key-typo" }]);
    const n = requests();

    // A fresh key gets the first pause, ten minutes. Reading the same key
    // again during it changes nothing.
    for (let t = 10_000; t < 10 * 60_000; t += 10_000) await flushAfter(10_000);
    expect(requests()).toBe(n);
    expect(keys.connected).toEqual(["key-typo"]);
    await flushAfter(20_000);
    expect(requests()).toBe(n + 1);
  });
});

describe("refusals are read from the error, not from digits in its text (engram#587)", () => {
  it.each([
    ["indexing_quota_exceeded", 403],
    ["message_limit_exceeded", 401],
  ])("a %s refusal with a usage count of %i is a plan limit, not a rejected key", async (error, used) => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = refusal({ error, message: "Limit reached.", limit: 1000, used, tier: "free" });

    expect(await flushAfter(0)).toBe(1);
    expect(failureTypes()).toEqual(["billing"]);
    // Retried on the plan-limit schedule. It used to stop syncing until the
    // daemon restarted.
    expect(await flushAfter(5 * 60_000 - 2_000)).toBe(1);
    expect(await flushAfter(3_000)).toBe(2);
  });

  it("a key without the write scope pauses like a rejected key", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = refusal({
      error: "insufficient_scope",
      required: "write",
      message: "This API key lacks the 'write' scope.",
    });

    expect(await flushAfter(0)).toBe(1);
    expect(failureTypes()).toEqual(["auth"]);
    expect(await flushAfter(10 * 60_000 - 1_000)).toBe(1);
  });

  it.each([
    ["a rate limit", () => httpError(429), "rate_limit"],
    ["a maintenance pause", writesPaused, "paused"],
  ])("%s is retried with the same batch, not split into more requests", async (_, error, type) => {
    const many = Array.from({ length: 30 }, (_, i) => `m-${i}`);
    await syncer.onMessages("s1", meta("s1"), msgs(...many));
    server.failWhen = () => (server.sends.length === 1 ? error() : null);

    await syncer.flush();
    expect(failureTypes()).toEqual([type]);
    await flushAfter(RETRY_BASE_MS);
    expect(server.sends.map((p) => p.messages.length)).toEqual([25, 25, 5]);
    expect(server.copyOf(db, "s1")).toEqual(many);
  });
});

describe("an opt-out's server delete is dropped only when Engram says it's gone (engram#587)", () => {
  /** s1 synced, then the user opted out of it. */
  async function optOutAfterSync(deleteError: Error | null): Promise<void> {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    expect(server.copyOf(db, "s1")).toEqual(["m1"]);
    server.deleteError = deleteError;
    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
  }

  it.each([
    ["a DNS failure", new EngramError("Network error: getaddrinfo ENOTFOUND mcp.getengram.app")],
    [
      "a 404 page from another host",
      new EngramError("Unexpected response format: <html><title>404 Not Found</title></html>"),
    ],
    ["a JSON-RPC not_found from another host", new EngramError("Not Found", "not_found", 404)],
    ["the SDK's NotFoundError", new NotFoundError()],
  ])("keeps the delete after %s, and retries until it lands", async (_, err) => {
    await optOutAfterSync(err);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);
    const deletes = () => server.requests.filter((r) => r.op === "delete").length;
    expect(deletes()).toBe(1);

    // Tried again once its wait is over (engram#596), not at every flush,
    // and kept again. The first wait is at least half of RETRY_BASE_MS.
    await flushAfter(2_000);
    expect(deletes()).toBe(1);
    await flushAfter(RETRY_BASE_MS - 2_000);
    expect(deletes()).toBe(2);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    // The second wait is up to twice the first.
    server.deleteError = null;
    await flushAfter(2 * RETRY_BASE_MS);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });

  it("drops the delete when Engram says the conversation is already gone", async () => {
    await optOutAfterSync(refusal({ error: "Conversation not found" }));
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });

  it("a key without the delete scope keeps the delete, and doesn't pause syncing", async () => {
    await optOutAfterSync(
      refusal({ error: "insufficient_scope", required: "delete", message: "No 'delete' scope." }),
    );
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    await flushAfter(2_000);
    expect(server.copyOf(db, "s2")).toEqual(["m2"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);
  });

  it("a rejected key pauses the deletes with everything else", async () => {
    await optOutAfterSync(new AuthenticationError());
    expect(failureTypes()).toEqual(["auth"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    const before = server.requests.length;
    await flushAfter(2_000);
    expect(server.requests).toHaveLength(before);

    // Accepted again after the pause: the delete lands, then s2 syncs.
    server.deleteError = null;
    await flushAfter(10 * 60_000);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(server.copyOf(db, "s2")).toEqual(["m2"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });
  it("an opt-out during the pause waits for it: the delete isn't sent with the rejected key", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    server.acceptedKeys = new Set(); // revoked
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    await flushAfter(2_000);
    expect(failureTypes()).toEqual(["auth"]);
    const before = server.requests.length;

    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(server.requests).toHaveLength(before);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    // Accepted after the pause: the delete is the first thing sent.
    server.acceptedKeys = null;
    await flushAfter(10 * 60_000 + 1_000);
    expect(server.requests.slice(before)).toEqual([{ op: "delete", key: "key-1" }]);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });

  it("a delete rejected in a flush ends that flush: nothing else is sent with the key", async () => {
    await optOutAfterSync(new EngramError("Network error: fetch failed"));
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));

    // The key is revoked; the flush's first request, the delete (its wait
    // over), finds out.
    server.deleteError = null;
    server.acceptedKeys = new Set();
    const before = server.requests.length;
    await flushAfter(RETRY_BASE_MS);
    expect(server.requests.slice(before)).toEqual([{ op: "delete", key: "key-1" }]);
    expect(failureTypes().at(-1)).toBe("auth");
    expect(db.getPendingSessions(FIXED_KEY_FP).map((s) => s.sessionId)).toEqual(["s2"]);
  });

  it.each([
    ["lands", null],
    ["finds the conversation already gone", refusal({ error: "Conversation not found" })],
  ])("after the pause, a delete that %s proves the key works", async (_, answer) => {
    await optOutAfterSync(new AuthenticationError());
    expect(failureTypes()).toEqual(["auth"]);
    vi.mocked(recordSuccess).mockClear();

    // Nothing else is waiting: the delete is the only proof there can be.
    server.deleteError = answer;
    await flushAfter(10 * 60_000 + 1_000);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("what fails for a while is tried again after a wait that doubles (engram#596)", () => {
  // Every wait at the top of its range, so the schedule reads exactly:
  // 5 s, then 10, then 20… (backoff.test.ts covers the range itself).
  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(1 - 1e-9);
  });

  it("an error on the server's side holds only its own conversation: 5 s, then 10, then 20", async () => {
    await syncer.onMessages("s-a", meta("s-a"), msgs("a1"));
    await syncer.onMessages("s-b", meta("s-b"), msgs("b1"));
    const isA = (p: StoreParams) => p.messages.some((m) => m.content.startsWith("a"));
    const triesOfA = () => server.sends.filter(isA).length;
    server.failWhen = (p) => (isA(p) ? httpError(503) : null);

    await syncer.flush();
    expect(triesOfA()).toBe(1);
    expect(server.copyOf(db, "s-b")).toEqual(["b1"]);
    expect(failureTypes()).toEqual(["server"]);
    expect(errorLog()).toContain("send failed (will retry in 5s): HTTP 503");

    // The other conversation isn't held: what it captures meanwhile goes
    // out at the next flush. A flush isn't a sync while one waits.
    await syncer.onMessages("s-b", meta("s-b"), msgs("b2"));
    await flushAfter(2_000);
    expect(server.copyOf(db, "s-b")).toEqual(["b1", "b2"]);
    expect(recordSuccess).not.toHaveBeenCalled();

    // It used to be tried again at every flush, every 2 s.
    await flushAfter(2_000); // 4 s
    expect(triesOfA()).toBe(1);
    await flushAfter(1_000); // 5 s
    expect(triesOfA()).toBe(2);
    await flushAfter(9_000); // 14 s
    expect(triesOfA()).toBe(2);
    await flushAfter(1_000); // 15 s
    expect(triesOfA()).toBe(3);
    expect(errorLog()).toContain("send failed (will retry in 20s): HTTP 503");

    server.failWhen = null;
    await flushAfter(19_000); // 34 s
    expect(triesOfA()).toBe(3);
    await flushAfter(1_000); // 35 s
    expect(server.copyOf(db, "s-a")).toEqual(["a1"]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // Its success started its schedule over: failing again waits 5 s.
    await syncer.onMessages("s-a", meta("s-a"), msgs("a2"));
    server.failWhen = (p) => (isA(p) ? httpError(503) : null);
    await flushAfter(2_000);
    expect(triesOfA()).toBe(5);
    await flushAfter(4_000);
    expect(triesOfA()).toBe(5);
    await flushAfter(1_000);
    expect(triesOfA()).toBe(6);
  });

  it.each([
    ["a rate limit", () => httpError(429), "rate_limit"],
    ["a maintenance pause", writesPaused, "paused"],
  ])("%s holds every send from the account: 5 s, then 10, then 20", async (_, error, type) => {
    const ids = Array.from({ length: 7 }, (_, i) => `s${i}`); // > one group of 5
    for (const id of ids) await syncer.onMessages(id, meta(id), msgs(`m-${id}`));
    server.sendError = error();

    // The first group of five is refused together: one pause, and the
    // other two aren't sent.
    expect(await flushAfter(0)).toBe(5);
    expect(new Set(failureTypes())).toEqual(new Set([type]));
    expect(errorLog()).toContain("sending nothing for 5s");

    expect(await flushAfter(4_000)).toBe(5);
    expect(await flushAfter(1_000)).toBe(10); // 5 s: refused again, together
    expect(await flushAfter(9_000)).toBe(10);
    expect(await flushAfter(1_000)).toBe(15); // 15 s
    expect(errorLog()).toContain("sending nothing for 20s");
    expect(await flushAfter(19_000)).toBe(15);

    // Taken again: all seven go out.
    server.sendError = null;
    expect(await flushAfter(1_000)).toBe(22); // 35 s
    for (const id of ids) expect(server.copyOf(db, id)).toEqual([`m-${id}`]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // A send that went through started the schedule over.
    await syncer.onMessages("s0", meta("s0"), msgs("again"));
    server.sendError = error();
    expect(await flushAfter(2_000)).toBe(23);
    expect(await flushAfter(4_000)).toBe(23);
    expect(await flushAfter(1_000)).toBe(24);
  });

  it.each([
    ["a maintenance pause keeps its schedule: it holds only sends", writesPaused, 10_000],
    ["a rate limit starts over: the create got through it", () => httpError(429), 5_000],
  ])("after a create goes through, %s", async (_, error, wait) => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = error();
    expect(await flushAfter(0)).toBe(1); // 5 s

    // A new session's create goes through; both sends are refused again.
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    expect(await flushAfter(5_000)).toBe(3);
    expect(server.creates).toBe(2);
    expect(await flushAfter(wait - 1_000)).toBe(3);
    expect(await flushAfter(1_000)).toBe(5);
  });

  it("a rate limit on a create holds the account, and the create isn't put off for 30 s", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    server.createError = httpError(429);
    await syncer.flush();
    expect(server.requests.map((r) => r.op)).toEqual(["create", "create"]);
    expect(failureTypes()).toEqual(["rate_limit"]);

    server.createError = null;
    await flushAfter(4_000);
    expect(server.requests).toHaveLength(2);
    await flushAfter(1_000);
    expect(server.copyOf(db, "s1")).toEqual(["m1"]);
    expect(server.copyOf(db, "s2")).toEqual(["m2"]);
  });

  it("an error on the server's side on a create keeps the create's own schedule", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.createError = httpError(500);
    const t0 = Date.now();
    await syncer.flush();
    expect(vi.mocked(recordFailure).mock.calls).toEqual([
      ["HTTP 500", "server", 1, { retryAt: t0 + 30_000 }],
    ]);
    expect(errorLog()).toContain("create error (will retry in 30s): HTTP 500");

    server.createError = null;
    await flushAfter(29_000);
    expect(server.creates).toBe(0);
    await flushAfter(1_000);
    expect(server.copyOf(db, "s1")).toEqual(["m1"]);
  });

  it("a rate limit on an opt-out's delete holds everything else too, then the delete lands", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    server.deleteError = httpError(429);
    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(failureTypes()).toEqual(["rate_limit"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    const before = server.requests.length;
    await flushAfter(4_000);
    expect(server.requests).toHaveLength(before);

    server.deleteError = null;
    await flushAfter(1_000);
    expect(server.requests.slice(before).map((r) => r.op)).toEqual(["delete", "create", "store"]);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(server.copyOf(db, "s2")).toEqual(["m2"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });

  it("an opt-out during a rate limit waits for it: the delete isn't sent into the limit", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    server.sendError = httpError(429);
    await flushAfter(2_000);
    expect(failureTypes()).toEqual(["rate_limit"]);
    const before = server.requests.length;

    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(server.requests).toHaveLength(before);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toHaveLength(1);

    // The limit's wait over, the delete is the first thing sent.
    server.sendError = null;
    await flushAfter(5_000);
    expect(server.requests.slice(before)).toEqual([{ op: "delete", key: "key-1" }]);
    expect(server.deleted).toEqual(["conv_1"]);
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
  });

  it("status says when the next try is, and a flush during the wait changes nothing", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = httpError(503);
    const t0 = Date.now();
    await syncer.flush();
    expect(vi.mocked(recordFailure).mock.calls).toEqual([
      ["HTTP 503", "server", 1, { retryAt: t0 + 5_000 }],
    ]);
    expect(vi.mocked(recordNextRetry).mock.lastCall).toEqual([t0 + 5_000]);

    await flushAfter(2_000);
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordNextRetry).mock.lastCall).toEqual([t0 + 5_000]);

    // Rate limited at the retry: the account's pause is what's next.
    server.sendError = httpError(429);
    await flushAfter(3_000); // 5 s
    expect(vi.mocked(recordFailure).mock.lastCall).toEqual([
      "HTTP 429",
      "rate_limit",
      1,
      { retryAt: t0 + 10_000 },
    ]);
    expect(vi.mocked(recordNextRetry).mock.lastCall).toEqual([t0 + 10_000]);

    server.sendError = null;
    await flushAfter(5_000); // 10 s
    expect(server.copyOf(db, "s1")).toEqual(["m1"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("a new key isn't held by the old key's rate limit", async () => {
    const keys = keySource("key-old");
    syncer = new Syncer(db, server.client("key-old"), null, keys);
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = httpError(429);
    await syncer.flush();
    expect(failureTypes()).toEqual(["rate_limit"]);
    server.sendError = null;

    // `engram auth login` with another account's key, inside the old key's
    // pause: what's captured under it goes out at once.
    keys.configured = "key-new";
    await flushAfter(1_000);
    expect(keys.connected).toEqual(["key-new"]);
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    await flushAfter(1_000);
    expect(server.copyOf(db, "s2", keyFingerprint("key-new"))).toEqual(["m2"]);
    // The old account's message waits for its key.
    expect(db.getPendingCount(keyFingerprint("key-old"))).toBe(1);
  });
});
