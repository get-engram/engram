import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import type { Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine.
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
import { Syncer, keyFingerprint, type CaptureControl } from "../daemon/syncer.js";
import { Watcher } from "../daemon/watcher.js";
import { Parser } from "../daemon/parser.js";
import { QueueWriteError } from "../daemon/queue-error.js";
import {
  recordCaptureResumed,
  recordCaptureStall,
  recordSignedIn,
  recordSignedOut,
} from "../daemon/status.js";
import type { HostAdapter, OnMessages, ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#594: `engram auth logout` didn't stop the daemon, and logging in to
// another account kept sending to the first one. Captures queued while one
// account was signed in went out with the next account's key.
// engram#595: with no key, the worker exited, and launchd restarted it in a
// loop that logged the same line every time.
//
// The server here keeps each conversation in the account of the key that
// created it, and records a violation for any request that crosses
// accounts: a store or delete with another account's key, or a message sent
// with the key of an account other than the one it was captured under.
// Every message's text starts with that account ("A:…"), so the server can
// tell. afterEach fails any test that recorded a violation.

/** Each test key's account. key-a1 and key-a2 are two keys of account A (a
 *  rotated key); key-b is account B's. */
const ACCOUNT: Record<string, string> = { "key-a1": "A", "key-a2": "A", "key-b": "B" };
const fp = keyFingerprint;

type Op = "create" | "store" | "delete" | "owned";
type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  conversations = new Map<string, { account: string; messages: string[] }>();
  /** Every request, with the key it carried. */
  requests: Array<{ op: Op; key: string }> = [];
  violations: string[] = [];
  /** Thrown by every owned-keys request while set. */
  ownedError: Error | null = null;
  /** While set, every store waits for it before it lands. */
  storeGate: Promise<void> | null = null;
  deleted: string[] = [];
  private seq = 0;

  /** A conversation an earlier daemon created. */
  seed(id: string, account: string, messages: string[] = []): void {
    this.conversations.set(id, { account, messages: [...messages] });
  }

  /** POST /api/account/owned-keys: which of `hashes` are fingerprints of
   *  keys of `key`'s account. */
  async ownedKeys(key: string, hashes: string[]): Promise<string[]> {
    this.requests.push({ op: "owned", key });
    if (this.ownedError) throw this.ownedError;
    const mine = Object.keys(ACCOUNT)
      .filter((k) => ACCOUNT[k] === ACCOUNT[key])
      .map(fp);
    return hashes.filter((h) => mine.includes(h));
  }

  /** A client for one key, as `new Engram({ apiKey })` makes. */
  client(key: string): Engram {
    const account = ACCOUNT[key];
    if (!account) throw new Error(`no account for ${key}`);
    return {
      createConversation: async () => {
        this.requests.push({ op: "create", key });
        const conversationId = `conv_${++this.seq}`;
        this.conversations.set(conversationId, { account, messages: [] });
        return { conversationId };
      },
      store: async (p: StoreParams) => {
        this.requests.push({ op: "store", key });
        if (this.storeGate) await this.storeGate;
        const conv = this.conversations.get(p.conversationId);
        const crossed: string[] = [];
        if (conv?.account !== account) {
          crossed.push(
            `store into ${p.conversationId} (account ${conv?.account ?? "none"}) with ${key}`,
          );
        }
        for (const m of p.messages) {
          if (!m.content.startsWith(`${account}:`)) crossed.push(`"${m.content}" sent with ${key}`);
        }
        if (!conv || crossed.length > 0) {
          this.violations.push(...crossed);
          throw new Error("conversation not found");
        }
        conv.messages.push(...p.messages.map((m) => m.content));
        return { stored: p.messages.length };
      },
      deleteConversation: async (id: string) => {
        this.requests.push({ op: "delete", key });
        const conv = this.conversations.get(id);
        if (conv && conv.account !== account) {
          this.violations.push(`delete of ${id} (account ${conv.account}) with ${key}`);
          throw new Error("conversation not found");
        }
        this.deleted.push(id);
        this.conversations.delete(id);
      },
    } as unknown as Engram;
  }

  /** What the server holds for a session in `key`'s account, found through
   *  daemon.db's mapping. */
  copyOf(db: DaemonDb, sessionId: string, key: string): string[] | undefined {
    const conv = db.getConversationId(sessionId, fp(key));
    return conv ? this.conversations.get(conv)?.messages : undefined;
  }

  count(op: Op): number {
    return this.requests.filter((r) => r.op === op).length;
  }
}

/**
 * Stands in for worker-main's transcript watchers. `unread` is what was
 * written to transcripts but not read yet: a draining stop reads it, while
 * the key capture ran under is still the one queued under, as
 * Watcher.stop({ drain: true }) does.
 */
class FakeCapture implements CaptureControl {
  events: string[] = [];
  unread: Array<{ sessionId: string; contents: string[] }> = [];
  constructor(private readonly target: () => Syncer) {}
  start(): void {
    this.events.push("start");
  }
  stop(drain: boolean): void {
    this.events.push(drain ? "stop+drain" : "stop");
    if (!drain) return;
    for (const u of this.unread.splice(0)) {
      void this.target().onMessages(u.sessionId, meta(u.sessionId), msgs(...u.contents));
    }
  }
}

/** The key the daemon finds configured, as worker-main reads it. */
function keySource(initial?: string) {
  const keys = {
    current: initial,
    configured: initial,
    readError: null as Error | null,
    /** Thrown by connect() while set: a key whose client can't be made yet. */
    connectError: null as Error | null,
    reads: 0,
    connected: [] as string[],
    disconnects: 0,
    async read(): Promise<string | undefined> {
      keys.reads++;
      if (keys.readError) throw keys.readError;
      return keys.configured;
    },
    connect(key: string): Engram {
      if (keys.connectError) throw keys.connectError;
      keys.connected.push(key);
      return server.client(key);
    },
    disconnect(): void {
      keys.disconnects++;
    },
    ownedKeys(key: string, hashes: string[]): Promise<string[]> {
      return server.ownedKeys(key, hashes);
    },
  };
  return keys;
}

let dir: string;
let dbPath: string;
let db: DaemonDb;
let server: FakeServer;
let syncer: Syncer;
const syncers: Syncer[] = [];
const opened: Array<{ close(): unknown }> = [];

function track<T extends { close(): unknown }>(handle: T): T {
  opened.push(handle);
  return handle;
}

/** A Syncer over `db` with `keys`, running `capture` while a key is configured. */
function newSyncer(keys: ReturnType<typeof keySource>, capture?: CaptureControl): Syncer {
  const s = new Syncer(db, null, null, keys);
  if (capture) s.setCaptureControl(capture);
  syncers.push(s);
  return s;
}

const meta = (sessionId: string): SessionMeta => ({
  sessionId,
  projectDir: "myproj",
  cwd: "/work/myproj",
  host: "claude-code",
});

const msgs = (...contents: string[]): ParsedMessage[] =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
const logged = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
const errors = () => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
const linesWith = (text: string) => logged().filter((l) => l.includes(text));
const errorsWith = (text: string) => errors().filter((l) => l.includes(text));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-594-"));
  dbPath = join(dir, "daemon.db");
  db = track(new DaemonDb(dbPath));
  server = new FakeServer();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const f of [recordSignedIn, recordSignedOut, recordCaptureResumed, recordCaptureStall]) {
    vi.mocked(f).mockClear();
  }
});

