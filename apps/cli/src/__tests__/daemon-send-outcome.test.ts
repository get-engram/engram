import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json (the watchdog reads it);
// exclusions.ts reads the real ~/.engram/config.json. Keep both off the
// developer's machine. classifyError stays real.
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: () => false,
}));

import { DaemonDb } from "../daemon/db.js";
import { Syncer } from "../daemon/syncer.js";
import { recordFailure, recordSuccess } from "../daemon/status.js";
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

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  /** Every send attempt, failed or not. */
  sends: StoreParams[] = [];
  creates = 0;
  stored = new Map<string, string[]>();
  /** Error for every send while set. */
  sendError: Error | null = null;
  /** Per-send failure, decided from what is being sent. */
  failWhen: ((p: StoreParams) => Error | null) | null = null;
  /** Per-send latency in real milliseconds (only Date is faked). */
  delayWhen: ((p: StoreParams) => number) | null = null;
  private seq = 0;

  async createConversation() {
    this.creates++;
    return { conversationId: `conv_${++this.seq}` };
  }

  async store(p: StoreParams) {
    this.sends.push(p);
    const delay = this.delayWhen?.(p) ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const err = this.failWhen?.(p) ?? this.sendError;
    if (err) throw err;
    const list = this.stored.get(p.conversationId) ?? [];
    list.push(...p.messages.map((m) => m.content));
    this.stored.set(p.conversationId, list);
    return { stored: p.messages.length };
  }

  async deleteConversation() {}

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

    // An ordinary failure isn't a backoff: the next 2 s flush retries it.
    server.failWhen = null;
    await flushAfter(2_000);
    expect(server.copyOf(db, "s-b")).toEqual(["b1"]);
    expect(db.getPendingCount()).toBe(0);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("a rejected key stops syncing, and status never reads healthy", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("m1"));
    await syncer.onMessages("s2", meta("s2"), msgs("m2"));
    server.sendError = new Error("401 Unauthorized");

    expect(await flushAfter(0)).toBe(2);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(new Set(failureTypes())).toEqual(new Set(["auth"]));

    // Nothing is sent or created again until the daemon restarts with a
    // working key; a session that starts meanwhile waits in daemon.db.
    await syncer.onMessages("s3", meta("s3"), msgs("m3"));
    expect(await flushAfter(60 * 60_000)).toBe(2);
    expect(server.creates).toBe(2);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(db.getPendingCount()).toBe(3);
    expect(db.getPendingSessions().map((s) => s.sessionId)).toEqual(["s3"]);
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
