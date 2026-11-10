import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AuthenticationError, EngramError, NotFoundError, type Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine. classifyError and isConversationGone stay real.
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

import { DaemonDb, SCHEMA_VERSION } from "../daemon/db.js";
import { FIXED_KEY_FP, GONE_RECHECK_MS, Syncer, keyFingerprint, type Account } from "../daemon/syncer.js";
import { DEFAULT_BASE_URL } from "../server-url.js";
import { isConversationGone, recordFailure, recordSuccess } from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#593: when Engram no longer had a conversation (the user deleted
// it, or it isn't this account's), every send to it was refused, the
// refusal was taken for a network error, and the send was tried again
// every 2 s, forever. Its messages, and everything captured for its session
// after them, went nowhere, while status said Engram couldn't be reached.
//
// The append tool's answer (`conversation_not_found`, engram#592) now sets
// the conversation aside: its messages stay in daemon.db, not sent, and the
// daemon asks again a few times over the next days, then stops asking. The
// conversation is never created again: one the user deleted must not come
// back.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The append tool's refusal for a conversation the key can't write to
 *  (apps/mcp-server conversationNotFound): absent, deleted, or another
 *  account's, alike. */
const NOT_FOUND_BODY = {
  error: "conversation_not_found",
  message: "No conversation with that id exists in this account.",
};

/** What the SDK throws (packages/sdk/src/transport.ts) for a tool's
 *  refusal: the tool's JSON body as the message, no code, no status. */
const refusal = (body: object) => new EngramError(JSON.stringify(body));

/** What the SDK throws for an HTTP error status: an empty message, the
 *  code "undefined", and the status. */
const httpError = (status: number) => new EngramError("", "undefined", status);