afterEach(() => {
  for (const s of syncers.splice(0)) s.stop();
  for (const h of opened.splice(0)) {
    try {
      h.close();
    } catch {
      // already closed
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  expect(server.violations).toEqual([]);
});

describe("capture and sending follow the configured key (engram#594)", () => {
  it("logout stops capture and sending at once; what was written stays queued on this machine", async () => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    expect(capture.events).toEqual(["start"]);
    expect(recordSignedIn).toHaveBeenCalledTimes(1);

    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1"]);

    // A message queued and not sent yet, and a line written and not read yet.
    await syncer.onMessages("s1", meta("s1"), msgs("A:m2"));
    capture.unread.push({ sessionId: "s1", contents: ["A:m3"] });
    const sent = server.requests.length;

    // `engram auth logout`, with the daemon running.
    keys.configured = undefined;
    await syncer.checkKey();
    expect(capture.events).toEqual(["start", "stop+drain"]);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    expect(keys.disconnects).toBe(1);
    expect(db.getPendingCount(fp("key-a1"))).toBe(2);
    expect(linesWith("[engram] signed out")).toEqual([
      "[engram] signed out — capture paused and nothing is sent; 2 queued message(s) stay on " +
        "this machine, to be sent only with their account's key. Capture resumes when " +
        "'engram auth login' saves a key.",
    ]);

    // Nothing is sent while signed out, and the line isn't logged again.
    for (let i = 0; i < 10; i++) {
      later(2_000);
      await syncer.flush();
    }
    expect(server.requests).toHaveLength(sent);
    expect(linesWith("[engram] signed out")).toHaveLength(1);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);

    // Signing in again resumes capture, and what waited is sent.
    keys.configured = "key-a1";
    await syncer.flush();
    expect(capture.events).toEqual(["start", "stop+drain", "start"]);
    expect(linesWith("[engram] signed in — capture and sync resumed")).toHaveLength(1);
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1", "A:m2", "A:m3"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a logout during a flush lets the request in flight land, and starts no other", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m0"));
    await syncer.flush();
    const contents = Array.from({ length: 30 }, (_, i) => `A:m${i + 1}`);
    await syncer.onMessages("s1", meta("s1"), msgs(...contents));

    let land = () => {};
    server.storeGate = new Promise<void>((resolve) => {
      land = resolve;
    });
    const flushing = syncer.flush();
    for (let i = 0; i < 100 && server.count("store") < 2; i++) await Promise.resolve();
    expect(server.count("store")).toBe(2); // the first batch of 25 is in flight

    keys.configured = undefined;
    await syncer.checkKey();
    land();
    await flushing;
    server.storeGate = null;
    expect(server.count("store")).toBe(2);
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m0", ...contents.slice(0, 25)]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(5);

    // The rest go out once the account's key is back, none twice.
    keys.configured = "key-a1";
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m0", ...contents]);
  });

  it("a logout is noticed within one key poll even while a send is stuck, not when the flush ends", async () => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m0"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs(...Array.from({ length: 30 }, (_, i) => `A:m${i + 1}`)));

    let land = () => {};
    server.storeGate = new Promise<void>((resolve) => {
      land = resolve;
    });
    // The flush timer starts a flush, and its first batch hangs on a slow
    // server. A flush in progress doesn't read the key again.
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 100 && server.count("store") < 2; i++) await Promise.resolve();
    expect(server.count("store")).toBe(2);

    keys.configured = undefined;
    await vi.advanceTimersByTimeAsync(2_000);
    for (let i = 0; i < 100 && capture.events.length < 2; i++) await Promise.resolve();
    expect(capture.events).toEqual(["start", "stop+drain"]);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    expect(linesWith("[engram] signed out")).toHaveLength(1);

    land();
    server.storeGate = null;
    await syncer.idle();
    expect(server.count("store")).toBe(2);
    expect(db.getPendingCount(fp("key-a1"))).toBe(5);
  });

  it("a login to another account drains capture under the old key, then captures under the new one", async () => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    capture.unread.push({ sessionId: "s1", contents: ["A:m2"] });
    const before = server.requests.length;

    // `engram auth login` with account B's key, with the daemon running.
    keys.configured = "key-b";
    await syncer.flush();
    expect(capture.events).toEqual(["start", "stop+drain", "start"]);
    expect(linesWith("[engram] new API key found")).toHaveLength(1);
    // B was asked whether A's key is one of its own, said no, and nothing
    // was sent.
    expect(server.requests.slice(before)).toEqual([{ op: "owned", key: "key-b" }]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);
    expect(linesWith("[engram] 1 queued message(s) wait for another API key's account")).toHaveLength(1);

    // The session goes on in account B, in a conversation of its own.
    await syncer.onMessages("s1", meta("s1"), msgs("B:m3"));
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-b")).toEqual(["B:m3"]);
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1"]);

    // Back on account A, what waited for it goes to its conversation.
    keys.configured = "key-a1";
    await syncer.flush();
    expect(capture.events).toEqual(["start", "stop+drain", "start", "stop+drain", "start"]);
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1", "A:m2"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a session not synced yet when the account changed gets a conversation in each account, each with its own messages", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1")); // no conversation yet
    keys.configured = "key-b";
    await syncer.checkKey();
    await syncer.onMessages("s1", meta("s1"), msgs("B:m2"));
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-b")).toEqual(["B:m2"]);
    expect(db.getPendingSessions(fp("key-a1")).map((s) => s.sessionId)).toEqual(["s1"]);

    keys.configured = "key-a1";
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1"]);
    expect(server.copyOf(db, "s1", "key-b")).toEqual(["B:m2"]);
    expect(db.getPendingSessions(fp("key-a1"))).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a new key that can't be used yet stops capture and sending under the old one, and is tried again", async () => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m2"));
    const before = server.requests.length;

    keys.connectError = new Error("couldn't read the vault key");
    keys.configured = "key-b";
    for (let i = 0; i < 5; i++) {
      later(2_000);
      await syncer.flush();
    }
    expect(server.requests).toHaveLength(before);
    expect(capture.events).toEqual(["start", "stop+drain"]);
    expect(errorsWith("the new API key can't be used yet (will retry)")).toHaveLength(1);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);

    keys.connectError = null;
    later(2_000);
    await syncer.flush();
    expect(capture.events).toEqual(["start", "stop+drain", "start"]);
    expect(keys.connected).toEqual(["key-a1", "key-b"]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1); // still waiting for account A
  });

  it("stop() ends capture without reading ahead; the final flush still sends with the key in use", async () => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    capture.unread.push({ sessionId: "s1", contents: ["A:m2"] });
    syncer.stop();
    expect(capture.events).toEqual(["start", "stop"]);

    await syncer.flush(); // worker-main's last flush before it exits
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1"]);
    await syncer.checkKey();
    expect(capture.events).toEqual(["start", "stop"]);
  });

  it.each([
    ["removed", undefined],
    ["changed to another account's", "key-b"],
  ])("a key %s after stop(): the final flush sends nothing, and capture stays stopped", async (_, next) => {
    const keys = keySource("key-a1");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    syncer.stop();

    keys.configured = next;
    await syncer.flush();
    expect(server.requests).toEqual([]);
    expect(capture.events).toEqual(["start", "stop"]);
    expect(keys.connected).toEqual(["key-a1"]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);
  });
});

