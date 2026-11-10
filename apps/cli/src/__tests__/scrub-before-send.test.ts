import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AuthenticationError, EngramError, TimeoutError, type Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json; exclusions.ts reads the
// real ~/.engram/config.json. Keep both off the developer's machine.
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
import { Syncer, type KeySource } from "../daemon/syncer.js";
import { DEFAULT_BASE_URL } from "../server-url.js";
import {
  SecretScrubber,
  READ_RETRY_MS,
  MAX_SERVER_HOLD_MS,
  type VaultLike,
} from "../daemon/scrubber.js";
import { recordFailure, recordSuccess } from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#588: messages queued before the vault had been read were sent
// unscrubbed — everything the watcher's first scan finds at start, and
// anything captured while a replaced key's first read was in flight. These
// tests pin "nothing is sent before the vault has been read, and what's
// sent is scrubbed against the set held at that moment".

const KEY = "base64-vault-key-value";

/** What the SDK throws when fetch fails: no answer at all. */
const offline = () => new EngramError("Network error: fetch failed");
/** What it throws when the request times out. */
const timedOut = () => new TimeoutError();
/** An HTTP 503 with a JSON body: the message is empty, the status says it. */
const unavailable = () => new EngramError("", "undefined", 503);
/** A tool's transient error: its JSON body is the message. */
const busy = () =>
  new EngramError(JSON.stringify({ error: "service_unavailable", message: "Try again shortly." }));
/** The server's refusal of a key without the read scope (mcp/scopes.ts). */
const noReadScope = () =>
  new EngramError(
    JSON.stringify({
      error: "insufficient_scope",
      required: "read",
      message: "This API key does not have the 'read' permission.",
    }),
  );
/** WebCrypto's error for a value that doesn't decrypt with this key. */
const wrongKey = () =>
  new DOMException("The operation failed for an operation-specific reason", "OperationError");

/** A vault whose answers the test decides. */
class FakeVault implements VaultLike {
  lists = 0;
  gets: string[] = [];
  listError: (() => unknown) | null = null;
  getErrors: Record<string, () => unknown> = {};
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(public secrets: Record<string, string>) {}

  /** Hold every list() until release(). */
  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  async list(): Promise<Array<{ name: string }>> {
    this.lists++;
    if (this.gate) await this.gate;
    if (this.listError) throw this.listError();
    return Object.keys(this.secrets).map((name) => ({ name }));
  }

