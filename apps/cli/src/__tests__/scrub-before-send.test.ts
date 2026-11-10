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
  MISMATCH_RETRY_MS,
  FULL_READ_MS,
  SAME_LIST_MS,
  decryptFailed,
  type Undecryptable,
  type VaultKeySource,
  type VaultLike,
} from "../daemon/scrubber.js";
import { VaultKeyMismatch, VaultKeyUnreadable } from "../vault-key.js";
import { recordFailure, recordNextRetry, recordSuccess } from "../daemon/status.js";
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
  /** When each secret was last saved, as list() says it (engram#694). Unsaid if not set. */
  saved: Record<string, string> = {};
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

  async list(): Promise<Array<{ name: string; updatedAt?: string }>> {
    this.lists++;
    if (this.gate) await this.gate;
    if (this.listError) throw this.listError();
    return Object.keys(this.secrets).map((name) =>
      this.saved[name] === undefined ? { name } : { name, updatedAt: this.saved[name] },
    );
  }

  async get(name: string): Promise<string | null> {
    this.gets.push(name);
    const fail = this.getErrors[name];
    if (fail) throw fail();
    return this.secrets[name] ?? null;
  }
}

/** ~/.engram/vault-key, read again by the scrubber: the test says what a read finds. */
class FakeKeyFile implements VaultKeySource {
  reads = 0;
  /** The key each vault was made with. */
  keys: string[] = [];
  /** A key, nothing (no file), or a throw (a file that can't be read). */
  finds: () => string | undefined = () => {
    throw folder();
  };
  vaultError: (() => unknown) | null = null;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  constructor(public vault: VaultLike | null) {}

  /** Hold every read() until release(). */
  hold(): void {
    this.gate = new Promise((r) => (this.open = r));
  }

  release(): void {
    this.open?.();
    this.gate = null;
  }

  async read(): Promise<string | undefined> {
    this.reads++;
    if (this.gate) await this.gate;
    return this.finds();
  }

  vaultWith(key: string): VaultLike | null {
    this.keys.push(key);
    if (this.vaultError) throw this.vaultError();
    return this.vault;
  }
}

const folder = () => new VaultKeyUnreadable("is a folder, not a file", "folder");

/** A scrubber whose key couldn't be read at start, as worker-main makes it (engram#677). */
const keyPending = (source: VaultKeySource, log?: (msg: string) => void) =>
  new SecretScrubber(null, undefined, log, { problem: folder(), source });

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

// engram#677: a vault key that was there but couldn't be read counted as no
// key, and captures went out with the vault's secrets in them. Now sends
// wait until the key reads, and then for the vault read through it.
describe("a vault key that can't be read holds sends until it can be (engram#677)", () => {
  it("holds for as long as it lasts: no bound releases it", async () => {
    const source = new FakeKeyFile(new FakeVault({ PIN: "4821" }));
    const s = keyPending(source);
    await s.refresh(); // as start() does: there is no vault to read yet
    expect(s.active).toBe(false);
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyUnreadable);
    const start = Date.now();
    for (let i = 0; i < 120; i++) {
      later(60_000);
      expect(await s.ready()).toBe(false);
    }
    // Eight times the 15 minutes a failing server gets.
    expect(Date.now() - start).toBe(8 * MAX_SERVER_HOLD_MS);
    expect(s.failure).toBeInstanceOf(VaultKeyUnreadable);
    expect(source.reads).toBe(120);
    expect(source.keys).toEqual([]);
  });

  it("reads the key again in 10 s, 30 s, then every minute, not on every flush", async () => {
    const source = new FakeKeyFile(null);
    const s = keyPending(source);
    // It was read just now, at start.
    expect(await s.ready()).toBe(false);
    expect(source.reads).toBe(0);
    const readsAfter = async (ms: number) => {
      later(ms);
      expect(await s.ready()).toBe(false);
      return source.reads;
    };
    expect(await readsAfter(READ_RETRY_MS[0] - 1)).toBe(0);
    expect(await readsAfter(1)).toBe(1); // 10 s
    expect(await readsAfter(2_000)).toBe(1); // the next flush
    expect(await readsAfter(READ_RETRY_MS[1] - 2_001)).toBe(1);
    expect(await readsAfter(1)).toBe(2); // 30 s
    expect(await readsAfter(READ_RETRY_MS[2] - 1)).toBe(2);
    expect(await readsAfter(1)).toBe(3); // 1 min
    expect(await readsAfter(READ_RETRY_MS[2])).toBe(4); // still 1 min
  });

  it("reads the key once at a time", async () => {
    const source = new FakeKeyFile(null);
    source.hold();
    const s = keyPending(source);
    later(READ_RETRY_MS[0]);
    const first = s.ready();
    const second = s.ready();
    await settle();
    expect(source.reads).toBe(1);
    source.release();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(source.reads).toBe(1);
  });

  it("once the key reads: scrubbed from then on, the vault read with it, and sends wait for that read", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const source = new FakeKeyFile(vault);
    const log: string[] = [];
    const s = keyPending(source, (m) => log.push(m));
    await s.refresh();
    source.finds = () => KEY;

    later(READ_RETRY_MS[0]);
    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(source.keys).toEqual([KEY]);
    expect(vault.lists).toBe(1);
    expect(ready).toBeUndefined(); // the read through the key is in flight
    expect(s.failure).toBeUndefined();
    expect(s.scrub(`key=${KEY}`).text).toBe("key=[VAULT:vault-key]");
    expect(log).toEqual([
      "vault scrubber: the vault key can be read now — reading the vault before sending what was held",
    ]);

    vault.release();
    await settle();
    expect(ready).toBe(true);
    expect(s.scrub("the PIN is 4821").text).toBe("the PIN is [VAULT:PIN]");
    expect(vault.lists).toBe(1);
    expect(log.join("\n")).not.toContain(KEY);
  });

  it("then a vault that fails to read holds as any vault read does", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = busy;
    const source = new FakeKeyFile(vault);
    const s = keyPending(source);
    await s.refresh();
    source.finds = () => KEY;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(EngramError);
    // A server that answers with errors: 15 minutes at most, as with a key
    // that read at start, and the key itself is scrubbed meanwhile.
    later(MAX_SERVER_HOLD_MS);
    expect(await s.ready()).toBe(true);
    expect(s.names).toEqual(["vault-key"]);
  });

  it("a key file gone meanwhile holds still: it may be being put back", async () => {
    const source = new FakeKeyFile(new FakeVault({}));
    const log: string[] = [];
    const s = keyPending(source, (m) => log.push(m));
    source.finds = () => undefined;
    for (let i = 0; i < 10; i++) {
      later(READ_RETRY_MS[2]);
      expect(await s.ready()).toBe(false);
    }
    expect(source.reads).toBe(10);
    const gone = s.failure as InstanceType<typeof VaultKeyUnreadable>;
    expect(gone).toBeInstanceOf(VaultKeyUnreadable);
    expect(gone.kind).toBe("gone");
    expect(gone.message).toBe("~/.engram/vault-key isn't there any more");
    // Said when it changes, not on every read.
    expect(log).toEqual(["vault scrubber: still holding sends — ~/.engram/vault-key isn't there any more"]);

    source.finds = () => {
      throw new VaultKeyUnreadable("can't be read: permission denied", "permission");
    };
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(false);
    expect(log.at(-1)).toBe("vault scrubber: still holding sends — ~/.engram/vault-key can't be read: permission denied");

    source.finds = () => KEY;
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(true);
  });

  it("a key that reads but makes no vault keeps the hold, and is tried again on the schedule", async () => {
    const source = new FakeKeyFile(new FakeVault({ PIN: "4821" }));
    source.finds = () => KEY;
    source.vaultError = () => new Error("no vault");
    const s = keyPending(source);
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyUnreadable);
    expect(s.names).toEqual([]); // nothing kept from a read that didn't finish

    source.vaultError = null;
    later(READ_RETRY_MS[1] - 1);
    expect(await s.ready()).toBe(false);
    expect(source.reads).toBe(1);
    later(1);
    expect(await s.ready()).toBe(true);
    expect(source.keys).toEqual([KEY, KEY]);
    expect(s.scrub("4821").text).toBe("[VAULT:PIN]");
  });

  it("a log that throws as the hold lifts: lifted whole, and ready() doesn't throw", async () => {
    const source = new FakeKeyFile(new FakeVault({ PIN: "4821" }));
    source.finds = () => KEY;
    const s = keyPending(source, (m) => {
      if (m.includes("can be read now")) throw new Error("log broke");
    });
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(s.scrub(`4821 ${KEY}`).text).toBe("[VAULT:PIN] [VAULT:vault-key]");
  });

  it("stopped while the key is read: keeps nothing, and makes no vault", async () => {
    const source = new FakeKeyFile(new FakeVault({ PIN: "4821" }));
    source.finds = () => KEY;
    source.hold();
    const s = keyPending(source);
    later(READ_RETRY_MS[0]);
    const ready = s.ready();
    await settle();
    s.stop();
    source.release();
    expect(await ready).toBe(false);
    expect(source.keys).toEqual([]);
    expect(s.names).toEqual([]);
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(false);
    expect(source.reads).toBe(1);
  });

  it("a new API key meanwhile doesn't lift the hold", async () => {
    const source = new FakeKeyFile(null);
    const s = keyPending(source);
    // Even a vault that reads in full: there is no key to scrub its values with.
    await s.reconnect(new FakeVault({}));
    expect(await s.ready()).toBe(false);
    await s.reconnect(null);
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyUnreadable);
    // The key is still read on its schedule.
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(source.reads).toBe(1);
  });
});