describe("with no key, the worker idles until one is saved (engram#595)", () => {
  it("re-checks every 2 s without logging again, and starts capturing as soon as a key is saved", async () => {
    // A message queued while no key was in use.
    db.enqueuePendingSession("s0", meta("s0"), msgs("A:old"), null);
    const keys = keySource(undefined);
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    expect(capture.events).toEqual([]);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    expect(linesWith("[engram] signed out")).toEqual([
      expect.stringContaining("; 1 queued message(s) stay on this machine"),
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await syncer.idle();
    expect(keys.reads).toBeGreaterThanOrEqual(30);
    expect(linesWith("[engram] signed out")).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    expect(server.requests).toEqual([]);
    expect(keys.connected).toEqual([]);

    // `engram auth login` saves a key: within one poll, capture starts and
    // what waited goes out with it.
    keys.configured = "key-a1";
    await vi.advanceTimersByTimeAsync(2_000);
    await syncer.idle();
    expect(capture.events).toEqual(["start"]);
    expect(recordSignedIn).toHaveBeenCalledTimes(1);
    expect(linesWith("[engram] signed in — capture and sync resumed")).toHaveLength(1);
    expect(server.copyOf(db, "s0", "key-a1")).toEqual(["A:old"]);
    expect(server.requests).toEqual([
      { op: "create", key: "key-a1" },
      { op: "store", key: "key-a1" },
    ]);

    // A logout is one more line, not one per poll.
    keys.configured = undefined;
    await vi.advanceTimersByTimeAsync(20_000);
    await syncer.idle();
    expect(capture.events).toEqual(["start", "stop+drain"]);
    expect(linesWith("[engram] signed out")).toHaveLength(2);
    expect(recordSignedOut).toHaveBeenCalledTimes(2);
  });

  it("a config.json it can't read is reported once, not on every poll, and a key is picked up once it reads", async () => {
    const keys = keySource(undefined);
    keys.readError = new Error("config.json: Unexpected end of JSON input");
    const capture = new FakeCapture(() => syncer);
    syncer = newSyncer(keys, capture);
    syncer.start();
    await vi.advanceTimersByTimeAsync(30_000);
    await syncer.idle();
    expect(errorsWith("[engram] reading the API key failed (will retry)")).toHaveLength(1);
    expect(capture.events).toEqual([]);

    keys.readError = null;
    keys.configured = "key-a1";
    await vi.advanceTimersByTimeAsync(2_000);
    await syncer.idle();
    expect(capture.events).toEqual(["start"]);
    expect(recordSignedIn).toHaveBeenCalledTimes(1);
  });
});

describe("a key of the same account sends what an earlier key queued (engram#594)", () => {
  it("a rotated key continues the session's conversation, and the server is asked once", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m2")); // queued under key-a1, not sent
    const before = server.requests.length;

    keys.configured = "key-a2";
    await syncer.flush();
    expect(server.requests.slice(before)).toEqual([
      { op: "owned", key: "key-a2" },
      { op: "store", key: "key-a2" },
    ]);
    expect(server.copyOf(db, "s1", "key-a2")).toEqual(["A:m1", "A:m2"]);
    expect(
      linesWith(
        "[engram] 1 earlier API key(s) are this account's — sending their 1 queued message(s) with this key",
      ),
    ).toHaveLength(1);

    await syncer.onMessages("s1", meta("s1"), msgs("A:m3"));
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a2")).toEqual(["A:m1", "A:m2", "A:m3"]);
    expect(server.count("owned")).toBe(1);
    expect(server.count("create")).toBe(1);
  });

  it.each([
    [
      "answers with a server error",
      () => Object.assign(new Error("checking earlier API keys failed: HTTP 503"), { status: 503 }),
    ],
    ["can't be reached", () => new TypeError("fetch failed")],
  ])(
    "while the server %s, a session synced under the earlier key waits 15 minutes at most, then goes on in a new conversation",
    async (_, error) => {
      const keys = keySource("key-a1");
      syncer = newSyncer(keys);
      await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
      await syncer.flush(); // conv_1, under key-a1

      server.ownedError = error();
      keys.configured = "key-a2";
      await syncer.checkKey();
      await syncer.onMessages("s1", meta("s1"), msgs("A:m2")); // waits: is key-a1 this account's?
      await syncer.onMessages("s2", meta("s2"), msgs("A:n1")); // a session of its own doesn't

      const t0 = Date.now();
      const at = async (seconds: number) => {
        vi.setSystemTime(t0 + seconds * 1000);
        await syncer.flush();
        return { asked: server.count("owned"), s1: server.copyOf(db, "s1", "key-a2") };
      };

      expect(await at(0)).toEqual({ asked: 1, s1: undefined });
      expect(server.copyOf(db, "s2", "key-a2")).toEqual(["A:n1"]);
      expect(await at(29)).toEqual({ asked: 1, s1: undefined });
      expect(await at(31)).toEqual({ asked: 2, s1: undefined }); // after 30 s
      expect(await at(149)).toEqual({ asked: 2, s1: undefined });
      expect(await at(152)).toEqual({ asked: 3, s1: undefined }); // then 2 min
      expect(await at(749)).toEqual({ asked: 3, s1: undefined });
      expect(await at(753)).toEqual({ asked: 4, s1: undefined }); // then 10 min
      expect(await at(899)).toEqual({ asked: 4, s1: undefined });
      // 15 minutes after the first ask, the session goes on without the
      // answer: split across two conversations, never lost.
      expect(await at(901)).toEqual({ asked: 4, s1: ["A:m2"] });
      expect(linesWith("session(s) synced under an earlier API key wait")).toHaveLength(1);
      expect(
        errorsWith("[engram] couldn't check which earlier API keys are this account's (will retry in"),
      ).toHaveLength(4);

      // The server answers at last: key-a1 is this account's. The session
      // goes on in its newest conversation; no third one is created.
      server.ownedError = null;
      expect((await at(1353)).asked).toBe(5);
      await syncer.onMessages("s1", meta("s1"), msgs("A:m3"));
      await syncer.flush();
      expect(server.copyOf(db, "s1", "key-a2")).toEqual(["A:m2", "A:m3"]);
      expect(server.conversations.get("conv_1")?.messages).toEqual(["A:m1"]);
      expect(server.count("create")).toBe(3); // s1's first, s2's, and s1's second
    },
  );

  it("a key the server rejects pauses everything, and the server is asked again when the pause ends", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("A:m2"));

    server.ownedError = Object.assign(new Error("checking earlier API keys failed: HTTP 401"), {
      status: 401,
    });
    keys.configured = "key-a2";
    await syncer.flush();
    expect(errorsWith("[engram] API key rejected — sync paused. Retrying in 10m")).toHaveLength(1);
    const asked = server.requests.length;
    for (let i = 0; i < 5; i++) {
      later(119_000);
      await syncer.flush();
    }
    expect(server.requests).toHaveLength(asked);

    server.ownedError = null;
    later(10_000);
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a2")).toEqual(["A:m1", "A:m2"]);
    expect(server.count("create")).toBe(1);
  });

  it.each([400, 403, 404])(
    "a server that refuses to say (HTTP %i) is asked once, and the earlier key's messages keep waiting for it",
    async (status) => {
      const keys = keySource("key-a1");
      syncer = newSyncer(keys);
      await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
      await syncer.flush();
      await syncer.onMessages("s1", meta("s1"), msgs("A:m2")); // queued under key-a1, not sent

      const refusal = `checking earlier API keys failed: HTTP ${status}`;
      server.ownedError = Object.assign(new Error(refusal), { status });
      keys.configured = "key-a2";
      await syncer.flush();
      expect(errors()).toContain(
        `[engram] couldn't check which earlier API keys are this account's: ${refusal}`,
      );
      expect(linesWith("[engram] 1 queued message(s) wait for another API key's account")).toHaveLength(1);

      // New captures go on, in a conversation under this key.
      await syncer.onMessages("s1", meta("s1"), msgs("A:m3"));
      for (const ms of [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000]) {
        later(ms);
        await syncer.flush();
      }
      expect(server.count("owned")).toBe(1);
      expect(server.copyOf(db, "s1", "key-a2")).toEqual(["A:m3"]);
      expect(db.getPendingCount(fp("key-a1"))).toBe(1);
    },
  );
});