  async get(name: string): Promise<string | null> {
    this.gets.push(name);
    const fail = this.getErrors[name];
    if (fail) throw fail();
    return this.secrets[name] ?? null;
  }
}

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Let pending promise callbacks run (only Date is faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the scrubber says when captured messages may be sent (engram#588)", () => {
  it("scrubs the vault key from the first message, before any read", () => {
    const s = new SecretScrubber(new FakeVault({}), KEY);
    expect(s.active).toBe(true);
    expect(s.scrub(`key=${KEY}`).text).toBe("key=[VAULT:vault-key]");
  });

  it("waits for the first read in flight, and is ready once it lands", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const s = new SecretScrubber(vault, KEY);
    void s.refresh(); // as start() does

    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(ready).toBeUndefined();

    vault.release();
    await settle();
    expect(ready).toBe(true);
    expect(vault.lists).toBe(1); // waited for that read; didn't start another
    expect(s.scrub("the PIN is 4821").text).toBe("the PIN is [VAULT:PIN]");
  });

  it("joins a read already in flight rather than reading the vault twice", async () => {
    // The interval and a due retry can ask at the same moment; each read is a
    // list plus one get per secret, and every get writes an audit row.
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const s = new SecretScrubber(vault, KEY);
    let landed = 0;
    void s.refresh().then(() => landed++);
    void s.refresh().then(() => landed++);
    await settle();
    expect(vault.lists).toBe(1);
    expect(landed).toBe(0);

    vault.release();
    await settle();
    expect(landed).toBe(2);
    expect(vault.lists).toBe(1);
    expect(vault.gets).toEqual(["PIN"]);
  });

  it("after a failed read, holds and retries in 10 s, 30 s, then every minute, until a read lands", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(vault.lists).toBe(1); // a retry isn't due on the next flush

    const readsAfter = async (ms: number) => {
      later(ms);
      expect(await s.ready()).toBe(false);
      return vault.lists;
    };
    expect(await readsAfter(READ_RETRY_MS[0] - 1)).toBe(1);
    expect(await readsAfter(1)).toBe(2); // 10 s
    expect(await readsAfter(READ_RETRY_MS[1] - 1)).toBe(2);
    expect(await readsAfter(1)).toBe(3); // 30 s
    expect(await readsAfter(READ_RETRY_MS[2] - 1)).toBe(3);
    expect(await readsAfter(1)).toBe(4); // 1 min
    expect(await readsAfter(READ_RETRY_MS[2])).toBe(5); // still 1 min
    expect(s.failure).toBeInstanceOf(EngramError);

    vault.listError = null;
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(s.scrub("4821").text).toBe("[VAULT:PIN]");

    // A failure after that starts the schedule over.
    vault.secrets.NEW = "new-secret";
    vault.getErrors.NEW = unavailable;
    await s.refresh();
    expect(await s.ready()).toBe(false);
    const reads = vault.lists;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(vault.lists).toBe(reads + 1);
  });

  it("holds 15 minutes at most while the server answers with errors, then lets sends go with what's known", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = busy;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();

    later(MAX_SERVER_HOLD_MS - 1);
    expect(await s.ready()).toBe(false);
    later(1);
    expect(await s.ready()).toBe(true);
    expect(s.names).toEqual(["vault-key"]);
    expect(log.filter((l) => l.includes("failed to read for 15 minutes"))).toHaveLength(1);

    // From here the interval reads; ready() doesn't send a read per flush.
    const reads = vault.lists;
    for (let i = 0; i < 5; i++) {
      later(READ_RETRY_MS[2]);
      expect(await s.ready()).toBe(true);
    }
    expect(vault.lists).toBe(reads);
    expect(log.filter((l) => l.includes("failed to read for 15 minutes"))).toHaveLength(1);

    // The interval's read lands: the whole vault is scrubbed again...
    vault.listError = null;
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.scrub("4821").text).toBe("[VAULT:PIN]");

    // ...and a failure after that gets its own 15 minutes.
    vault.secrets.NEW = "new-secret";
    vault.getErrors.NEW = busy;
    await s.refresh();
    expect(await s.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS - 1);
    expect(await s.ready()).toBe(false);
  });

  it("a replaced key's reads get their own 15 minutes", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = busy;
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    later(MAX_SERVER_HOLD_MS);
    expect(await s.ready()).toBe(true);

    const next = new FakeVault({ PIN: "4821" });
    next.listError = busy;
    await s.reconnect(next);
    expect(await s.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS - 1);
    expect(await s.ready()).toBe(false);
  });

  it("once released, a read that gets no answer holds again; another server error doesn't", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();
    later(MAX_SERVER_HOLD_MS);
    expect(await s.ready()).toBe(true);

    await s.refresh(); // the interval: still failing
    expect(await s.ready()).toBe(true);

    vault.listError = offline;
    await s.refresh(); // the interval: no answer
    expect(await s.ready()).toBe(false);

    // Answering again: its own 15 minutes, and its own log line.
    vault.listError = unavailable;
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS);
    expect(await s.ready()).toBe(true);
    expect(log.filter((l) => l.includes("failed to read for 15 minutes"))).toHaveLength(2);
  });

  it("holds however long Engram can't be reached: the sends couldn't go either", async () => {
    for (const fail of [offline, timedOut]) {
      const vault = new FakeVault({ PIN: "4821" });
      vault.listError = fail;
      const s = new SecretScrubber(vault, KEY);
      await s.refresh();
      for (let i = 0; i < 24; i++) {
        later(5 * 60_000);
        expect(await s.ready(), `${fail.name} after ${(i + 1) * 5} min`).toBe(false);
      }
      vault.listError = null;
      later(READ_RETRY_MS[2]);
      expect(await s.ready()).toBe(true);
      expect(s.scrub("4821").text).toBe("[VAULT:PIN]");
    }
  });

  it("an outage restarts the 15 minutes, so a set cut short doesn't go out the moment the network returns", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();

    later(14 * 60_000);
    expect(await s.ready()).toBe(false);
    vault.listError = offline;
    later(60_000); // 15 min since the first error, but nothing answered
    expect(await s.ready()).toBe(false);
    vault.listError = unavailable;
    later(60_000); // answering again: its 15 minutes start now
    expect(await s.ready()).toBe(false);
    later(MAX_SERVER_HOLD_MS - 1);
    expect(await s.ready()).toBe(false);
    later(1);
    expect(await s.ready()).toBe(true);
  });

  it("a key without the read scope doesn't hold: waiting can't change the answer", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = noReadScope;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.names).toEqual(["vault-key"]);

    await s.refresh();
    expect(log.filter((l) => l.includes("can't read the vault"))).toHaveLength(1);
  });

  it("a secret that doesn't decrypt with this vault key doesn't hold", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value" });
    vault.getErrors.B = wrongKey;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] bravo-value");
    expect(log.filter((l) => l.includes("1 secret(s) don't decrypt"))).toHaveLength(1);

    // Said once, not on every read.
    await s.refresh();
    expect(log.filter((l) => l.includes("don't decrypt"))).toHaveLength(1);
  });

  it("a secret the server fails to return keeps the value already known for it", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();

    vault.getErrors.B = unavailable;
    await s.refresh(); // the periodic re-read
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(await s.ready()).toBe(true); // the set read in full still stands
  });

  it("a secret the server fails to return on the first read holds, and the rest are scrubbed meanwhile", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value", C: "charlie-value" });
    vault.getErrors.B = unavailable;
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(s.scrub("alpha-value charlie-value").text).toBe("[VAULT:A] [VAULT:C]");

    delete vault.getErrors.B;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(s.scrub("bravo-value").text).toBe("[VAULT:B]");
  });

  it("a new secret the re-read can't fetch holds, though the rest were read before", async () => {
    const vault = new FakeVault({ A: "alpha-value" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();

    vault.secrets.B = "bravo-value"; // `engram vault set B`
    vault.getErrors.B = unavailable;
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(s.scrub("alpha-value").text).toBe("[VAULT:A]");
  });

  it("after a request that got no answer, the rest aren't requested, and keep their known values", async () => {
    const secrets = { A: "alpha-value", B: "bravo-value", C: "charlie-value" };
    const s = new SecretScrubber(new FakeVault(secrets), KEY);
    await s.refresh();

    // A replaced key; its first read times out on the first secret.
    const next = new FakeVault(secrets);
    next.getErrors.A = timedOut;
    await s.reconnect(next);
    expect(next.gets).toEqual(["A"]);
    expect(s.scrub("alpha-value bravo-value charlie-value").text).toBe(
      "[VAULT:A] [VAULT:B] [VAULT:C]",
    );
    expect(await s.ready()).toBe(false);
  });

  it("a list that fails keeps every secret already known", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();

    const next = new FakeVault({});
    next.listError = unavailable;
    await s.reconnect(next);
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(await s.ready()).toBe(false);
  });

  it("a periodic re-read that fails leaves a complete set complete", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    for (const fail of [unavailable, offline]) {
      vault.listError = fail;
      await s.refresh();
      expect(await s.ready(), fail.name).toBe(true);
      expect(s.scrub("4821").text).toBe("[VAULT:PIN]");
    }
  });

  it("a secret the server refuses to return doesn't hold", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value" });
    vault.getErrors.B = noReadScope;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] bravo-value");
    expect(log.filter((l) => l.includes("can't read the vault"))).toHaveLength(1);
  });

  it("a read through a replaced client that breaks late changes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const old: VaultLike = {
      async list() {
        await gate;
        return {} as Array<{ name: string }>; // not iterable: the read throws
      },
      async get() {
        return null;
      },
    };
    const s = new SecretScrubber(old, KEY);
    const reading = s.refresh();
    await s.reconnect(new FakeVault({ PIN: "4821" }));
    expect(await s.ready()).toBe(true);
    release();
    await reading;
    expect(await s.ready()).toBe(true);
  });

  it("a replaced key isn't ready until a read through it lands", async () => {
    const s = new SecretScrubber(new FakeVault({ OLD: "old-secret" }), KEY);
    await s.refresh();
    expect(await s.ready()).toBe(true);

    const next = new FakeVault({ NEW: "new-secret" });
    next.hold();
    void s.reconnect(next);
    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(ready).toBeUndefined();

    next.release();
    await settle();
    expect(ready).toBe(true);
    expect(s.scrub("new-secret").text).toBe("[VAULT:NEW]");
  });

  it("doesn't wait on the periodic re-read once the set is complete", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    vault.hold();
    void s.refresh();
    expect(await s.ready()).toBe(true); // resolves while the re-read is held
    vault.release();
  });

  it("a stopped scrubber is never ready, and a read that lands after stop keeps nothing", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const s = new SecretScrubber(vault, KEY);
    const reading = s.refresh();
    s.stop();
    vault.release();
    await reading;
    expect(s.names).toEqual([]);
    expect(await s.ready()).toBe(false);
    await s.refresh();
    expect(vault.lists).toBe(1);
  });

  it("a reply that isn't JSON is retried like a server error, not taken for a wrong key", async () => {
    const notJson = () => new SyntaxError(`Unexpected token 'R', "Rate limited" is not valid JSON`);
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = notJson;
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, (m) => log.push(m));
    await s.refresh();
    expect(await s.ready()).toBe(false);

    vault.listError = null;
    vault.getErrors.PIN = notJson;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(log.some((l) => l.includes("don't decrypt"))).toBe(false);

    delete vault.getErrors.PIN;
    later(READ_RETRY_MS[1]);
    expect(await s.ready()).toBe(true);
  });

  it("a read that breaks on its own holds, and is retried on the schedule rather than every flush", async () => {
    let lists = 0;
    const broken: VaultLike = {
      async list() {
        lists++;
        return {} as Array<{ name: string }>; // not iterable
      },
      async get() {
        return null;
      },
    };
    const s = new SecretScrubber(broken, KEY);
    await s.refresh();
    expect(await s.ready()).toBe(false);
    later(2_000);
    expect(await s.ready()).toBe(false);
    expect(lists).toBe(1);
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(lists).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The syncer: the hold and the second scrub, against a real daemon.db.

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  creates = 0;
  sends: StoreParams[] = [];
  createError: (() => unknown) | null = null;
  private seq = 0;

  client(): Engram {
    return {
      createConversation: async () => {
        this.creates++;
        if (this.createError) throw this.createError();
        return { conversationId: `conv_${++this.seq}` };
      },
      store: async (p: StoreParams) => {
        this.sends.push(p);
        return { stored: p.messages.length };
      },
      deleteConversation: async () => {},
    } as unknown as Engram;
  }

  /** Every message the server received, in order. */
  get received(): string[] {
    return this.sends.flatMap((p) => p.messages.map((m) => m.content));
  }
}

describe("nothing is sent before the vault has been read (engram#588)", () => {
  let dir: string;
  let db: DaemonDb;
  let server: FakeServer;

  const meta = (sessionId: string): SessionMeta => ({
    sessionId,
    projectDir: "myproj",
    cwd: "/work/myproj",
    host: "claude-code",
  });
  const msgs = (...contents: string[]): ParsedMessage[] =>
    contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

  /** Every row in daemon.db, sent or not. */
  const queued = (): string[] => {
    const raw = new Database(join(dir, "daemon.db"), { readonly: true });
    try {
      const rows = raw.prepare("SELECT content FROM pending_messages ORDER BY id").all();
      return (rows as Array<{ content: string }>).map((r) => r.content);
    } finally {
      raw.close();
    }
  };
  const failures = () => vi.mocked(recordFailure).mock.calls;
  const errorsLogged = (text: string) =>
    vi.mocked(console.error).mock.calls.filter((c) => String(c[0]).includes(text)).length;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engram-scrub-send-"));
    db = new DaemonDb(join(dir, "daemon.db"));
    server = new FakeServer();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordSuccess).mockClear();
    vi.mocked(recordFailure).mockClear();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a message queued before the first read lands is scrubbed before it's sent, and in the queue", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const scrubber = new SecretScrubber(vault, KEY);
    void scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);

    // The watcher's first scan, before the read lands.
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", `key ${KEY}`));
    expect(queued()).toEqual(["the PIN is 4821", "key [VAULT:vault-key]"]);

    const flushing = syncer.flush();
    await settle();
    expect(server.creates).toBe(1); // a create carries no content: it doesn't wait
    expect(server.sends).toHaveLength(0);

    vault.release();
    await flushing;
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]", "key [VAULT:vault-key]"]);
    expect(queued()).toEqual(["the PIN is [VAULT:PIN]", "key [VAULT:vault-key]"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("while the vault won't read, creates go through and sends wait; the first read that lands releases them", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(server.creates).toBe(1);
    expect(server.sends).toHaveLength(0);
    expect(failures().at(-1)?.[0]).toMatch(/^holding messages until the vault is read/);
    expect(failures().at(-1)?.[1]).toBe("server");
    expect(recordSuccess).not.toHaveBeenCalled();

    // The 2 s flush loop: the hold keeps, and says so once.
    for (let i = 0; i < 4; i++) {
      later(2_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(errorsLogged("holding queued messages until the vault is read")).toBe(1);

    vault.listError = null;
    later(READ_RETRY_MS[0]);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);

    // Said once, when the hold ends — not on every flush after.
    await syncer.onMessages("s1", meta("s1"), msgs("next"));
    later(2_000);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]", "next"]);
    const said = vi.mocked(console.log).mock.calls.filter((c) => String(c[0]).includes("vault read"));
    expect(said).toHaveLength(1);
  });

  it("a vault read refused with a bare 402 holds as a server failure, not a plan limit", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = () => new EngramError("", "undefined", 402);
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(server.sends).toHaveLength(0);
    expect(failures().at(-1)?.[1]).toBe("server");
  });

  it("a hold for the vault doesn't overwrite the memory-full status a create just recorded", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush(); // created; the send waits for the vault

    server.createError = () =>
      new EngramError(
        JSON.stringify({ error: "storage_full", message: "Memory full", used: 10000, limit: 10000 }),
        "undefined",
        402,
      );
    await syncer.onMessages("s2", meta("s2"), msgs("more"));
    later(2_000);
    await syncer.flush();
    expect(failures().at(-1)?.[1]).toBe("storage_full");
    expect(server.sends).toHaveLength(0);
  });

  it("a vault that keeps failing holds sends 15 minutes at most, then they go with what's known", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = busy;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", `key ${KEY}`));
    await syncer.flush();
    later(MAX_SERVER_HOLD_MS - 1);
    await syncer.flush();
    expect(server.sends).toHaveLength(0);

    later(1);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is 4821", "key [VAULT:vault-key]"]);
  });

  it("while Engram can't be reached, sends wait for the vault however long it takes", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = offline;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    for (let i = 0; i < 12; i++) {
      later(10 * 60_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(new Set(failures().map((c) => c[1]))).toEqual(new Set(["network"]));

    vault.listError = null;
    later(READ_RETRY_MS[2]);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
  });

  it("a key without the read scope sends at once", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = noReadScope;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is 4821"]);
  });

  it("with nothing to send, a flush doesn't wait on the vault", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const scrubber = new SecretScrubber(vault, KEY);
    void scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.flush(); // resolves while the read is held
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    vault.release();
  });

  it("the vault rejecting the key pauses like a rejected send, and the new key's vault is read before anything is sent", async () => {
    const vaults: Record<string, FakeVault> = {
      "key-old": new FakeVault({}),
      "key-new": new FakeVault({ PIN: "4821" }),
    };
    vaults["key-old"].listError = () => new AuthenticationError();
    vaults["key-new"].hold();

    const scrubber = new SecretScrubber(vaults["key-old"], KEY);
    await scrubber.refresh();
    let configured = "key-old";
    const keys: KeySource = {
      current: { key: "key-old", server: DEFAULT_BASE_URL },
      read: async () => ({ key: configured, server: DEFAULT_BASE_URL }),
      connect: (account) => {
        void scrubber.reconnect(vaults[account.key]);
        return server.client();
      },
      // The new key is a re-issued key of the same account, so what the old
      // one queued is sent with it (engram#594).
      ownedKeys: async (_account, hashes) => hashes,
    };
    const syncer = new Syncer(db, server.client(), scrubber, keys);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(failures().at(-1)?.[1]).toBe("auth");
    expect(server.sends).toHaveLength(0);

    // `engram auth login` saves a new key; the next key check picks it up.
    configured = "key-new";
    later(10_000);
    const flushing = syncer.flush();
    await settle();
    expect(server.sends).toHaveLength(0); // waiting for the new key's vault

    vaults["key-new"].release();
    await flushing;
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
  });

  it("a second scrub of text already scrubbed changes nothing and rewrites nothing", async () => {
    const scrubber = new SecretScrubber(new FakeVault({ PIN: "4821" }), KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    expect(queued()).toEqual(["the PIN is [VAULT:PIN]"]); // scrubbed as it was queued
    const rewrite = vi.spyOn(db, "updateContents");
    await syncer.flush();
    expect(rewrite).not.toHaveBeenCalled();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
    expect(errorsLogged("from queued messages before sending")).toBe(0);
  });

  it("a failed rewrite of the queue doesn't stop the send: what's sent is scrubbed", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const scrubber = new SecretScrubber(vault, KEY);
    void scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));

    vi.spyOn(db, "updateContents").mockImplementation(() => {
      throw new Error("disk I/O error");
    });
    vault.release();
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
    expect(errorsLogged("rewriting scrubbed queued messages failed")).toBe(1);
    expect(errorsLogged("scrubbed 1 vault value occurrence(s) from queued messages")).toBe(1);
  });

  it("without a vault key nothing waits", async () => {
    const syncer = new Syncer(db, server.client(), null);
    await syncer.onMessages("s1", meta("s1"), msgs("hello"));
    await syncer.flush();
    expect(server.received).toEqual(["hello"]);
  });
});