/** Two vault keys, as `engram vault keygen` makes them: 32 bytes, base64, padded. */
const KEY_A = Buffer.alloc(32, 7).toString("base64");
const KEY_B = Buffer.alloc(32, 9).toString("base64");

/** A scrubber as worker-main makes it (engram#693): the key read at start, or none, and a source to read it again. */
const reading = (source: FakeKeyFile, vault: VaultLike | null, key: string | undefined, log?: (msg: string) => void) =>
  new SecretScrubber(vault, key, log, { source });

/** What the scrubber says about the key: not the count of secrets each read finds. */
const keyLog =
  (into: string[]) =>
  (m: string): void => {
    if (!m.startsWith("vault scrubber: protecting ")) into.push(m);
  };

describe("the vault key is read again while the daemon runs (engram#693)", () => {
  it("no key at start, then one saved: the vault is read with it, and the next send waits for that read", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const source = new FakeKeyFile(vault);
    source.finds = () => undefined;
    const log: string[] = [];
    const s = reading(source, null, undefined, keyLog(log));
    await s.refresh(); // as start() does: no vault yet
    // No key: nothing to wait for. The file is read before each send.
    for (let i = 0; i < 3; i++) {
      later(2_000);
      expect(await s.ready()).toBe(true);
    }
    expect(source.reads).toBe(3);
    expect(s.active).toBe(false);
    expect(log).toEqual([]);

    source.finds = () => `${KEY_A}\n`;
    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(source.keys).toEqual([KEY_A]);
    expect(vault.lists).toBe(1);
    expect(ready).toBeUndefined(); // the read through the key is in flight
    // The key is scrubbed from then on, before the read lands.
    expect(s.scrub(`key=${KEY_A}`).text).toBe("key=[VAULT:vault-key]");
    expect(log).toEqual(["vault scrubber: on — a vault key was saved; reading the vault with it before sending"]);

    vault.release();
    await settle();
    expect(ready).toBe(true);
    expect(s.scrub("the PIN is 4821").text).toBe("the PIN is [VAULT:PIN]");
    // The same key at the next send: nothing more to read.
    expect(await s.ready()).toBe(true);
    expect(source.keys).toEqual([KEY_A]);
    expect(vault.lists).toBe(1);
    expect(log.join("\n")).not.toContain(KEY_A);
  });

  it("another key in its place: the vault is read through it before the next send, and the key it replaced is still scrubbed", async () => {
    const before = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(null);
    source.finds = () => KEY_A;
    const log: string[] = [];
    const s = reading(source, before, KEY_A, keyLog(log));
    await s.refresh();
    expect(await s.ready()).toBe(true);

    // The same vault, read with another key: the PIN was encrypted with the
    // first, and a secret saved since with this one.
    const after = new FakeVault({ PIN: "not this", PASSPHRASE: "correct horse" });
    after.getErrors.PIN = wrongKey;
    after.hold();
    source.vault = after;
    source.finds = () => KEY_B;
    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(source.keys).toEqual([KEY_B]);
    expect(ready).toBeUndefined(); // waits for the read through the new key
    expect(s.scrub(`${KEY_A} ${KEY_B}`).text).toBe("[VAULT:vault-key] [VAULT:vault-key]");
    expect(log).toEqual([
      "vault scrubber: the vault key was replaced — reading the vault with the new one before sending " +
        "(the one it replaced is still scrubbed)",
    ]);

    after.release();
    await settle();
    expect(ready).toBe(true);
    // The PIN, which the new key can't decrypt, keeps the value read with the old one.
    const r = s.scrub(`${KEY_A} 4821 ${KEY_B} correct horse`);
    expect(r.text).toBe("[VAULT:vault-key] [VAULT:PIN] [VAULT:vault-key] [VAULT:PASSPHRASE]");
    expect(r.replaced).toEqual(
      expect.arrayContaining([
        { name: "vault-key", count: 2 },
        { name: "PIN", count: 1 },
        { name: "PASSPHRASE", count: 1 },
      ]),
    );
    expect(r.replaced).toHaveLength(3);
    // And still, once the interval reads the vault again.
    await s.refresh();
    expect(s.scrub(`${KEY_A} 4821`).text).toBe("[VAULT:vault-key] [VAULT:PIN]");
    for (const key of [KEY_A, KEY_B]) expect(log.join("\n")).not.toContain(key);
  });

  it("the same key written another way: no new read, and that way is scrubbed too", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    const log: string[] = [];
    const s = reading(source, vault, KEY_A, keyLog(log));
    await s.refresh();
    // Without its padding, and broken over two lines: the bytes are the same.
    const unpadded = KEY_A.replace(/=+$/, "");
    const split = `${KEY_A.slice(0, 22)}\n${KEY_A.slice(22)}`;
    for (const written of [unpadded, `  ${KEY_A}\n`, split]) {
      source.finds = () => written;
      later(2_000);
      expect(await s.ready(), JSON.stringify(written)).toBe(true);
    }
    expect(source.reads).toBe(3);
    expect(source.keys).toEqual([]);
    expect(vault.lists).toBe(1);
    expect(log).toEqual([]);
    expect(s.scrub(`[${split}]`).text).toBe("[[VAULT:vault-key]]");
  });

  it("each way a vault key may be written is scrubbed whole: padded and not, counted as one", () => {
    const unpadded = KEY_A.replace(/=+$/, "");
    expect(unpadded).not.toBe(KEY_A);
    // Given without its padding, as the CLI and the SDK take it.
    for (const given of [unpadded, KEY_A]) {
      const s = new SecretScrubber(null, given);
      const r = s.scrub(`a ${KEY_A} b ${unpadded} c`);
      expect(r.text, given).toBe("a [VAULT:vault-key] b [VAULT:vault-key] c");
      expect(r.replaced).toEqual([{ name: "vault-key", count: 2 }]);
    }
    // A key that isn't base64 is scrubbed as it is written.
    expect(new SecretScrubber(null, KEY).scrub(`${KEY}=`).text).toBe("[VAULT:vault-key]=");
  });

  it("stopped: the key goes with the secrets, each way it is written; started again, it is scrubbed again", () => {
    const unpadded = KEY_A.replace(/=+$/, "");
    const s = new SecretScrubber(new FakeVault({ PIN: "4821" }), KEY_A);
    s.start();
    s.stop();
    // No plaintext held once stopped: not the key, nor any spelling of it.
    expect(s.active).toBe(false);
    expect(s.scrub(`a ${KEY_A} b ${unpadded}`).replaced).toEqual([]);
    s.start();
    try {
      // Known again before any read, each way it may be written.
      expect(s.scrub(`a ${KEY_A} b ${unpadded}`).text).toBe("a [VAULT:vault-key] b [VAULT:vault-key]");
    } finally {
      s.stop();
    }
  });

  it("the key file gone while its key is in use: still scrubbing with it and the secrets read with it, said once", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    const log: string[] = [];
    const s = reading(source, vault, KEY_A, keyLog(log));
    await s.refresh();
    source.finds = () => undefined;
    for (let i = 0; i < 5; i++) {
      later(2_000);
      expect(await s.ready()).toBe(true);
    }
    expect(s.failure).toBeUndefined();
    const gone =
      "vault scrubber: ~/.engram/vault-key isn't there any more — still scrubbing with the key read before, " +
      "and the secrets read with it. A restart starts without a key.";
    expect(log).toEqual([gone]);
    // The interval reads the vault with it still.
    await s.refresh();
    expect(vault.lists).toBe(2);
    expect(s.scrub(`${KEY_A} 4821`).text).toBe("[VAULT:vault-key] [VAULT:PIN]");

    // Put back: nothing more to read or say. Gone again: said again.
    source.finds = () => KEY_A;
    expect(await s.ready()).toBe(true);
    source.finds = () => undefined;
    expect(await s.ready()).toBe(true);
    expect(source.keys).toEqual([]);
    expect(log).toEqual([gone, gone]);
  });

  it("a key file that can't be read any more holds sends; the same key back lifts the hold without a new read", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    source.finds = () => KEY_A;
    const log: string[] = [];
    const s = reading(source, vault, KEY_A, keyLog(log));
    await s.refresh();
    expect(await s.ready()).toBe(true);

    source.finds = () => {
      throw new VaultKeyUnreadable("can't be read: permission denied", "permission");
    };
    expect(await s.ready()).toBe(false);
    expect(s.failure).toMatchObject({ name: "VaultKeyUnreadable", kind: "permission" });
    expect(log).toEqual([
      "vault scrubber: holding sends — ~/.engram/vault-key can't be read: permission denied. Capture goes on, " +
        "and what it captures is sent once the key can be read.",
    ]);
    // What it knows is still scrubbed, and the file is read again on the
    // schedule, not on every flush.
    expect(s.scrub(`${KEY_A} 4821`).text).toBe("[VAULT:vault-key] [VAULT:PIN]");
    later(2_000);
    expect(await s.ready()).toBe(false);
    expect(source.reads).toBe(2);

    source.finds = () => KEY_A;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(source.reads).toBe(3);
    expect(source.keys).toEqual([]); // the vault read with it stands
    expect(vault.lists).toBe(1);
    expect(log.at(-1)).toBe("vault scrubber: the vault key can be read again — sending what was held");
  });

  it("a key file that can't be read any more, then another key in it: the vault is read with that one before sending what was held", async () => {
    const before = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(null);
    source.finds = () => {
      throw new VaultKeyUnreadable("is empty", "empty");
    };
    const log: string[] = [];
    const s = reading(source, before, KEY_A, keyLog(log));
    await s.refresh();
    expect(await s.ready()).toBe(false);

    const after = new FakeVault({ PIN: "4821", PASSPHRASE: "correct horse" });
    source.vault = after;
    source.finds = () => KEY_B;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(source.keys).toEqual([KEY_B]);
    expect(after.lists).toBe(1);
    expect(s.scrub(`${KEY_A} ${KEY_B} correct horse`).text).toBe("[VAULT:vault-key] [VAULT:vault-key] [VAULT:PASSPHRASE]");
    expect(log.at(-1)).toBe(
      "vault scrubber: the vault key can be read now, and it is another key — reading the vault with it " +
        "before sending what was held",
    );
  });

  it("a key that makes no vault, in place of the one in use: sends wait, and it is tried again on the schedule", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    source.finds = () => KEY_B;
    source.vaultError = () => new Error("no vault");
    const s = reading(source, vault, KEY_A);
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyUnreadable);
    expect(s.scrub("4821").text).toBe("[VAULT:PIN]");

    source.vaultError = null;
    later(READ_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(source.keys).toEqual([KEY_B, KEY_B]);
  });

  it("the interval reads the key too, then the vault through a new one, once", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    source.finds = () => undefined;
    const s = reading(source, null, undefined);
    s.start(60_000);
    await settle();
    // worker-main read it just before: start() reads the vault, not the key.
    expect(source.reads).toBe(0);

    source.finds = () => KEY_A;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(source.reads).toBe(1);
    expect(source.keys).toEqual([KEY_A]);
    expect(vault.lists).toBe(1); // through the new client, and not again
    expect(s.scrub(`${KEY_A} 4821`).text).toBe("[VAULT:vault-key] [VAULT:PIN]");

    // The next: the same key, and the vault read again.
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(source.reads).toBe(2);
    expect(vault.lists).toBe(2);
    s.stop();
    expect(s.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The syncer: the hold and the second scrub, against a real daemon.db.

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

class FakeServer {
  creates = 0;
  sends: StoreParams[] = [];
  createError: (() => unknown) | null = null;
  /** Runs while a send is in flight, before the server answers it. */
  onStore: (() => Promise<void>) | null = null;
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
        await this.onStore?.();
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

/** A vault whose every secret was saved with another vault key (engram#694). */
const foreign = (secrets: Record<string, string>): FakeVault => {
  const vault = new FakeVault(secrets);
  for (const name of Object.keys(secrets)) vault.getErrors[name] = wrongKey;
  return vault;
};

const HOLDING_2 =
  "vault scrubber: holding sends — the vault key doesn't decrypt any of the vault's 2 secrets, so they " +
  "can't be scrubbed. Capture goes on, and what it captures is sent once the secrets decrypt, or are " +
  "deleted. See 'engram status'.";

const REPLACED =
  "vault scrubber: the vault key was replaced — reading the vault with the new one before sending " +
  "(the one it replaced is still scrubbed)";

describe("a vault key that decrypts none of the vault's secrets holds sends (engram#694)", () => {
  it("holds for as long as it lasts: no bound releases it, nor do server errors meanwhile", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log));
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect((s.failure as VaultKeyMismatch).secrets).toBe(2);
    expect(log).toEqual([HOLDING_2]);

    // Two hours: still holding, and said once.
    for (let i = 0; i < 120; i++) {
      later(60_000);
      expect(await s.ready()).toBe(false);
    }
    // Server errors meanwhile don't start the 15 minutes that release a
    // hold: what was found of the key stands until a read finds otherwise.
    vault.listError = busy;
    for (let i = 0; i < 30; i++) {
      later(60_000);
      expect(await s.ready()).toBe(false);
    }
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect(log.filter((l) => l.includes("holding sends"))).toEqual([HOLDING_2]);
    expect(log.join("\n")).not.toContain("failed to read for 15 minutes");
    // Nothing to scrub them with: why it holds.
    expect(s.scrub("alpha-value bravo-value").text).toBe("alpha-value bravo-value");
    expect(log.join("\n")).not.toMatch(/alpha-value|bravo-value/);
  });

  it("lists the vault again in 10 s, 30 s, 1 min, 2 min, then every 5 min; each secret is read again every 10 min", async () => {
    // Each secret read writes an audit row: a list that is the same reads
    // none of them again, until 10 minutes have passed.
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(vault.gets).toEqual(["A", "B"]);

    const after = async (ms: number) => {
      later(ms);
      expect(await s.ready()).toBe(false);
      return [vault.lists, vault.gets.length];
    };
    expect(await after(MISMATCH_RETRY_MS[0] - 1)).toEqual([1, 2]);
    expect(await after(1)).toEqual([2, 2]); // 10 s
    expect(await after(MISMATCH_RETRY_MS[1] - 1)).toEqual([2, 2]);
    expect(await after(1)).toEqual([3, 2]); // 30 s
    expect(await after(MISMATCH_RETRY_MS[2] - 1)).toEqual([3, 2]);
    expect(await after(1)).toEqual([4, 2]); // 1 min
    expect(await after(MISMATCH_RETRY_MS[3] - 1)).toEqual([4, 2]);
    expect(await after(1)).toEqual([5, 2]); // 2 min
    expect(await after(MISMATCH_RETRY_MS[4])).toEqual([6, 2]); // 5 min: 8 min 40 s on
    expect(await after(MISMATCH_RETRY_MS[4])).toEqual([7, 4]); // 13 min 40 s on: each read again
    expect(await after(MISMATCH_RETRY_MS[4] - 1)).toEqual([7, 4]);
    expect(await after(1)).toEqual([8, 4]); // every 5 min still, and the list is the same
    expect(await after(MISMATCH_RETRY_MS[4])).toEqual([9, 6]); // 10 min since each was read
  });

  it("a secret saved again, added or deleted: each secret is read again at the next list", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log));
    await s.refresh();

    // Saved again elsewhere, with the other key.
    vault.saved.B = "2026-11-08T00:00:05Z";
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect([vault.lists, vault.gets.length]).toEqual([2, 4]);
    expect(log).toEqual([HOLDING_2]); // the same count: nothing new to say

    vault.secrets.C = "charlie-value";
    vault.getErrors.C = wrongKey;
    later(MISMATCH_RETRY_MS[1]);
    expect(await s.ready()).toBe(false);
    expect([vault.lists, vault.gets.length]).toEqual([3, 7]);
    expect((s.failure as VaultKeyMismatch).secrets).toBe(3);

    delete vault.secrets.A;
    delete vault.secrets.C;
    later(MISMATCH_RETRY_MS[2]);
    expect(await s.ready()).toBe(false);
    expect([vault.lists, vault.gets.length]).toEqual([4, 8]);
    expect(log.slice(1)).toEqual([
      "vault scrubber: still holding sends — the vault key doesn't decrypt any of the vault's 3 secrets",
      "vault scrubber: still holding sends — the vault key doesn't decrypt the vault's secret",
    ]);
  });

  it("lifts once the secrets it can't decrypt are deleted", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log));
    await s.refresh();

    delete vault.secrets.A;
    delete vault.secrets.B;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(log).toEqual([
      HOLDING_2,
      "vault scrubber: the vault holds no secret now that can't be scrubbed — sending what was held",
    ]);
    // Settled: the next send doesn't read the vault again.
    const lists = vault.lists;
    later(2_000);
    expect(await s.ready()).toBe(true);
    expect(vault.lists).toBe(lists);
  });

  it("saved again with this key one at a time: held until the last, then what was held goes", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const found: Undecryptable[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log), undefined, (f) => found.push(f));
    await s.refresh();
    expect(found).toEqual([{ secrets: 2, unscrubbed: 2, decrypted: 0, held: true }]);

    // A saved again: it decrypts, and B still doesn't. What waits would go
    // with B in it, so it waits still.
    delete vault.getErrors.A;
    vault.saved.A = "2026-11-08T00:00:05Z";
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect(s.failure).toMatchObject({ secrets: 1, decrypted: 1 });
    // A is scrubbed meanwhile; B can't be.
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] bravo-value");
    expect(log).toEqual([
      HOLDING_2,
      "vault scrubber: still holding sends — the vault key doesn't decrypt 1 of the vault's 2 secrets",
    ]);
    expect(found.at(-1)).toEqual({ secrets: 1, unscrubbed: 1, decrypted: 1, held: true });

    // However long B goes unsaved: no bound releases it, and it is said once.
    for (let i = 0; i < 30; i++) {
      later(60_000);
      expect(await s.ready()).toBe(false);
    }
    expect(log).toHaveLength(2);

    // Then B: none is left that can't be scrubbed.
    delete vault.getErrors.B;
    vault.saved.B = "2026-11-08T00:31:00Z";
    later(MISMATCH_RETRY_MS[4]);
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(log.slice(2)).toEqual([
      "vault scrubber: the vault key decrypts the vault's secrets now — sending what was held",
    ]);
    expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 2, held: false });
  });

  it("one saved again with this key, the other deleted: what was held goes", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log));
    await s.refresh();
    delete vault.getErrors.A;
    vault.saved.A = "2026-11-08T00:00:05Z";
    delete vault.secrets.B;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(log.slice(1)).toEqual([
      "vault scrubber: the vault key decrypts the vault's secrets now — sending what was held",
    ]);
  });

  it("another vault key saved: the vault is read with it before the next send, which goes once it decrypts", async () => {
    const source = new FakeKeyFile(null);
    source.finds = () => KEY_A;
    const log: string[] = [];
    const s = reading(source, foreign({ A: "alpha-value", B: "bravo-value" }), KEY_A, keyLog(log));
    await s.refresh();
    expect(await s.ready()).toBe(false);

    // The same vault, read with the key its secrets were saved with.
    const after = new FakeVault({ A: "alpha-value", B: "bravo-value" });
    after.hold();
    source.vault = after;
    source.finds = () => KEY_B;
    let ready: boolean | undefined;
    void s.ready().then((r) => (ready = r));
    await settle();
    expect(source.keys).toEqual([KEY_B]);
    expect(ready).toBeUndefined();
    // Until the read with it says otherwise.
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);

    after.release();
    await settle();
    expect(ready).toBe(true);
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(log).toEqual([
      HOLDING_2,
      REPLACED,
      "vault scrubber: the vault key decrypts the vault's secrets now — sending what was held",
    ]);
  });

  it("another vault key that decrypts none of them either: each is read with it, and the hold is said again", async () => {
    const source = new FakeKeyFile(foreign({ A: "alpha-value", B: "bravo-value" }));
    source.finds = () => KEY_A;
    const log: string[] = [];
    const s = reading(source, foreign({ A: "alpha-value", B: "bravo-value" }), KEY_A, keyLog(log));
    await s.refresh();

    source.finds = () => KEY_B;
    later(2_000);
    expect(await s.ready()).toBe(false);
    expect(source.keys).toEqual([KEY_B]);
    expect(log).toEqual([
      HOLDING_2,
      REPLACED,
      "vault scrubber: still holding sends — the vault key doesn't decrypt any of the vault's 2 secrets",
    ]);
    // Listed again on the schedule from the start.
    const lists = (source.vault as FakeVault).lists;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect((source.vault as FakeVault).lists).toBe(lists + 1);
  });

  it("lifts when the API key can't read the vault any more: waiting can't change that", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const log: string[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log));
    await s.refresh();

    vault.listError = noReadScope;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
    expect(log.slice(1)).toEqual([
      "vault scrubber: this API key can't read the vault now — sending what was held",
      expect.stringMatching(/^vault scrubber: this API key can't read the vault — scrubbing only the 1 secret\(s\)/),
    ]);
  });

  it("a key that decrypts some of the secrets doesn't hold, and says how many it can't scrub", async () => {
    const vault = new FakeVault({ A: "alpha-value", B: "bravo-value", C: "charlie-value" });
    vault.getErrors.B = wrongKey;
    vault.getErrors.C = wrongKey;
    const log: string[] = [];
    const found: Undecryptable[] = [];
    const s = new SecretScrubber(vault, KEY, keyLog(log), undefined, (f) => found.push(f));
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(log).toEqual(["vault scrubber: 2 secret(s) don't decrypt with this vault key, so they can't be scrubbed"]);
    expect(found).toEqual([{ secrets: 2, unscrubbed: 2, decrypted: 1, held: false }]);

    // Every read reports, and the log says it again only when it changes.
    await s.refresh();
    expect(found).toEqual([
      { secrets: 2, unscrubbed: 2, decrypted: 1, held: false },
      { secrets: 2, unscrubbed: 2, decrypted: 1, held: false },
    ]);
    delete vault.secrets.C;
    await s.refresh();
    expect(log.at(-1)).toBe("vault scrubber: 1 secret(s) don't decrypt with this vault key, so they can't be scrubbed");
    expect(found.at(-1)).toEqual({ secrets: 1, unscrubbed: 1, decrypted: 1, held: false });
    // A deleted too, leaving none that decrypts: as with a key that
    // decrypts none of them from the start, sends wait.
    delete vault.secrets.A;
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect(found.at(-1)).toEqual({ secrets: 1, unscrubbed: 1, decrypted: 0, held: true });
  });

  it("a key replaced while the daemon runs: secrets read with the one before are scrubbed with those values, and don't hold", async () => {
    const source = new FakeKeyFile(null);
    source.finds = () => KEY_A;
    const log: string[] = [];
    const found: Undecryptable[] = [];
    const s = new SecretScrubber(
      new FakeVault({ A: "alpha-value", B: "bravo-value" }),
      KEY_A,
      keyLog(log),
      { source },
      (f) => found.push(f),
    );
    await s.refresh();
    expect(await s.ready()).toBe(true);

    // Another machine's key: nothing in the vault decrypts with it.
    const after = foreign({ A: "alpha-value", B: "bravo-value" });
    source.vault = after;
    source.finds = () => KEY_B;
    later(2_000);
    expect(await s.ready()).toBe(true);
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(log).toEqual([
      REPLACED,
      "vault scrubber: 2 secret(s) don't decrypt with this vault key — scrubbing them with the value " +
        "read before, which a restart won't have",
    ]);
    expect(found.at(-1)).toEqual({ secrets: 2, unscrubbed: 0, decrypted: 0, held: false });

    // Then one is saved again elsewhere, with the key before: its value
    // now isn't known, so it can't be scrubbed.
    after.saved.A = "2026-11-08T00:30:00Z";
    await s.refresh(); // the interval's read
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect(log.at(-1)).toBe(
      "vault scrubber: holding sends — the vault key doesn't decrypt any of the vault's 2 secrets, so they " +
        "can't all be scrubbed. Capture goes on, and what it captures is sent once the secrets decrypt, or " +
        "are deleted. See 'engram status'.",
    );
    expect(found.at(-1)).toEqual({ secrets: 2, unscrubbed: 1, decrypted: 0, held: true });
    // The value read before is scrubbed still.
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");

    // Then A is saved again with this key: it decrypts, and B, which
    // doesn't, is scrubbed with the value read before. None is left that
    // can't be scrubbed, so what was held goes, though the key doesn't
    // decrypt every secret, and the log doesn't say it does (engram#694).
    delete after.getErrors.A;
    after.saved.A = "2026-11-08T00:40:00Z";
    await s.refresh();
    expect(await s.ready()).toBe(true);
    expect(s.failure).toBeUndefined();
    expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
    expect(log.slice(3)).toEqual([
      "vault scrubber: the vault holds no secret now that can't be scrubbed — sending what was held",
      "vault scrubber: 1 secret(s) don't decrypt with this vault key — scrubbing them with the value " +
        "read before, which a restart won't have",
    ]);
    expect(found.at(-1)).toEqual({ secrets: 1, unscrubbed: 0, decrypted: 1, held: false });
  });

  it("a new API key: what was found goes with the old one, and the vault is read through the new one", async () => {
    const log: string[] = [];
    const found: Undecryptable[] = [];
    const s = new SecretScrubber(new FakeVault({ A: "alpha-value" }), KEY, keyLog(log), undefined, (f) =>
      found.push(f),
    );
    await s.refresh();
    expect(found).toEqual([{ secrets: 0, unscrubbed: 0, decrypted: 1, held: false }]);

    // Another account's vault: what decrypted through the account before
    // says nothing of its secrets.
    const other = foreign({ A: "alpha-value" });
    other.hold();
    const read = s.reconnect(other);
    expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 0, held: false });
    other.release();
    await read;
    expect(await s.ready()).toBe(false);
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
    expect(found.at(-1)).toEqual({ secrets: 1, unscrubbed: 1, decrypted: 0, held: true });
    expect(log).toEqual([
      "vault scrubber: holding sends — the vault key doesn't decrypt the vault's secret, so it can't be " +
        "scrubbed. Capture goes on, and what it captures is sent once the secret decrypts, or is deleted. " +
        "See 'engram status'.",
    ]);

    // And another: a hold found through one account goes with it.
    const next = s.reconnect(new FakeVault({ B: "bravo-value" }));
    expect(s.failure).toBeUndefined();
    expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 0, held: false });
    await next;
    expect(await s.ready()).toBe(true);
  });

  it("a read cut short says nothing of what the key decrypts: it neither holds, nor lifts, nor reports", async () => {
    const vault = foreign({ A: "alpha-value", B: "bravo-value" });
    const found: Undecryptable[] = [];
    const s = new SecretScrubber(vault, KEY, undefined, undefined, (f) => found.push(f));
    await s.refresh();

    // B deleted, and A doesn't come back: no telling whether it would decrypt.
    delete vault.secrets.B;
    vault.getErrors.A = busy;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(false);
    expect((s.failure as VaultKeyMismatch).secrets).toBe(2);
    expect(found).toEqual([{ secrets: 2, unscrubbed: 2, decrypted: 0, held: true }]);

    // A saved again with this key: the next read lifts it.
    delete vault.getErrors.A;
    later(READ_RETRY_MS[2]);
    expect(await s.ready()).toBe(true);
    expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 1, held: false });
  });

  it("found by the interval's re-read of a complete set, it holds too, and an outage meanwhile keeps it", async () => {
    // Sends went before: a secret saved again elsewhere, with another key,
    // and a new one saved with it, leave none the key can decrypt.
    const vault = new FakeVault({ A: "alpha-value" });
    const s = new SecretScrubber(vault, KEY);
    await s.refresh();
    expect(await s.ready()).toBe(true);

    vault.secrets.B = "bravo-value";
    vault.getErrors.B = wrongKey;
    vault.getErrors.A = wrongKey;
    vault.saved.A = "2026-11-08T00:00:05Z";
    await s.refresh();
    expect(await s.ready()).toBe(false);
    expect((s.failure as VaultKeyMismatch).secrets).toBe(2);

    vault.listError = offline;
    for (let i = 0; i < 20; i++) {
      later(60_000);
      expect(await s.ready()).toBe(false);
    }
    expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
  });

  it("a status that can't be written changes nothing: it holds, and lifts", async () => {
    const vault = foreign({ A: "alpha-value" });
    const s = new SecretScrubber(vault, KEY, undefined, undefined, () => {
      throw new Error("disk full");
    });
    await s.refresh();
    expect(await s.ready()).toBe(false);
    delete vault.secrets.A;
    later(MISMATCH_RETRY_MS[0]);
    expect(await s.ready()).toBe(true);
  });

  describe("held by the daemon before, as status.json says: still held", () => {
    const CARRIED =
      "vault scrubber: the daemon before held sends for secrets its vault key didn't decrypt — holding " +
      "them still, until a read of the vault finds none that can't be scrubbed";

    it("held before it reads: one saved again since decrypts, the other doesn't, and it holds", async () => {
      // A was saved again with this key while no daemon ran; B wasn't.
      const vault = foreign({ A: "alpha-value", B: "bravo-value" });
      delete vault.getErrors.A;
      const log: string[] = [];
      const found: Undecryptable[] = [];
      const s = new SecretScrubber(vault, KEY, keyLog(log), undefined, (f) => found.push(f));
      s.continueMismatchHold({ secrets: 2, unscrubbed: 2, decrypted: 0 });
      expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
      expect(log).toEqual([CARRIED]);
      // Said at the start: status.json says it already.
      expect(found).toEqual([]);

      expect(await s.ready()).toBe(false);
      expect(s.failure).toMatchObject({ secrets: 1, decrypted: 1 });
      expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] bravo-value");
      expect(log).toEqual([
        CARRIED,
        "vault scrubber: still holding sends — the vault key doesn't decrypt 1 of the vault's 2 secrets",
      ]);
      expect(found).toEqual([{ secrets: 1, unscrubbed: 1, decrypted: 1, held: true }]);

      // B deleted: what was held goes.
      delete vault.secrets.B;
      later(MISMATCH_RETRY_MS[0]);
      expect(await s.ready()).toBe(true);
      expect(s.failure).toBeUndefined();
      expect(log.at(-1)).toBe("vault scrubber: the vault key decrypts the vault's secrets now — sending what was held");
      expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 1, held: false });
    });

    it("the same as the daemon before found: said again, and held", async () => {
      const log: string[] = [];
      const s = new SecretScrubber(foreign({ A: "alpha-value", B: "bravo-value" }), KEY, keyLog(log));
      s.continueMismatchHold({ secrets: 2, unscrubbed: 2, decrypted: 0 });
      expect(await s.ready()).toBe(false);
      expect(log).toEqual([
        CARRIED,
        "vault scrubber: still holding sends — the vault key doesn't decrypt any of the vault's 2 secrets",
      ]);
    });

    it("a first read that finds none it can't scrub: what was held goes at once", async () => {
      const log: string[] = [];
      const found: Undecryptable[] = [];
      const s = new SecretScrubber(new FakeVault({ A: "alpha-value", B: "bravo-value" }), KEY, keyLog(log), undefined, (f) =>
        found.push(f),
      );
      s.continueMismatchHold({ secrets: 2, unscrubbed: 2, decrypted: 0 });
      expect(await s.ready()).toBe(true);
      expect(s.failure).toBeUndefined();
      expect(s.scrub("alpha-value bravo-value").text).toBe("[VAULT:A] [VAULT:B]");
      expect(log).toEqual([CARRIED, "vault scrubber: the vault key decrypts the vault's secrets now — sending what was held"]);
      expect(found).toEqual([{ secrets: 0, unscrubbed: 0, decrypted: 2, held: false }]);

      // Each deleted while no daemon ran: the same.
      const emptied = new FakeVault({});
      const said: string[] = [];
      const t = new SecretScrubber(emptied, KEY, keyLog(said));
      t.continueMismatchHold({ secrets: 1, unscrubbed: 1, decrypted: 0 });
      expect(await t.ready()).toBe(true);
      expect(said.at(-1)).toBe(
        "vault scrubber: the vault holds no secret now that can't be scrubbed — sending what was held",
      );
    });

    it("no bound releases it: a vault that can't be read meanwhile holds it, and the hold is why", async () => {
      const vault = foreign({ A: "alpha-value" });
      delete vault.getErrors.A;
      vault.listError = busy;
      const log: string[] = [];
      const s = new SecretScrubber(vault, KEY, keyLog(log));
      s.continueMismatchHold({ secrets: 1, unscrubbed: 1, decrypted: 0 });
      for (let i = 0; i < 30; i++) {
        later(60_000);
        expect(await s.ready()).toBe(false);
      }
      // What the syncer records: the hold, not the server's error.
      expect(s.failure).toBeInstanceOf(VaultKeyMismatch);
      expect(log.join("\n")).not.toContain("failed to read for");
      // A decrypts now: once the vault reads, what was held goes.
      vault.listError = null;
      later(READ_RETRY_MS.at(-1) as number);
      expect(await s.ready()).toBe(true);
      expect(s.scrub("alpha-value").text).toBe("[VAULT:A]");
    });

    it("an account switch meanwhile: the hold goes with the account before", async () => {
      const s = new SecretScrubber(foreign({ A: "alpha-value" }), KEY);
      s.continueMismatchHold({ secrets: 1, unscrubbed: 1, decrypted: 0 });
      const read = s.reconnect(new FakeVault({ B: "bravo-value" }));
      expect(s.failure).toBeUndefined();
      await read;
      expect(await s.ready()).toBe(true);
    });

    it("counts status.json can't vouch for: at least one, never fewer than none", () => {
      const s = new SecretScrubber(new FakeVault({}), KEY);
      s.continueMismatchHold({ secrets: 0, unscrubbed: 0, decrypted: -3 });
      expect(s.failure).toMatchObject({ secrets: 1, decrypted: 0 });
    });
  });

  it("decryptFailed: a value that doesn't decrypt here, never a request that failed", () => {
    expect(decryptFailed(wrongKey())).toBe(true);
    expect(decryptFailed(new Error("Vault encryption key must be 32 bytes (AES-256). Got 16 bytes."))).toBe(true);
    for (const err of [offline(), timedOut(), unavailable(), busy(), noReadScope(), new SyntaxError("Unexpected token")]) {
      expect(decryptFailed(err), String(err)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// engram#704: each vault_list and vault_get is an audit row on the server.
// While sends go, the interval lists the vault, and reads each secret again
// only when the list says something changed, or FULL_READ_MS has passed.

/** The daemon's interval. */
const TICK = 10 * 60_000;

/** A vault whose list dates each secret, as the server's does. */
const dated = (secrets: Record<string, string>): FakeVault => {
  const vault = new FakeVault(secrets);
  for (const name of Object.keys(secrets)) vault.saved[name] = "2026-11-07T12:00:00Z";
  return vault;
};

describe("the interval reads each secret again only when the list has changed (engram#704)", () => {
  /** Started on the interval, as worker-main starts it, with the first read settled. */
  async function started(s: SecretScrubber): Promise<SecretScrubber> {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-11-08T00:00:00Z"));
    s.start(TICK);
    await settle();
    expect(await s.ready()).toBe(true);
    return s;
  }

  async function tick(n = 1): Promise<void> {
    for (let i = 0; i < n; i++) {
      await vi.advanceTimersByTimeAsync(TICK);
      await settle();
    }
  }

  /** Lists, and secrets read. */
  const reads = (vault: FakeVault) => [vault.lists, vault.gets.length];

  it("the same list: one list a tick and no secret read, until FULL_READ_MS has passed", async () => {
    const vault = dated({ PIN: "4821", TOKEN: "tok-value-1234" });
    const s = await started(new SecretScrubber(vault, KEY));
    expect(reads(vault)).toEqual([1, 2]);
    // The list the first read found hadn't been found before it: the next
    // tick reads each secret again.
    await tick();
    expect(reads(vault)).toEqual([2, 4]);
    // Then the list only, for FULL_READ_MS since that read.
    const ticks = FULL_READ_MS / TICK;
    await tick(ticks - 1);
    expect(reads(vault)).toEqual([1 + ticks, 4]);
    await tick();
    expect(reads(vault)).toEqual([2 + ticks, 6]);
    // That read found the list the ticks before it did: the list only again.
    await tick(3);
    expect(reads(vault)).toEqual([5 + ticks, 6]);
    // Scrubbed all along, and sends never waited for a tick.
    expect(s.scrub("4821 tok-value-1234").text).toBe("[VAULT:PIN] [VAULT:TOKEN]");
    expect(await s.ready()).toBe(true);
    expect(reads(vault)).toEqual([5 + ticks, 6]);
    s.stop();
  });

  it("stopped and started again: as at first", async () => {
    const vault = dated({ PIN: "4821" });
    const s = await started(new SecretScrubber(vault, KEY));
    await tick(3);
    expect(reads(vault)).toEqual([4, 2]);
    s.stop();
    s.start(TICK);
    await settle();
    expect(await s.ready()).toBe(true);
    expect(reads(vault)).toEqual([5, 3]);
    await tick();
    expect(reads(vault)).toEqual([6, 4]);
    await tick();
    expect(reads(vault)).toEqual([7, 4]);
    s.stop();
  });

  it("a secret saved again: each is read at the next tick, its new value scrubbed, and read again at the one after", async () => {
    const vault = dated({ PIN: "4821", TOKEN: "tok-value-1234" });
    const s = await started(new SecretScrubber(vault, KEY));
    await tick(2);
    expect(reads(vault)).toEqual([3, 4]);
    // Saved again on another machine: a new value, and a new updatedAt.
    vault.secrets.PIN = "9930";
    vault.saved.PIN = "2026-11-08T00:25:00Z";
    await tick();
    expect(reads(vault)).toEqual([4, 6]);
    expect(s.scrub("PIN 9930").text).toBe("PIN [VAULT:PIN]");
    // Saved again within the second that read found it: the list is the
    // same, and the next tick reads each secret all the same.
    vault.secrets.PIN = "7716";
    await tick();
    expect(reads(vault)).toEqual([5, 8]);
    expect(s.scrub("PIN 7716").text).toBe("PIN [VAULT:PIN]");
    await tick(2);
    expect(reads(vault)).toEqual([7, 8]);
    s.stop();
  });

  it("a secret added, or deleted: each is read at the next tick", async () => {
    const vault = dated({ PIN: "4821" });
    const s = await started(new SecretScrubber(vault, KEY));
    await tick(2);
    expect(reads(vault)).toEqual([3, 2]);
    vault.secrets.NEW = "new-secret-value";
    vault.saved.NEW = "2026-11-08T00:25:00Z";
    await tick();
    expect(vault.gets.slice(2)).toEqual(["PIN", "NEW"]);
    expect(s.scrub("new-secret-value").text).toBe("[VAULT:NEW]");
    await tick(2);
    expect(reads(vault)).toEqual([6, 6]);

    delete vault.secrets.NEW;
    delete vault.saved.NEW;
    await tick();
    expect(reads(vault)).toEqual([7, 7]);
    expect(s.scrub("new-secret-value").text).toBe("new-secret-value");
    s.stop();
  });

  it("a list that doesn't date each secret: each is read at every tick, as before", async () => {
    const undated = new FakeVault({ PIN: "4821" });
    const s = await started(new SecretScrubber(undated, KEY));
    await tick(3);
    expect(reads(undated)).toEqual([4, 4]);
    s.stop();

    const some = dated({ PIN: "4821", TOKEN: "tok-value-1234" });
    delete some.saved.TOKEN;
    const t = await started(new SecretScrubber(some, KEY));
    await tick(3);
    expect(reads(some)).toEqual([4, 8]);
    t.stop();
  });

  it("a list that fails: nothing changes, and the next tick reads each secret", async () => {
    const vault = dated({ PIN: "4821", TOKEN: "tok-value-1234" });
    const s = await started(new SecretScrubber(vault, KEY));
    await tick(2);
    expect(reads(vault)).toEqual([3, 4]);
    for (const fail of [offline, busy]) {
      vault.listError = fail;
      await tick();
      vault.listError = null;
      const [lists, gets] = reads(vault);
      await tick();
      expect(reads(vault)).toEqual([lists + 1, gets + 2]);
      await tick();
      expect(reads(vault)).toEqual([lists + 2, gets + 2]);
    }
    expect(s.scrub("4821 tok-value-1234").text).toBe("[VAULT:PIN] [VAULT:TOKEN]");
    s.stop();
  });

  it("a secret that can't be read, or is gone, or is refused: the next tick reads each secret again", async () => {
    for (const fail of [offline, timedOut, unavailable, busy, noReadScope, null]) {
      const vault = dated({ PIN: "4821", TOKEN: "tok-value-1234" });
      const s = await started(new SecretScrubber(vault, KEY));
      // The read at the first tick finds the list found at start: it would
      // stand for that list, but for TOKEN, which it can't read (null: gone
      // between the list and the read).
      if (fail) vault.getErrors.TOKEN = fail;
      else (vault.secrets as Record<string, string | undefined>).TOKEN = undefined;
      await tick();
      expect(reads(vault), String(fail)).toEqual([2, 4]);
      delete vault.getErrors.TOKEN;
      vault.secrets.TOKEN = "tok-value-1234";
      await tick();
      expect(reads(vault), String(fail)).toEqual([3, 6]);
      expect(s.scrub("tok-value-1234").text).toBe("[VAULT:TOKEN]");
      // Read in full with the list found before: the list only from then on.
      await tick();
      expect(reads(vault), String(fail)).toEqual([4, 6]);
      s.stop();
      vi.useRealTimers();
    }
  });

  it("told the vault changed: each secret is read before the next send, though the list is the same", async () => {
    let notice: string | null = null;
    const vault = dated({ PIN: "4821" });
    const s = new SecretScrubber(vault, KEY);
    s.followChanges(() => notice);
    await started(s);
    await tick(3);
    expect(reads(vault)).toEqual([4, 2]);
    notice = "2026-11-08T00:35:00.000Z 1";
    expect(await s.ready()).toBe(true);
    expect(reads(vault)).toEqual([5, 3]);
    // It found the list the ticks before it did.
    await tick();
    expect(reads(vault)).toEqual([6, 3]);
    s.stop();
  });

  it("another client, or another vault key: each secret is read through it, and at the tick after", async () => {
    const before = dated({ PIN: "4821" });
    const s = await started(new SecretScrubber(before, KEY));
    await tick(2);
    expect(reads(before)).toEqual([3, 2]);
    // The API key changed (engram#587): the same list, through another client.
    const other = dated({ PIN: "4821" });
    await s.reconnect(other);
    expect(reads(other)).toEqual([1, 1]);
    await tick();
    expect(reads(other)).toEqual([2, 2]);
    await tick();
    expect(reads(other)).toEqual([3, 2]);
    expect(reads(before)).toEqual([3, 2]);
    s.stop();

    // A vault key put in place of the one in use (engram#693).
    const withA = dated({ PIN: "4821" });
    const withB = dated({ PIN: "4821" });
    const source = new FakeKeyFile(withB);
    source.finds = () => KEY_A;
    const t = await started(reading(source, withA, KEY_A));
    await tick(2);
    expect(reads(withA)).toEqual([3, 2]);
    source.finds = () => KEY_B;
    expect(await t.ready()).toBe(true);
    expect(reads(withB)).toEqual([1, 1]);
    await tick();
    expect(reads(withB)).toEqual([2, 2]);
    await tick();
    expect(reads(withB)).toEqual([3, 2]);
    t.stop();
  });

  it("a key that decrypts some of the secrets: what it found stands, and is told once, until a secret is saved again (engram#694)", async () => {
    const vault = dated({ PIN: "4821", OLD: "old-value" });
    vault.getErrors.OLD = wrongKey;
    const found: Undecryptable[] = [];
    const s = await started(new SecretScrubber(vault, KEY, undefined, undefined, (f) => found.push(f)));
    await tick(4);
    expect(reads(vault)).toEqual([5, 4]);
    expect(found).toEqual([
      { secrets: 1, unscrubbed: 1, decrypted: 1, held: false },
      { secrets: 1, unscrubbed: 1, decrypted: 1, held: false },
    ]);
    expect(s.failure).toBeUndefined();
    expect(await s.ready()).toBe(true);

    // Saved again with the key in use: it decrypts now.
    delete vault.getErrors.OLD;
    vault.saved.OLD = "2026-11-08T00:45:00Z";
    await tick();
    expect(reads(vault)).toEqual([6, 6]);
    expect(found.at(-1)).toEqual({ secrets: 0, unscrubbed: 0, decrypted: 2, held: false });
    expect(s.scrub("old-value").text).toBe("[VAULT:OLD]");
    s.stop();
  });

  it("SAME_LIST_MS: a read stands for the list only once that list had been found SAME_LIST_MS before it", async () => {
    let notice: string | null = null;
    const vault = dated({ PIN: "4821" });
    const s = new SecretScrubber(vault, KEY);
    s.followChanges(() => notice);
    await started(s);
    // Told the vault changed just short of SAME_LIST_MS after the first
    // list: that read doesn't stand for the list either.
    vi.setSystemTime(Date.now() + SAME_LIST_MS - 1);
    notice = "1";
    expect(await s.ready()).toBe(true);
    expect(reads(vault)).toEqual([2, 2]);
    await tick();
    expect(reads(vault)).toEqual([3, 3]);
    await tick();
    expect(reads(vault)).toEqual([4, 3]);

    // Saved again, found at a tick, and told the vault changed SAME_LIST_MS
    // after: that read stands for the list.
    vault.saved.PIN = "2026-11-08T00:25:00Z";
    await tick();
    expect(reads(vault)).toEqual([5, 4]);
    vi.setSystemTime(Date.now() + SAME_LIST_MS);
    notice = "2";
    expect(await s.ready()).toBe(true);
    expect(reads(vault)).toEqual([6, 5]);
    await tick();
    expect(reads(vault)).toEqual([7, 5]);
    s.stop();
  });
});

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
    vi.mocked(recordNextRetry).mockClear();
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

  it("a flush held for the vault records the hold once, however many conversations wait", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    for (const id of ["s1", "s2", "s3"]) await syncer.onMessages(id, meta(id), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(server.creates).toBe(3);
    expect(server.sends).toHaveLength(0);
    // The flush waits before any conversation starts: one status write for
    // it, not one for each conversation, every 2 s for as long as it lasts.
    expect(failures()).toHaveLength(1);
    expect(recordNextRetry).not.toHaveBeenCalled();
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

  it("a vault key that can't be read: creates go through, and sends wait however long it lasts (engram#677)", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    const scrubber = keyPending(source);
    await scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", `key ${KEY}`));
    await syncer.flush();
    expect(server.creates).toBe(1);
    expect(server.sends).toHaveLength(0);
    const held = "holding messages until the vault key can be read: ~/.engram/vault-key is a folder, not a file";
    expect(failures().at(-1)).toEqual([held, "vault_key", 2]);

    // Two hours of flushes: still waiting, and said once.
    for (let i = 0; i < 120; i++) {
      later(60_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(errorsLogged("holding queued messages until the vault key can be read")).toBe(1);
    expect(errorsLogged("holding queued messages until the vault is read")).toBe(0);

    // Capture goes on meanwhile.
    await syncer.onMessages("s1", meta("s1"), msgs("later: 4821"));
    later(2_000);
    await syncer.flush();
    expect(failures().at(-1)).toEqual([held, "vault_key", 3]);

    // The key put back: read on the next try, and the vault read with it.
    source.finds = () => KEY;
    later(READ_RETRY_MS[2]);
    await syncer.flush();
    expect(source.keys).toEqual([KEY]);
    const scrubbed = ["the PIN is [VAULT:PIN]", "key [VAULT:vault-key]", "later: [VAULT:PIN]"];
    expect(server.received).toEqual(scrubbed);
    expect(queued()).toEqual(scrubbed);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    const said = vi.mocked(console.log).mock.calls.filter((c) => String(c[0]).includes("vault read"));
    expect(said).toHaveLength(1);
  });

  it("sends held for one reason, then another: the new one is said, once (engram#694)", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const source = new FakeKeyFile(vault);
    const scrubber = keyPending(source);
    await scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(errorsLogged("holding queued messages until the vault key can be read")).toBe(1);

    // The key put back, and the vault then can't be read with it: why sends
    // wait now is said, once, until the bound on a server failing the read
    // (engram#588).
    source.finds = () => KEY;
    vault.listError = unavailable;
    for (let i = 0; i < 10; i++) {
      later(60_000);
      await syncer.flush();
    }
    expect(source.keys).toEqual([KEY]);
    expect(server.sends).toHaveLength(0);
    expect(errorsLogged("holding queued messages until the vault is read")).toBe(1);
    expect(failures().at(-1)?.[1]).toBe("server");

    // Read at last: what was held goes, scrubbed.
    vault.listError = null;
    later(READ_RETRY_MS.at(-1)!);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
    expect(errorsLogged("holding queued messages until the vault key can be read")).toBe(1);
  });

  it("a vault key file gone while sends wait for it keeps them waiting (engram#677)", async () => {
    const source = new FakeKeyFile(new FakeVault({ PIN: "4821" }));
    const scrubber = keyPending(source);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    source.finds = () => undefined;
    for (let i = 0; i < 30; i++) {
      later(60_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(failures().at(-1)).toEqual([
      "holding messages until the vault key can be read: ~/.engram/vault-key isn't there any more",
      "vault_key",
      1,
    ]);
    expect(queued()).toEqual(["the PIN is 4821"]); // kept, to send once it's safe
  });

  it("once the key reads, a vault that won't read holds as any vault read does (engram#677)", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.listError = unavailable;
    const source = new FakeKeyFile(vault);
    const scrubber = keyPending(source);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    source.finds = () => KEY;
    later(READ_RETRY_MS[0]);
    await syncer.flush();
    expect(server.sends).toHaveLength(0);
    expect(failures().at(-1)?.[0]).toMatch(/^holding messages until the vault is read/);
    expect(failures().at(-1)?.[1]).toBe("server");

    vault.listError = null;
    later(READ_RETRY_MS[0]);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
  });

  it("a vault key saved while the daemon runs: the next send waits for the vault read with it, and is scrubbed (engram#693)", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    vault.hold();
    const source = new FakeKeyFile(vault);
    source.finds = () => undefined;
    const scrubber = new SecretScrubber(null, undefined, undefined, { source });
    await scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);

    // No key: nothing waits.
    await syncer.onMessages("s1", meta("s1"), msgs("hello"));
    await syncer.flush();
    expect(server.received).toEqual(["hello"]);

    // Captured before the key is read: queued as it was.
    source.finds = () => KEY_A;
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", `key ${KEY_A}`));
    expect(queued()).toEqual(["hello", "the PIN is 4821", `key ${KEY_A}`]);
    later(2_000);
    const flushing = syncer.flush();
    await settle();
    expect(server.received).toEqual(["hello"]); // waits for the vault read

    vault.release();
    await flushing;
    const scrubbed = ["the PIN is [VAULT:PIN]", "key [VAULT:vault-key]"];
    expect(server.received).toEqual(["hello", ...scrubbed]);
    expect(queued()).toEqual(["hello", ...scrubbed]);
  });

  it("a vault key that decrypts none of the vault's secrets: creates go through, and sends wait however long it lasts (engram#694)", async () => {
    const vault = new FakeVault({ PIN: "4821", PASSPHRASE: "correct horse" });
    vault.getErrors.PIN = wrongKey;
    vault.getErrors.PASSPHRASE = wrongKey;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", "correct horse"));
    await syncer.flush();
    expect(server.creates).toBe(1);
    expect(server.sends).toHaveLength(0);
    const held =
      "holding messages until the vault's secrets can be scrubbed: the vault key doesn't decrypt any of " +
      "the vault's 2 secrets";
    expect(failures().at(-1)).toEqual([held, "vault_mismatch", 2]);

    // Two hours of flushes, the server failing for one of them: still
    // waiting, and said once.
    for (let i = 0; i < 120; i++) {
      vault.listError = i >= 30 && i < 90 ? unavailable : null;
      later(60_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(errorsLogged("holding queued messages until each of the vault's secrets decrypts, or is deleted")).toBe(1);
    expect(errorsLogged("holding queued messages until the vault is read")).toBe(0);
    expect(failures().at(-1)).toEqual([held, "vault_mismatch", 2]);
    expect(queued()).toEqual(["the PIN is 4821", "correct horse"]); // kept, to send once it's safe

    // Each saved again with this key: listed anew, read, and what was held goes, scrubbed.
    delete vault.getErrors.PIN;
    delete vault.getErrors.PASSPHRASE;
    vault.saved = { PIN: "2026-11-08T03:00:00Z", PASSPHRASE: "2026-11-08T03:00:00Z" };
    later(MISMATCH_RETRY_MS[4]);
    await syncer.flush();
    const scrubbed = ["the PIN is [VAULT:PIN]", "[VAULT:PASSPHRASE]"];
    expect(server.received).toEqual(scrubbed);
    expect(queued()).toEqual(scrubbed);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    const said = vi.mocked(console.log).mock.calls.filter((c) => String(c[0]).includes("vault read"));
    expect(said).toHaveLength(1);
  });

  it("a vault key that decrypts some of the vault's secrets doesn't hold: sends go, scrubbed of those it decrypts (engram#694)", async () => {
    const vault = new FakeVault({ PIN: "4821", PASSPHRASE: "correct horse" });
    vault.getErrors.PASSPHRASE = wrongKey;
    const scrubber = new SecretScrubber(vault, KEY);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);
    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821"));
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]"]);
    expect(failures()).toEqual([]);
  });

  it("a daemon started after one that held: sends wait though some decrypt, the server failing or not, until none can't be scrubbed (engram#694)", async () => {
    // PIN was saved again with this key while no daemon ran; PASSPHRASE wasn't.
    const vault = new FakeVault({ PIN: "4821", PASSPHRASE: "correct horse" });
    vault.getErrors.PASSPHRASE = wrongKey;
    const scrubber = new SecretScrubber(vault, KEY);
    scrubber.continueMismatchHold({ secrets: 2, unscrubbed: 2, decrypted: 0 });
    await scrubber.refresh(); // as start() does
    const syncer = new Syncer(db, server.client(), scrubber);

    await syncer.onMessages("s1", meta("s1"), msgs("the PIN is 4821", "correct horse"));
    await syncer.flush();
    expect(server.sends).toHaveLength(0);
    const held =
      "holding messages until the vault's secrets can be scrubbed: the vault key doesn't decrypt 1 of " +
      "the vault's 2 secrets";
    expect(failures().at(-1)).toEqual([held, "vault_mismatch", 2]);

    // An hour of flushes, the vault failing to read for half of it.
    for (let i = 0; i < 60; i++) {
      vault.listError = i < 30 ? unavailable : null;
      later(60_000);
      await syncer.flush();
    }
    expect(server.sends).toHaveLength(0);
    expect(recordSuccess).not.toHaveBeenCalled();
    expect(failures().at(-1)).toEqual([held, "vault_mismatch", 2]);
    // Kept, scrubbed of what can be: PIN's value isn't kept here either.
    expect(queued()).toEqual(["the PIN is [VAULT:PIN]", "correct horse"]);

    // PASSPHRASE deleted: what was held goes, scrubbed of PIN.
    delete vault.secrets.PASSPHRASE;
    later(MISMATCH_RETRY_MS[4]);
    await syncer.flush();
    expect(server.received).toEqual(["the PIN is [VAULT:PIN]", "correct horse"]);
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it("a secret saved while a flush sends is scrubbed from its next batch on (engram#701)", async () => {
    const vault = new FakeVault({ PIN: "4821" });
    const scrubber = new SecretScrubber(vault, KEY);
    let notice: string | null = null;
    scrubber.followChanges(() => notice);
    await scrubber.refresh();
    const syncer = new Syncer(db, server.client(), scrubber);

    // A batch's worth queued, as after time offline.
    const backlog = Array.from({ length: 25 }, (_, i) => `message ${i + 1}`);
    await syncer.onMessages("s1", meta("s1"), msgs(...backlog));
    // While it is sent, `engram vault set` saves a secret, and the watcher
    // captures a message with it in.
    server.onStore = async () => {
      server.onStore = null;
      vault.secrets.TOKEN = "tok-7731-zz";
      notice = "notice 1";
      await syncer.onMessages("s1", meta("s1"), msgs("the token is tok-7731-zz"));
    };
    await syncer.flush();
    expect(server.sends).toHaveLength(2);
    expect(server.sends[0].messages).toHaveLength(25);
    expect(server.received.at(-1)).toBe("the token is [VAULT:TOKEN]");
    expect(queued().at(-1)).toBe("the token is [VAULT:TOKEN]");
    expect(vault.lists).toBe(2);

    // The flushes after it don't read the vault again.
    await syncer.onMessages("s1", meta("s1"), msgs("next"));
    later(2_000);
    await syncer.flush();
    expect(server.received.at(-1)).toBe("next");
    expect(vault.lists).toBe(2);
  });
});