/** daemon.db as 0.6 created it: schema version 0, no key on anything. */
const V0_SCHEMA = `
CREATE TABLE file_offsets (
  file_path TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE session_map (
  session_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  project_dir TEXT,
  cwd TEXT,
  git_branch TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE pending_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_call_id TEXT,
  tool_name TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_pending_unsent ON pending_messages(conversation_id) WHERE sent_at IS NULL;
CREATE TABLE excluded_sessions (
  session_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  delete_pending TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE pending_sessions (
  session_id TEXT PRIMARY KEY,
  meta TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
const V0_TABLES = [
  "file_offsets",
  "session_map",
  "pending_messages",
  "excluded_sessions",
  "pending_sessions",
];

/**
 * A 0.6 daemon.db: s1 synced to conv_old1 with one message still unsent, s2
 * waiting for its conversation, and s3 opted out with its server-side
 * delete still to do.
 */
function writeV0(path: string): void {
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.exec(V0_SCHEMA);
  const at = "2026-11-01 10:00:00";
  raw.prepare("INSERT INTO session_map VALUES (?, ?, ?, ?, ?, ?)").run(
    "s1",
    "conv_old1",
    "myproj",
    "/work/myproj",
    null,
    at,
  );
  const message = raw.prepare(
    "INSERT INTO pending_messages (conversation_id, role, content, created_at, sent_at) VALUES (?, ?, ?, ?, ?)",
  );
  message.run("conv_old1", "user", "A:m1", at, at);
  message.run("conv_old1", "assistant", "A:m2", at, null);
  raw.prepare("INSERT INTO pending_sessions VALUES (?, ?, ?, ?)").run(
    "s2",
    JSON.stringify(meta("s2")),
    at,
    at,
  );
  message.run("pending:s2", "user", "A:n1", at, null);
  raw.prepare("INSERT INTO excluded_sessions VALUES (?, ?, ?, ?)").run(
    "s3",
    "in-chat opt-out",
    "conv_old3",
    at,
  );
  raw.prepare("INSERT INTO file_offsets VALUES (?, ?, ?)").run("/x/s1.jsonl", 1234, at);
  raw.close();
}

const columns = (raw: Database.Database, table: string) =>
  (raw.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
const primaryKey = (raw: Database.Database, table: string) =>
  (raw.pragma(`table_info(${table})`) as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
const tableNames = (raw: Database.Database) =>
  (
    raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((t) => t.name);
const rowCounts = (raw: Database.Database) =>
  Object.fromEntries(
    V0_TABLES.map((t) => [t, (raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c]),
  );

describe("a daemon.db from before keys were recorded (engram#594)", () => {
  it("the first key it runs with claims what 0.6 queued: nothing is lost, sent twice, or created twice", async () => {
    const path = join(dir, "v0.db");
    writeV0(path);
    server.seed("conv_old1", "A", ["A:m1"]);
    server.seed("conv_old3", "A", ["A:opted out"]);
    db = track(new DaemonDb(path));
    syncer = newSyncer(keySource("key-a1"));
    await syncer.flush();

    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1", "A:m2"]);
    expect(server.copyOf(db, "s2", "key-a1")).toEqual(["A:n1"]);
    expect(server.deleted).toEqual(["conv_old3"]);
    expect(server.requests.every((r) => r.key === "key-a1")).toBe(true);
    expect(["owned", "delete", "create", "store"].map((op) => server.count(op as Op))).toEqual([
      0, 1, 1, 2,
    ]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("what is queued with no key while signed out goes to the next key, the same one included", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush();
    const conv = db.getConversationId("s1", fp("key-a1")) as string;

    keys.configured = undefined;
    await syncer.flush();
    // A 0.6 daemon (a downgrade) queues a message: it records no key.
    const raw = track(new Database(dbPath));
    raw
      .prepare(
        "INSERT INTO pending_messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', 'A:m2', datetime('now'))",
      )
      .run(conv);
    later(2_000);
    await syncer.flush();
    expect(server.count("store")).toBe(1);

    keys.configured = "key-a1";
    later(2_000);
    await syncer.flush();
    expect(server.copyOf(db, "s1", "key-a1")).toEqual(["A:m1", "A:m2"]);
  });
});

describe("an opt-out reaches the copy in every account (engram#594)", () => {
  it("each copy is deleted with its own account's key; the other's waits until that account signs in again", async () => {
    const keys = keySource("key-a1");
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("A:m1"));
    await syncer.flush(); // conv_1, in account A
    keys.configured = "key-b";
    await syncer.checkKey();
    await syncer.onMessages("s1", meta("s1"), msgs("B:m2"));
    await syncer.flush(); // conv_2, in account B

    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    expect(server.deleted).toEqual(["conv_2"]);
    expect(db.getPendingRemoteDeletes(fp("key-a1"))).toEqual([
      { conversation_id: "conv_1", session_id: "s1" },
    ]);
    // Both messages had been sent, so none was dropped (engram#628: the
    // count used to include sent rows and said 2).
    expect(linesWith("[engram] session s1 excluded (in-chat opt-out)")).toEqual([
      "[engram] session s1 excluded (in-chat opt-out) — 0 queued messages dropped, " +
        "deleting synced copy; 1 copy synced under another API key will be deleted " +
        "when that key's account signs in again",
    ]);

    // Nothing more of the session is captured, under either key.
    await syncer.onMessages("s1", meta("s1"), msgs("B:m3"));
    expect(db.getPendingCount()).toBe(0);

    keys.configured = "key-a1";
    await syncer.flush();
    expect(server.deleted).toEqual(["conv_2", "conv_1"]);
    expect(db.getPendingRemoteDeletes(fp("key-a1"))).toEqual([]);
    expect(db.getPendingRemoteDeletes(fp("key-b"))).toEqual([]);
  });
});

describe("daemon.db schema version 1 (engram#594)", () => {
  it("upgrades 0.6's daemon.db in place, keeping every row, and only once", () => {
    const path = join(dir, "v0.db");
    writeV0(path);
    const inspect = () => {
      const raw = new Database(path);
      try {
        return {
          version: raw.pragma("user_version", { simple: true }),
          tables: tableNames(raw),
          queueColumns: columns(raw, "pending_messages"),
          sessionKey: primaryKey(raw, "session_map"),
          rows: rowCounts(raw),
        };
      } finally {
        raw.close();
      }
    };
    const before = inspect();
    expect(before.version).toBe(0);

    new DaemonDb(path).close();
    const after = inspect();
    expect(after.version).toBe(3); // version 1, then 2 (engram#598), then 3 (engram#593)
    expect(after.tables).toContain("remote_deletes");
    expect(after.tables).toContain("gone_conversations");
    expect(after.queueColumns).toContain("key_fp");
    expect(after.sessionKey).toEqual(["conversation_id"]);
    expect(after.rows).toEqual(before.rows);

    new DaemonDb(path).close();
    expect(inspect()).toEqual(after);
  });

  it("a read-only open of 0.6's daemon.db while 0.6 runs changes nothing, and counts every queued message as pending", () => {
    const path = join(dir, "v0.db");
    writeV0(path);
    const daemon06 = track(new Database(path));
    const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = hash();

    const ro = new DaemonDb(path, { readonly: true });
    const stats = { trackedFiles: 1, pendingMessages: 2, heldMessages: 0, notSentMessages: 0, sessionsMapped: 1 };
    expect(ro.getStats(fp("key-a1"))).toEqual(stats);
    expect(ro.getStats(null)).toEqual(stats);
    expect(ro.getHeldCount(fp("key-a1"))).toBe(0);
    ro.close();

    expect(hash()).toBe(before);
    expect(daemon06.pragma("user_version", { simple: true })).toBe(0);
    expect(columns(daemon06, "pending_messages")).not.toContain("key_fp");
    expect(tableNames(daemon06)).not.toContain("remote_deletes");
  });

  it("a read-only open while the daemon runs splits pending from held by the key signed in", () => {
    db.enqueue("conv_a", msgs("A:1", "A:2"), fp("key-a1"));
    db.enqueue("conv_b", msgs("B:1"), fp("key-b"));
    const ro = track(new DaemonDb(dbPath, { readonly: true }));
    expect(ro.getStats(fp("key-a1"))).toMatchObject({ pendingMessages: 2, heldMessages: 1 });
    expect(ro.getStats(fp("key-b"))).toMatchObject({ pendingMessages: 1, heldMessages: 2 });
    expect(ro.getStats(null)).toMatchObject({ pendingMessages: 0, heldMessages: 3 });
    expect(ro.getStats()).toMatchObject({ pendingMessages: 3, heldMessages: 0 });
  });

  it("a read-only open works with no daemon running, and throws for a daemon.db that isn't there without creating it", () => {
    db.enqueue("conv_a", msgs("A:1"), fp("key-a1"));
    db.close();
    const ro = new DaemonDb(dbPath, { readonly: true });
    expect(ro.getStats(fp("key-a1"))).toMatchObject({ pendingMessages: 1, heldMessages: 0 });
    ro.close();

    const missing = join(dir, "nowhere", "daemon.db");
    expect(() => new DaemonDb(missing, { readonly: true })).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

describe("Watcher.stop({ drain }) (engram#594)", () => {
  const projects = () => join(dir, "projects");
  const projectDir = () => join(projects(), "-Users-x-proj");
  const transcript = (name: string) => join(projectDir(), `${name}.jsonl`);
  const userLine = (sessionId: string, text: string) => ({
    type: "user",
    sessionId,
    cwd: "/work/proj",
    message: { role: "user", content: text },
  });
  const append = (path: string, ...records: object[]) =>
    appendFileSync(path, records.map((r) => JSON.stringify(r) + "\n").join(""));

  /** A Claude Code watcher over the temp dir, driven directly instead of by chokidar. */
  function watcherFor(onMessages: OnMessages) {
    const adapter: HostAdapter = {
      id: "claude-code",
      label: "Claude Code",
      watchDir: projects(),
      available: () => true,
      createParser: (cb) => new Parser(cb),
    };
    const watcher = new Watcher(db, onMessages, adapter);
    const read = (path: string) =>
      (watcher as unknown as { processFile(p: string): void }).processFile(path);
    return { watcher, read };
  }

  function collector() {
    const out: string[] = [];
    const onMessages: OnMessages = (_sessionId, _meta, messages) => {
      out.push(...messages.map((m) => m.content));
    };
    return { out, onMessages };
  }

  beforeEach(() => {
    mkdirSync(projectDir(), { recursive: true });
  });

  it("a draining stop reads what was written since the last read; a plain stop leaves it for the next watcher", () => {
    const A = transcript("a");
    append(A, userLine("sess-a", "A:u1"));
    const first = collector();
    const w1 = watcherFor(first.onMessages);
    w1.read(A);
    append(A, userLine("sess-a", "A:u2"));
    w1.watcher.stop({ drain: true });
    expect(first.out).toEqual(["A:u1", "A:u2"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);

    append(A, userLine("sess-a", "A:u3"));
    const second = collector();
    const w2 = watcherFor(second.onMessages);
    w2.read(A);
    append(A, userLine("sess-a", "A:u4"));
    w2.watcher.stop();
    expect(second.out).toEqual(["A:u3"]);

    const third = collector();
    watcherFor(third.onMessages).read(A);
    expect(third.out).toEqual(["A:u4"]);
  });

  it("a draining stop also reads a transcript the watcher found but hadn't reported yet", () => {
    const B = transcript("b");
    append(B, userLine("sess-b", "A:a new session"));
    const { out, onMessages } = collector();
    const w = watcherFor(onMessages);
    // chokidar reports a new file only once its writes settle.
    (w.watcher as unknown as { fsWatcher: unknown }).fsWatcher = {
      getWatched: () => ({ [projectDir()]: ["b.jsonl", "notes.txt"] }),
      close: async () => {},
    };
    w.watcher.stop({ drain: true });
    expect(out).toEqual(["A:a new session"]);
    expect(db.getFileOffset(B)).toBe(statSync(B).size);
  });

  it("a file held at a line that couldn't be queued is let go quietly, and the next watcher reads that line again", () => {
    const A = transcript("a");
    append(A, userLine("sess-a", "A:u1"));
    const full: OnMessages = () => {
      throw new QueueWriteError(new Error("database or disk is full"));
    };
    const w1 = watcherFor(full);
    w1.read(A);
    expect(recordCaptureStall).toHaveBeenCalledTimes(1);
    w1.watcher.stop({ drain: true });
    expect(vi.mocked(recordCaptureResumed).mock.calls).toEqual([[A, { quiet: true }]]);
    expect(db.getFileOffset(A)).toBe(0);

    const { out, onMessages } = collector();
    watcherFor(onMessages).read(A);
    expect(out).toEqual(["A:u1"]);
  });

  it("with real watchers, lines written before a switch of account are queued for the account they were written under", async () => {
    const A = transcript("a");
    const keys = keySource("key-a1");
    const live: { w: ReturnType<typeof watcherFor> | null } = { w: null };
    const capture: CaptureControl = {
      start: () => {
        live.w = watcherFor((sessionId, m, messages) => {
          void syncer.onMessages(sessionId, m, messages);
        });
      },
      stop: (drain) => {
        live.w?.watcher.stop({ drain });
        live.w = null;
      },
    };
    const read = (path: string) => {
      if (!live.w) throw new Error("capture isn't running");
      live.w.read(path);
    };
    syncer = newSyncer(keys, capture);
    syncer.start();

    append(A, userLine("sess-1", "A:u1"));
    read(A);
    await syncer.flush();
    expect(server.copyOf(db, "sess-1", "key-a1")).toEqual(["A:u1"]);

    // Written before the switch to account B, and not read yet.
    append(A, userLine("sess-1", "A:u2"));
    keys.configured = "key-b";
    await syncer.flush();
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);
    expect(server.copyOf(db, "sess-1", "key-b")).toBeUndefined();

    append(A, userLine("sess-1", "B:u3"));
    read(A);
    await syncer.flush();
    expect(server.copyOf(db, "sess-1", "key-b")).toEqual(["B:u3"]);

    keys.configured = "key-a1";
    await syncer.flush();
    expect(server.copyOf(db, "sess-1", "key-a1")).toEqual(["A:u1", "A:u2"]);
    expect(db.getPendingCount()).toBe(0);
  });
});