const dnsFailure = () =>
  Object.assign(new Error("getaddrinfo ENOTFOUND mcp.getengram.app"), { code: "ENOTFOUND" });

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  /** Every send, refused or not, with the key it carried. */
  sends: Array<StoreParams & { key: string }> = [];
  creates = 0;
  /** What each conversation holds. One not here doesn't exist. */
  stored = new Map<string, string[]>();
  /** Each conversation's account: here, the key that created it. */
  owner = new Map<string, string>();
  /** Thrown by every send while set, before the conversation is looked
   *  up: the network, a maintenance pause, a rate limit. */
  sendError: Error | null = null;
  /** While set, every request is refused as the SDK throws a 401. */
  rejectKeys = false;
  /** Conversations deleted through the daemon. */
  deleted: string[] = [];
  private seq = 0;

  /** A client for one key, as `new Engram({ apiKey })` makes. */
  client(key = "key-1"): Engram {
    return {
      createConversation: async () => {
        this.creates++;
        const id = `conv_${++this.seq}`;
        this.stored.set(id, []);
        this.owner.set(id, key);
        return { conversationId: id };
      },
      store: async (p: StoreParams) => {
        this.sends.push({ ...p, key });
        if (this.rejectKeys) throw new AuthenticationError();
        if (this.sendError) throw this.sendError;
        const held = this.stored.get(p.conversationId);
        // The append tool's org-scoped lookup (engram#592).
        if (!held || this.owner.get(p.conversationId) !== key) throw refusal(NOT_FOUND_BODY);
        held.push(...p.messages.map((m) => m.content));
        return { stored: p.messages.length };
      },
      deleteConversation: async (id: string) => {
        // The delete tool's own answer for a conversation it hasn't got.
        if (!this.stored.has(id)) throw refusal({ error: "Conversation not found" });
        this.deleted.push(id);
        this.stored.delete(id);
      },
    } as unknown as Engram;
  }

  /** The user deletes a conversation on Engram: the dashboard, or
   *  `engram conversations delete`. */
  remove(id: string): void {
    this.stored.delete(id);
  }

  /** The conversation is on Engram again (a restore), holding `held`. */
  restore(id: string, held: string[]): void {
    this.stored.set(id, [...held]);
  }

  /** What a store to `id` carried, send by send, from the `from`-th on. */
  batches(id: string, from = 0): string[][] {
    return this.sends
      .slice(from)
      .filter((p) => p.conversationId === id)
      .map((p) => p.messages.map((m) => m.content));
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

/** Rows in daemon.db's record of conversations Engram doesn't have. */
function goneRows(): number {
  const raw = new Database(join(dir, "daemon.db"), { readonly: true });
  try {
    return (raw.prepare("SELECT COUNT(*) AS c FROM gone_conversations").get() as { c: number }).c;
  } finally {
    raw.close();
  }
}

const failureTypes = () => vi.mocked(recordFailure).mock.calls.map((c) => c[1]);
/** What the daemon logged, one line per call. */
const logged = () => vi.mocked(console.log).mock.calls.map((c) => c.join(" "));
const errorLog = () => vi.mocked(console.error).mock.calls.map((c) => c.join(" "));

/**
 * Session s1 syncs "m1"; then the user deletes its conversation on Engram,
 * and `later` are captured for it. One flush sends them and is answered
 * that the conversation isn't there. Returns the conversation's id.
 */
async function deletedWith(...later: string[]): Promise<string> {
  await syncer.onMessages("s1", meta("s1"), msgs("m1"));
  await syncer.flush();
  const conv = db.getConversationId("s1", FIXED_KEY_FP);
  if (!conv || server.stored.get(conv)?.join() !== "m1") throw new Error("s1 didn't sync");
  server.remove(conv);
  await syncer.onMessages("s1", meta("s1"), msgs(...later));
  vi.mocked(recordSuccess).mockClear();
  await flushAfter(2_000);
  return conv;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-gone-"));
  db = new DaemonDb(join(dir, "daemon.db"));
  server = new FakeServer();
  syncer = new Syncer(db, server.client());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(recordSuccess).mockClear();
  vi.mocked(recordFailure).mockClear();
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("a conversation Engram no longer has (engram#593)", () => {
  it("is set aside at the first answer: not tried every 2 s, nothing lost, no failure", async () => {
    const conv = await deletedWith("m2", "m3");
    const sends = server.sends.length;
    expect(server.batches(conv)).toEqual([["m1"], ["m2", "m3"]]);

    // The 2 s flush loop sends it nothing more, nor does any flush for
    // the next ten minutes.
    for (const ms of [2_000, 2_000, 30_000, 5 * MIN, 4 * MIN]) {
      expect(await flushAfter(ms)).toBe(sends);
    }

    // Its messages are kept, apart from what is waiting to go.
    expect(db.getUnsentCount(conv)).toBe(2);
    expect(db.getNotSentCount()).toBe(2);
    expect(db.getPendingCount()).toBe(0);
    expect(db.getPendingCount(FIXED_KEY_FP)).toBe(0);
    expect(db.getStats(FIXED_KEY_FP)).toMatchObject({
      pendingMessages: 0,
      heldMessages: 0,
      notSentMessages: 2,
    });

    // Nothing failed: Engram answered, and nothing more can be sent there.
    // It used to be recorded as "can't reach Engram", every 2 s.
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledWith(0);
    expect(errorLog()).toEqual([]);
    expect(logged()).toContain(
      `[engram] conversation ${conv} isn't on Engram (deleted there, or not this account's) — ` +
        "keeping its 2 queued messages on this machine, not sent; checking again in 10 minutes",
    );
  });

  it("keeps what is captured for its session later, and never creates the conversation again", async () => {
    const conv = await deletedWith("m2");
    await syncer.onMessages("s1", meta("s1"), msgs("m3", "m4"));
    for (const ms of [2_000, 30_000, 5 * MIN]) await flushAfter(ms);

    expect(server.creates).toBe(1);
    expect(db.getConversationId("s1", FIXED_KEY_FP)).toBe(conv);
    expect(server.batches(conv)).toEqual([["m1"], ["m2"]]);
    expect(db.getNotSentCount()).toBe(3);
    expect(db.getPendingCount()).toBe(0);
    expect(server.stored.has(conv)).toBe(false);
  });

  it("is asked again after 10 minutes, 1 hour, 6 hours, 1 day and 3 days, one message at a time, then never", async () => {
    const conv = await deletedWith("m2", "m3");
    const sends = server.sends.length;

    const waits = [10 * MIN, HOUR, 6 * HOUR, DAY, 3 * DAY];
    expect(GONE_RECHECK_MS).toEqual(waits);
    for (const [i, wait] of waits.entries()) {
      expect(await flushAfter(wait - 1_000)).toBe(sends + i);
      expect(await flushAfter(1_000)).toBe(sends + i + 1);
      // The oldest message asks; the rest wait for the answer.
      expect(server.sends.at(-1)?.messages.map((m) => m.content)).toEqual(["m2"]);
    }

    // The answer after the last check is final: a month on, nothing more.
    for (const ms of [2_000, 3 * DAY, 30 * DAY]) {
      expect(await flushAfter(ms)).toBe(sends + waits.length);
    }
    expect(db.getNotSentCount()).toBe(2);
    expect(server.creates).toBe(1);
    expect(recordFailure).not.toHaveBeenCalled();

    const notes = logged().filter((l) => l.startsWith(`[engram] conversation ${conv} `));
    const kept = "(deleted there, or not this account's) — keeping its 2 queued messages on this machine, not sent; ";
    const first = `[engram] conversation ${conv} isn't on Engram ${kept}`;
    const still = `[engram] conversation ${conv} still isn't on Engram ${kept}`;
    expect(notes).toEqual([
      `${first}checking again in 10 minutes`,
      `${still}checking again in 1 hour`,
      `${still}checking again in 6 hours`,
      `${still}checking again in 1 day`,
      `${still}checking again in 3 days`,
      `${still}not checking again`,
    ]);
  });

  it("is sent in full once a check goes through, and is synced as usual from then on", async () => {
    const queued = Array.from({ length: 30 }, (_, i) => `q${i}`);
    const conv = await deletedWith(...queued);
    server.restore(conv, ["m1"]);
    const from = server.sends.length;

    await flushAfter(10 * MIN);
    // One message checks; the rest goes in full batches (25) after it.
    expect(server.batches(conv, from).map((b) => b.length)).toEqual([1, 25, 4]);
    expect(server.stored.get(conv)).toEqual(["m1", ...queued]);
    expect(db.getNotSentCount()).toBe(0);
    expect(db.getPendingCount()).toBe(0);
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([]);
    expect(logged()).toContain(
      `[engram] conversation ${conv} is on Engram again — sending its queued messages`,
    );
    expect(recordSuccess).toHaveBeenLastCalledWith(0);

    // Not set aside any more: a new capture goes at the next flush.
    await syncer.onMessages("s1", meta("s1"), msgs("next"));
    await flushAfter(2_000);
    expect(server.stored.get(conv)?.at(-1)).toBe("next");
    expect(server.creates).toBe(1);

    // And an answer that it's gone again starts the schedule over.
    server.remove(conv);
    await syncer.onMessages("s1", meta("s1"), msgs("after"));
    await flushAfter(2_000);
    expect(logged().at(-1)).toMatch(/ isn't on Engram .*; checking again in 10 minutes$/);
  });

  it("keeps its place in the schedule when the daemon restarts", async () => {
    const conv = await deletedWith("m2");
    await flushAfter(10 * MIN); // still not there: the next check is in an hour
    const sends = server.sends.length;

    // A new daemon process, with the same daemon.db.
    db.close();
    db = new DaemonDb(join(dir, "daemon.db"));
    syncer = new Syncer(db, server.client());

    expect(await flushAfter(2_000)).toBe(sends);
    expect(await flushAfter(HOUR - 4_000)).toBe(sends);
    expect(await flushAfter(2_000)).toBe(sends + 1);
    expect(server.batches(conv).at(-1)).toEqual(["m2"]);
    expect(server.creates).toBe(1);
    expect(db.getNotSentCount()).toBe(1);
  });

  it.each([
    ["the network", () => new Error("fetch failed"), "network"],
    [
      "a maintenance pause",
      () => refusal({ error: "writes_paused", message: "Engram is paused for a few minutes of scheduled maintenance." }),
      "paused",
    ],
  ])("a check that fails on %s is that failure: tried again soon, and the schedule doesn't move", async (_, error, type) => {
    const conv = await deletedWith("m2", "m3");
    const sends = server.sends.length;

    server.sendError = error();
    expect(await flushAfter(10 * MIN)).toBe(sends + 1);
    expect(failureTypes()).toEqual([type]);
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([
      { conversationId: conv, checkedAt: expect.any(Number), checks: 1 },
    ]);

    // Tried again within seconds (engram#596), still with one message.
    server.sendError = null;
    expect(await flushAfter(5_000)).toBe(sends + 2);
    expect(server.sends.at(-1)?.messages).toHaveLength(1);
    // That was the second answer that it isn't there: the next check is
    // an hour on.
    expect(logged().at(-1)).toMatch(/ still isn't on Engram .*; checking again in 1 hour$/);
    expect(db.getNotSentCount()).toBe(2);
  });

  it("its answer shows a key that was rejected works again", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.flush();
    const conv = db.getConversationId("s1", FIXED_KEY_FP)!;

    // The key is rejected (revoked, say), and the conversation deleted.
    server.rejectKeys = true;
    server.remove(conv);
    await syncer.onMessages("s1", meta("s1"), msgs("m2"));
    await flushAfter(2_000);
    expect(failureTypes()).toEqual(["auth"]);
    vi.mocked(recordSuccess).mockClear();

    // The revocation is undone. At the retry, Engram answers that it hasn't
    // got the conversation: the key works, so the status is healthy again.
    server.rejectKeys = false;
    await flushAfter(10 * MIN);
    expect(server.sends.at(-1)?.conversationId).toBe(conv);
    expect(recordSuccess).toHaveBeenCalledWith(0);
    expect(db.getNotSentCount()).toBe(1);
  });

  it("opting its session out drops its messages and the mark, and the delete finds nothing to delete", async () => {
    const conv = await deletedWith("m2");
    await syncer.onMessages("s1", meta("s1"), [{ role: "user", content: "engram:ignore" }]);
    await flushAfter(2_000);

    expect(db.getUnsentCount(conv)).toBe(0);
    expect(db.getNotSentCount()).toBe(0);
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([]);
    expect(goneRows()).toBe(0);
    // The delete is answered that there's nothing there, which is done.
    expect(db.getPendingRemoteDeletes(FIXED_KEY_FP)).toEqual([]);
    expect(server.deleted).toEqual([]);

    const sends = server.sends.length;
    expect(await flushAfter(10 * MIN)).toBe(sends);
    expect(await flushAfter(DAY)).toBe(sends);
  });

  it("leaves the other conversations syncing", async () => {
    const conv = await deletedWith("m2");
    await syncer.onMessages("s2", meta("s2"), msgs("other-1"));
    await flushAfter(2_000);
    await syncer.onMessages("s2", meta("s2"), msgs("other-2"));
    await flushAfter(2_000);

    const other = db.getConversationId("s2", FIXED_KEY_FP);
    expect(other).not.toBe(conv);
    expect(server.stored.get(other!)).toEqual(["other-1", "other-2"]);
    expect(server.batches(conv)).toEqual([["m1"], ["m2"]]);
    expect(recordSuccess).toHaveBeenLastCalledWith(0);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(db.getNotSentCount()).toBe(1);
  });

  it.each([
    ["an HTTP 404 from whatever answered", () => httpError(404)],
    ["the SDK's NotFoundError", () => new NotFoundError()],
    ["the not-found body with an HTTP status", () => new EngramError(JSON.stringify(NOT_FOUND_BODY), "undefined", 404)],
    ["the delete tool's answer", () => refusal({ error: "Conversation not found" })],
    ["a DNS failure", dnsFailure],
  ])("%s is not that answer: retried as before, never set aside", async (_, error) => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    server.sendError = error();
    await syncer.flush();
    expect(recordFailure).toHaveBeenCalled();
    expect(db.getNotSentCount()).toBe(0);
    expect(db.getPendingCount()).toBe(1);

    server.sendError = null;
    await flushAfter(5_000);
    expect(server.batches(db.getConversationId("s1", FIXED_KEY_FP)!).at(-1)).toEqual(["m1"]);
    expect(db.getPendingCount()).toBe(0);
  });
});

/** The daemon's key source (worker-main.ts): the key `engram auth login`
 *  last saved, and a client for each key. Each key is an account of its
 *  own. */
function keySource(initial: string) {
  const keys = {
    current: { key: initial, server: DEFAULT_BASE_URL } as Account | undefined,
    configured: initial as string | undefined,
    async read(): Promise<Account | undefined> {
      return keys.configured === undefined ? undefined : { key: keys.configured, server: DEFAULT_BASE_URL };
    },
    connect(account: Account): Engram {
      return server.client(account.key);
    },
    async ownedKeys(_account: Account, _hashes: string[]): Promise<string[]> {
      return [];
    },
  };
  return keys;
}

describe("a conversation Engram no longer has, with two accounts (engram#593, engram#594)", () => {
  it("isn't pending or held for anyone, and is asked about only with its own account's key", async () => {
    const keys = keySource("key-a");
    syncer = new Syncer(db, null, null, keys);
    const [fpA, fpB] = [keyFingerprint("key-a"), keyFingerprint("key-b")];

    await syncer.onMessages("s1", meta("s1"), msgs("a1"));
    await syncer.flush();
    const conv = db.getConversationId("s1", fpA)!;
    server.remove(conv);
    await syncer.onMessages("s1", meta("s1"), msgs("a2", "a3"));
    await flushAfter(2_000);
    expect(db.getNotSentCount()).toBe(2);

    // Account B signs in. A's set-aside messages are neither B's to send
    // nor held for A: A signing in again can't send them either.
    keys.configured = "key-b";
    await flushAfter(2_000);
    for (const fp of [fpA, fpB, null]) {
      expect(db.getStats(fp)).toMatchObject({ pendingMessages: 0, heldMessages: 0, notSentMessages: 2 });
    }

    // However long B is signed in, B's key never asks about A's conversation.
    const sends = server.sends.length;
    for (const ms of [10 * MIN, HOUR, 6 * HOUR, DAY]) await flushAfter(ms);
    expect(server.sends.length).toBe(sends);

    // A signs in again; the check, long due, goes with A's key.
    server.restore(conv, ["a1"]);
    keys.configured = "key-a";
    await flushAfter(2_000);
    expect(server.stored.get(conv)).toEqual(["a1", "a2", "a3"]);
    expect(server.sends.filter((p) => p.conversationId === conv).map((p) => p.key)).toEqual([
      "key-a",
      "key-a",
      "key-a",
      "key-a",
    ]);
    expect(db.getNotSentCount()).toBe(0);
  });
});

describe("isConversationGone: the append tool's answer, and nothing else (engram#593)", () => {
  it.each<[string, unknown, boolean]>([
    ["the append tool's refusal", refusal(NOT_FOUND_BODY), true],
    ["its code alone", refusal({ error: "conversation_not_found" }), true],
    ["the same body with an HTTP 404", new EngramError(JSON.stringify(NOT_FOUND_BODY), "undefined", 404), false],
    ["an HTTP 404", httpError(404), false],
    ["the SDK's NotFoundError", new NotFoundError(), false],
    ["the delete and get tools' answer", refusal({ error: "Conversation not found" }), false],
    ["the phrase alone", new EngramError("Conversation not found"), false],
    ["the code as plain text", new EngramError("conversation_not_found"), false],
    ["another refusal", refusal({ error: "writes_paused", message: "Paused." }), false],
    ["a rejected key", new AuthenticationError(), false],
    ["a DNS failure", dnsFailure(), false],
    ["nothing", undefined, false],
  ])("%s → %s", (_, err, gone) => {
    expect(isConversationGone(err)).toBe(gone);
  });
});

describe("daemon.db's record of them (engram#593)", () => {
  /** Take daemon.db back to version 2: before the record existed. */
  function asVersion2(): void {
    db.close();
    const raw = new Database(join(dir, "daemon.db"));
    raw.exec("DROP TABLE gone_conversations");
    raw.pragma("user_version = 2");
    raw.close();
  }

  const version = () => {
    const raw = new Database(join(dir, "daemon.db"), { readonly: true });
    try {
      return {
        version: raw.pragma("user_version", { simple: true }),
        table: raw.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'gone_conversations'").get() !== undefined,
      };
    } finally {
      raw.close();
    }
  };

  it("is added to a version 2 daemon.db, keeping every row", () => {
    db.enqueue("conv_x", msgs("x1", "x2"), FIXED_KEY_FP);
    asVersion2();
    expect(version()).toEqual({ version: 2, table: false });

    db = new DaemonDb(join(dir, "daemon.db"));
    expect(SCHEMA_VERSION).toBe(4);
    expect(version()).toEqual({ version: 4, table: true });
    expect(db.getPendingCount()).toBe(2);
    expect(db.getNotSentCount()).toBe(0);
    expect(db.getPendingConversationIds(FIXED_KEY_FP)).toEqual(["conv_x"]);
  });

  it("is read as empty from a version 2 daemon.db an older daemon still has open", () => {
    db.enqueue("conv_x", msgs("x1", "x2"), FIXED_KEY_FP);
    asVersion2();

    const ro = new DaemonDb(join(dir, "daemon.db"), { readonly: true });
    try {
      expect(ro.getStats(FIXED_KEY_FP)).toMatchObject({
        pendingMessages: 2,
        heldMessages: 0,
        notSentMessages: 0,
      });
      expect(ro.getPendingCount()).toBe(2);
      expect(ro.getGoneConversations(FIXED_KEY_FP)).toEqual([]);
    } finally {
      ro.close();
    }
    // Reading it changed nothing.
    expect(version()).toEqual({ version: 2, table: false });
    db = new DaemonDb(join(dir, "daemon.db"));
  });

  it("counts the answers in a row, and starts over once the conversation is back", () => {
    db.enqueue("conv_x", msgs("x1"), FIXED_KEY_FP);
    expect(db.markGone("conv_x", 1_000)).toBe(1);
    expect(db.markGone("conv_x", 2_000)).toBe(2);
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([
      { conversationId: "conv_x", checkedAt: 2_000, checks: 2 },
    ]);
    // Only under the key its messages were queued under.
    expect(db.getGoneConversations(keyFingerprint("key-other"))).toEqual([]);

    db.clearGone("conv_x");
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([]);
    expect(db.getPendingCount()).toBe(1);
    expect(db.markGone("conv_x", 3_000)).toBe(1);
  });

  it("is listed only while the conversation has unsent messages", () => {
    db.enqueue("conv_x", msgs("x1"), FIXED_KEY_FP);
    db.markGone("conv_x", 1_000);
    const [row] = db.dequeue("conv_x", 10, FIXED_KEY_FP);
    db.markSent([row!.id]);
    expect(db.getGoneConversations(FIXED_KEY_FP)).toEqual([]);
    expect(db.getNotSentCount()).toBe(0);
  });
});
