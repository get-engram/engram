import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import { DaemonDb, SCHEMA_VERSION } from "../daemon/db.js";
import {
  Syncer,
  accountFingerprint,
  keyFingerprint,
  ownershipCandidates,
  sameAccount,
  type Account,
  type CaptureControl,
} from "../daemon/syncer.js";
import { DEFAULT_BASE_URL, isDefaultServer, normalizeServer, sameServer } from "../server-url.js";
import { recordSignedOut } from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#685: the daemon read the server once at start but the key every
// poll, so a key saved for one server was sent to another, and what was
// queued for one server could go to the next. An account is now a key AND
// a server, read together, and what is queued for one is sent only to it.
//
// Three fake servers stand in for the default server, a staging server and
// a local one. Each keeps its conversations in the account of the key that
// created them and records a violation for anything that crosses servers or
// accounts: a store or delete into another server's conversation, or into
// another account's, or a message captured for another server or account.
// Every message's text starts with the server and account it was captured
// for ("staging/A:…"), so the server can tell. afterEach fails any test
// that recorded a violation, or that logged a server's address.

const DEFAULT = DEFAULT_BASE_URL;
const STAGING = "http://staging.example.test";
const OTHER = "http://127.0.0.1:8702";

/** Each test key's account. key-a1 and key-a2 are two keys of account A (a
 *  rotated key); key-b is account B's. */
const ACCOUNT: Record<string, string> = { "key-a1": "A", "key-a2": "A", "key-b": "B" };
const fp = keyFingerprint;
const on = (key: string, server: string): Account => ({ key, server });
const afp = (key: string, server: string) => accountFingerprint(on(key, server));

type Op = "create" | "store" | "delete" | "owned";
type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

let violations: string[] = [];

class FakeServer {
  conversations = new Map<string, { account: string; messages: string[] }>();
  /** Every request, with the key it carried. */
  requests: Array<{ op: Op; key: string }> = [];
  /** What each owned-keys request asked about. */
  asked: string[][] = [];
  /** Confirm every key asked about: a server that would take anything. */
  claimsAll = false;
  deleted: string[] = [];
  private seq = 0;

  constructor(readonly name: string) {}

  /** A conversation an earlier daemon created here. */
  seed(id: string, account: string, messages: string[] = []): void {
    this.conversations.set(id, { account, messages: [...messages] });
  }

  /** POST /api/account/owned-keys. */
  async ownedKeys(key: string, hashes: string[]): Promise<string[]> {
    this.requests.push({ op: "owned", key });
    this.asked.push([...hashes]);
    if (this.claimsAll) return hashes;
    const mine = Object.keys(ACCOUNT)
      .filter((k) => ACCOUNT[k] === ACCOUNT[key])
      .map(fp);
    return hashes.filter((h) => mine.includes(h));
  }

  /** A client for one key on this server. */
  client(key: string): Engram {
    const account = ACCOUNT[key];
    if (!account) throw new Error(`no account for ${key}`);
    const mine = (id: string) => id.startsWith(`${this.name}_`);
    return {
      createConversation: async () => {
        this.requests.push({ op: "create", key });
        const conversationId = `${this.name}_conv_${++this.seq}`;
        this.conversations.set(conversationId, { account, messages: [] });
        return { conversationId };
      },
      store: async (p: StoreParams) => {
        this.requests.push({ op: "store", key });
        const conv = this.conversations.get(p.conversationId);
        const crossed: string[] = [];
        if (!mine(p.conversationId)) {
          crossed.push(`${this.name}: store into another server's ${p.conversationId}`);
        } else if (conv && conv.account !== account) {
          crossed.push(`${this.name}: store into ${p.conversationId} (account ${conv.account}) with ${key}`);
        }
        for (const m of p.messages) {
          if (!m.content.startsWith(`${this.name}/${account}:`)) {
            crossed.push(`${this.name}: "${m.content}" sent with ${key}`);
          }
        }
        if (!conv || crossed.length > 0) {
          violations.push(...crossed);
          throw new Error("conversation not found");
        }
        conv.messages.push(...p.messages.map((m) => m.content));
        return { stored: p.messages.length };
      },
      deleteConversation: async (id: string) => {
        this.requests.push({ op: "delete", key });
        const conv = this.conversations.get(id);
        if (!mine(id) || (conv && conv.account !== account)) {
          violations.push(`${this.name}: delete of ${id} with ${key}`);
          throw new Error("conversation not found");
        }
        this.deleted.push(id);
        this.conversations.delete(id);
      },
    } as unknown as Engram;
  }

  /** What this server holds for a session, found through daemon.db's
   *  mapping in `account`. */
  copyOf(db: DaemonDb, sessionId: string, account: Account): string[] | undefined {
    const conv = db.getConversationId(sessionId, accountFingerprint(account));
    return conv ? this.conversations.get(conv)?.messages : undefined;
  }

  count(op: Op): number {
    return this.requests.filter((r) => r.op === op).length;
  }
}

let servers: Map<string, FakeServer>;
let defaultServer: FakeServer;
let staging: FakeServer;
let other: FakeServer;

function serverAt(url: string): FakeServer {
  const s = servers.get(normalizeServer(url));
  if (!s) {
    violations.push("a request to a server no test set up");
    throw new Error("no such server");
  }
  return s;
}

/** The account the daemon finds configured, as worker-main reads it: a key
 *  and the server it is for. */
function keySource(initial?: Account) {
  const keys = {
    current: initial,
    unread: false,
    configured: initial,
    readError: null as Error | null,
    reads: 0,
    /** "server:key" for each client made. */
    connected: [] as string[],
    async read(): Promise<Account | undefined> {
      keys.reads++;
      if (keys.readError) throw keys.readError;
      return keys.configured;
    },
    connect(account: Account): Engram {
      const s = serverAt(account.server);
      keys.connected.push(`${s.name}:${account.key}`);
      return s.client(account.key);
    },
    disconnect(): void {},
    ownedKeys(account: Account, hashes: string[]): Promise<string[]> {
      return serverAt(account.server).ownedKeys(account.key, hashes);
    },
  };
  return keys;
}

class FakeCapture implements CaptureControl {
  events: string[] = [];
  start(): void {
    this.events.push("start");
  }
  stop(drain: boolean): void {
    this.events.push(drain ? "stop+drain" : "stop");
  }
}

let dir: string;
let dbPath: string;
let db: DaemonDb;
let syncer: Syncer;
const syncers: Syncer[] = [];
const opened: Array<{ close(): unknown }> = [];

function track<T extends { close(): unknown }>(handle: T): T {
  opened.push(handle);
  return handle;
}

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
const allRequests = () => [...servers.values()].flatMap((s) => s.requests);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-685-"));
  dbPath = join(dir, "daemon.db");
  db = track(new DaemonDb(dbPath));
  violations = [];
  defaultServer = new FakeServer("default");
  staging = new FakeServer("staging");
  other = new FakeServer("other");
  servers = new Map([
    [normalizeServer(DEFAULT), defaultServer],
    [normalizeServer(STAGING), staging],
    [normalizeServer(OTHER), other],
  ]);
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-10T00:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(recordSignedOut).mockClear();
});

afterEach(() => {
  const lines = [...logged(), ...errors()];
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
  expect(violations).toEqual([]);
  // A server's address can carry credentials, so it is never logged.
  expect(lines.filter((l) => /staging\.example|127\.0\.0\.1|getengram/i.test(l))).toEqual([]);
});

describe("an account is a key and a server (engram#685)", () => {
  it("normalizeServer keeps scheme, host, port and path, and drops credentials, query, fragment, a default port and trailing slashes", () => {
    expect(normalizeServer("http://user:secret@staging.example.test:8080/api/?q=1#x")).toBe(
      "http://staging.example.test:8080/api",
    );
    expect(normalizeServer("  https://mcp.getengram.app:443//  ")).toBe(DEFAULT);
    expect(normalizeServer("HTTP://Staging.Example.TEST/")).toBe(STAGING);
    expect(normalizeServer(" not a url/// ")).toBe("not a url");
  });

  it("the default server is the default however it is spelled, and only then", () => {
    expect(isDefaultServer(DEFAULT)).toBe(true);
    expect(isDefaultServer("HTTPS://MCP.GETENGRAM.APP:443/")).toBe(true);
    expect(isDefaultServer("http://mcp.getengram.app")).toBe(false);
    expect(isDefaultServer("https://mcp.getengram.app:8443")).toBe(false);
    expect(isDefaultServer("https://mcp.getengram.app/v2")).toBe(false);
    expect(isDefaultServer(STAGING)).toBe(false);
    expect(sameServer(STAGING, "http://staging.example.test/")).toBe(true);
    expect(sameServer(STAGING, "http://staging.example.test:8080")).toBe(false);
    expect(sameServer(STAGING, OTHER)).toBe(false);
  });

  it("accountFingerprint: the key's hash alone on the default server, as before; with a tag of the server on any other", () => {
    expect(afp("key-a1", DEFAULT)).toBe(fp("key-a1"));
    expect(afp("key-a1", "https://mcp.getengram.app/")).toBe(fp("key-a1"));

    const onStaging = afp("key-a1", STAGING);
    expect(onStaging).toMatch(/^[0-9a-f]{64}@[0-9a-f]{32}$/);
    expect(onStaging.startsWith(`${fp("key-a1")}@`)).toBe(true);
    // One tag per server, however it is spelled; another server, another tag.
    expect(afp("key-b", "HTTP://Staging.Example.TEST/").split("@")[1]).toBe(onStaging.split("@")[1]);
    expect(afp("key-a1", "http://user:secret@staging.example.test")).toBe(onStaging);
    expect(afp("key-a1", OTHER)).not.toBe(onStaging);
    // Neither the key nor the server's address is written to daemon.db.
    expect(onStaging).not.toContain("key-a1");
    expect(onStaging).not.toContain("staging");
  });

  it("sameAccount: the same key for the same server", () => {
    expect(sameAccount(on("key-a1", STAGING), on("key-a1", "http://staging.example.test/"))).toBe(true);
    expect(sameAccount(on("key-a1", STAGING), on("key-a1", DEFAULT))).toBe(false);
    expect(sameAccount(on("key-a1", STAGING), on("key-a2", STAGING))).toBe(false);
    expect(sameAccount(undefined, undefined)).toBe(true);
    expect(sameAccount(on("key-a1", STAGING), undefined)).toBe(false);
    expect(sameAccount(undefined, on("key-a1", STAGING))).toBe(false);
  });

  it("ownershipCandidates: a server is asked only about what may be its own", () => {
    // The default server: other keys' rows recorded for it, never another server's.
    expect(
      ownershipCandidates(
        fp("key-a1"),
        [fp("key-a2"), fp("key-b"), afp("key-a2", STAGING), afp("key-b", OTHER), "fixed"],
        new Set([fp("key-a2")]),
      ),
    ).toEqual([
      { fp: fp("key-a2"), keyHash: fp("key-a2"), unknownServerOnly: false },
      { fp: fp("key-b"), keyHash: fp("key-b"), unknownServerOnly: false },
    ]);
    // Another server: its own rows under other keys, and what doesn't record
    // its server (its own key's included), never the default's or a third's.
    expect(
      ownershipCandidates(
        afp("key-a1", STAGING),
        [
          fp("key-a1"),
          fp("key-a2"),
          fp("key-b"),
          afp("key-a2", STAGING),
          afp("key-b", OTHER),
          "fixed",
        ],
        new Set([fp("key-a1"), fp("key-b")]),
      ),
    ).toEqual([
      { fp: fp("key-a1"), keyHash: fp("key-a1"), unknownServerOnly: true },
      { fp: fp("key-b"), keyHash: fp("key-b"), unknownServerOnly: true },
      { fp: afp("key-a2", STAGING), keyHash: fp("key-a2"), unknownServerOnly: false },
    ]);
  });
});

/** Make `path` a daemon.db as version 3 left it, with no server recorded
 *  anywhere, and let `fill` write rows the way a version-3 daemon did. */
function writeV3(path: string, fill: (raw: Database.Database) => void): void {
  new DaemonDb(path).close();
  const raw = new Database(path);
  try {
    for (const table of ["pending_messages", "session_map", "remote_deletes"]) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN server_known`);
    }
    raw.pragma("user_version = 3");
    fill(raw);
  } finally {
    raw.close();
  }
}

const v3 = {
  message(raw: Database.Database, conversationId: string, content: string, keyFp: string | null) {
    raw
      .prepare(
        `INSERT INTO pending_messages (conversation_id, role, content, created_at, key_fp)
         VALUES (?, 'user', ?, datetime('now'), ?)`,
      )
      .run(conversationId, content, keyFp);
  },
  pendingSession(raw: Database.Database, sessionId: string, content: string, keyFp: string) {
    raw
      .prepare(
        `INSERT INTO pending_sessions (session_id, meta, created_at, updated_at)
         VALUES (?, ?, datetime('now'), datetime('now'))`,
      )
      .run(sessionId, JSON.stringify(meta(sessionId)));
    v3.message(raw, `pending:${sessionId}`, content, keyFp);
  },
  mapping(raw: Database.Database, sessionId: string, conversationId: string, keyFp: string) {
    raw
      .prepare(
        `INSERT INTO session_map (conversation_id, session_id, key_fp, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(conversationId, sessionId, keyFp);
  },
  remoteDelete(raw: Database.Database, conversationId: string, sessionId: string, keyFp: string) {
    raw
      .prepare(
        `INSERT INTO remote_deletes (conversation_id, key_fp, session_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .run(conversationId, keyFp, sessionId);
  },
};

/** Each row's server_known, by table, read with a handle of its own. */
function serverKnown(path: string): Record<string, Array<[string, number]>> {
  const raw = new Database(path, { readonly: true });
  try {
    const rows = (sql: string) =>
      (raw.prepare(sql).all() as Array<{ label: string; known: number }>).map(
        (r) => [r.label, r.known] as [string, number],
      );
    return {
      pending_messages: rows(
        "SELECT content AS label, server_known AS known FROM pending_messages ORDER BY rowid",
      ),
      session_map: rows(
        "SELECT conversation_id AS label, server_known AS known FROM session_map ORDER BY rowid",
      ),
      remote_deletes: rows(
        "SELECT conversation_id AS label, server_known AS known FROM remote_deletes ORDER BY rowid",
      ),
    };
  } finally {
    raw.close();
  }
}

describe("daemon.db version 4 records whether a row's server is known (engram#685)", () => {
  it("rows from before version 4 don't record their server, rows queued now do, and the upgrade runs once", () => {
    const path = join(dir, "v3.db");
    writeV3(path, (raw) => {
      v3.message(raw, "conv_old", "old1", fp("key-a1"));
      v3.mapping(raw, "s1", "conv_old", fp("key-a1"));
      v3.remoteDelete(raw, "conv_gone", "s9", fp("key-a1"));
    });
    db = track(new DaemonDb(path));
    db.enqueue("conv_new", msgs("new1"), afp("key-a1", STAGING));
    db.enqueue("conv_new", msgs("new2"), fp("key-a1"));
    // Queued while nobody was signed in: no account, so no server either.
    db.enqueue("conv_out", msgs("signed out"), null);
    db.setSessionMap("s2", "conv_new", {}, fp("key-a1"));
    db.close();

    const raw = new Database(path, { readonly: true });
    expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    raw.close();
    const after = serverKnown(path);
    expect(after).toEqual({
      pending_messages: [
        ["old1", 0],
        ["new1", 1],
        ["new2", 1],
        ["signed out", 0],
      ],
      session_map: [
        ["conv_old", 0],
        ["conv_new", 1],
      ],
      remote_deletes: [["conv_gone", 0]],
    });

    // Opening it again changes nothing.
    db = track(new DaemonDb(path));
    expect(db.unknownServerFps()).toEqual([fp("key-a1")]);
    db.close();
    expect(serverKnown(path)).toEqual(after);
  });

  it("a row an older daemon writes after a downgrade doesn't record its server", () => {
    db.close();
    const raw = new Database(dbPath);
    v3.message(raw, "conv_x", "from 0.7.0", fp("key-a1"));
    raw.close();
    db = track(new DaemonDb(dbPath));
    expect(serverKnown(dbPath).pending_messages).toEqual([["from 0.7.0", 0]]);
    expect(db.unknownServerFps()).toEqual([fp("key-a1")]);
  });

  it("adoptKeys with unknownServerOnly moves only the rows that don't record their server", () => {
    const path = join(dir, "v3.db");
    writeV3(path, (raw) => {
      v3.message(raw, "conv_old", "old1", fp("key-a1"));
      v3.mapping(raw, "s1", "conv_old", fp("key-a1"));
      v3.remoteDelete(raw, "conv_gone", "s9", fp("key-a1"));
    });
    db = track(new DaemonDb(path));
    // Queued by this version for the default server, with the same key.
    db.enqueue("conv_default", msgs("default1"), fp("key-a1"));
    db.setSessionMap("s2", "conv_default", {}, fp("key-a1"));

    const to = afp("key-a1", STAGING);
    expect(db.adoptKeys([{ fp: fp("key-a1"), unknownServerOnly: true }], to)).toEqual({
      messages: 1,
      sessions: 1,
      deletes: 1,
    });
    expect(db.getPendingConversationIds(to)).toEqual(["conv_old"]);
    expect(db.getConversationId("s1", to)).toBe("conv_old");
    expect(db.getPendingRemoteDeletes(to).map((r) => r.conversation_id)).toEqual(["conv_gone"]);
    // The default server's stay its own.
    expect(db.getPendingConversationIds(fp("key-a1"))).toEqual(["conv_default"]);
    expect(db.getConversationId("s2", fp("key-a1"))).toBe("conv_default");
    // What moved records the server it goes to now, so it is never asked about again.
    expect(db.unknownServerFps()).toEqual([]);
    expect(db.adoptKeys([{ fp: fp("key-a1"), unknownServerOnly: true }], to)).toEqual({
      messages: 0,
      sessions: 0,
      deletes: 0,
    });

    // Without unknownServerOnly, everything under the key moves (a rotated key).
    const rotated = afp("key-a2", STAGING);
    expect(db.adoptKeys([{ fp: to }], rotated)).toEqual({ messages: 1, sessions: 1, deletes: 1 });
    expect(db.getPendingConversationIds(rotated)).toEqual(["conv_old"]);
  });

  it("claimLegacy gives what belongs to no key to the account signing in, its server included", () => {
    db.close();
    writeV3(dbPath, (raw) => {
      v3.message(raw, "conv_0", "queued by 0.6", null);
      raw
        .prepare(
          `INSERT INTO session_map (conversation_id, session_id, key_fp, created_at)
           VALUES ('conv_0', 's0', '', datetime('now'))`,
        )
        .run();
    });
    db = track(new DaemonDb(dbPath));
    db.enqueuePendingSession("s1", meta("s1"), msgs("captured while signed out"), null);
    // Nobody's yet, so no server is asked about them.
    expect(db.unknownServerFps()).toEqual([]);

    db.claimLegacy(fp("key-a1"));
    expect(serverKnown(dbPath)).toMatchObject({
      pending_messages: [
        ["queued by 0.6", 1],
        ["captured while signed out", 1],
      ],
      session_map: [["conv_0", 1]],
    });
    // The default server's now: another server is never asked about them.
    expect(db.unknownServerFps()).toEqual([]);
    expect(
      ownershipCandidates(afp("key-a1", STAGING), db.otherKeyFps(afp("key-a1", STAGING)), new Set()),
    ).toEqual([]);
  });

  it("an opt-out's delete records what its conversation's mapping recorded about the server", () => {
    db.close();
    writeV3(dbPath, (raw) => v3.mapping(raw, "s1", "conv_old", fp("key-a1")));
    db = track(new DaemonDb(dbPath));
    db.setSessionMap("s1", "conv_staging", {}, afp("key-a1", STAGING));
    db.excludeSession("s1", "in-chat opt-out");
    expect(serverKnown(dbPath).remote_deletes).toEqual([
      ["conv_old", 0],
      ["conv_staging", 1],
    ]);
  });

  it("stats for an account on another server count what its key queued before servers were recorded as its own", () => {
    const path = join(dir, "v3.db");
    writeV3(path, (raw) => {
      v3.message(raw, "conv_old", "old1", fp("key-a1"));
      v3.message(raw, "conv_old", "old2", fp("key-a1"));
      v3.message(raw, "conv_b", "b1", fp("key-b"));
    });

    // Read-only, while a version-3 daemon still owns it: no server recorded.
    const ro3 = track(new DaemonDb(path, { readonly: true }));
    expect(ro3.getStats(afp("key-a1", STAGING), fp("key-a1"))).toMatchObject({
      pendingMessages: 2,
      heldMessages: 1,
    });
    ro3.close();

    db = track(new DaemonDb(path));
    db.enqueue("conv_default", msgs("default1"), fp("key-a1"));
    db.enqueue("conv_staging", msgs("staging1"), afp("key-a1", STAGING));
    db.enqueue("conv_other", msgs("other1"), afp("key-a1", OTHER));
    // On staging: its own, and the key's from before; not the default's or the third server's.
    expect(db.getStats(afp("key-a1", STAGING), fp("key-a1"))).toMatchObject({
      pendingMessages: 3,
      heldMessages: 3,
    });
    // On the default server: the key's, as before.
    expect(db.getStats(fp("key-a1"), fp("key-a1"))).toMatchObject({
      pendingMessages: 3,
      heldMessages: 3,
    });
    expect(db.getStats(fp("key-a1"))).toMatchObject({ pendingMessages: 3, heldMessages: 3 });
  });
});

describe("what is queued for one server is sent only to that server (engram#685)", () => {
  it("the same key on another server is another account: what was queued for one isn't sent to the other", async () => {
    const keys = keySource(on("key-a1", STAGING));
    syncer = newSyncer(keys);
    syncer.start();
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m1"));
    await syncer.flush();
    expect(staging.copyOf(db, "s1", on("key-a1", STAGING))).toEqual(["staging/A:m1"]);

    // Queued for staging, and not sent yet, when config.json changes server.
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m2"));
    keys.configured = on("key-a1", DEFAULT);
    await syncer.checkKey();
    expect(
      linesWith(
        "[engram] the server in ~/.engram/config.json changed — capturing and sending to the new one from now on",
      ),
    ).toHaveLength(1);

    await syncer.onMessages("s1", meta("s1"), msgs("default/A:d1"));
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s1", on("key-a1", DEFAULT))).toEqual(["default/A:d1"]);
    expect(db.getPendingCount(afp("key-a1", STAGING))).toBe(1);
    // The default server isn't asked about what was queued for staging.
    expect(defaultServer.asked).toEqual([]);
    expect(
      linesWith(
        "[engram] 1 queued message(s) wait for another account (another API key, or another " +
          "server) — they stay on this machine and are sent only to that account",
      ),
    ).toHaveLength(1);

    // Back on staging, the session continues in its conversation there.
    keys.configured = on("key-a1", STAGING);
    await syncer.flush();
    expect(staging.copyOf(db, "s1", on("key-a1", STAGING))).toEqual(["staging/A:m1", "staging/A:m2"]);
    expect(staging.count("create")).toBe(1);
    expect(defaultServer.count("create")).toBe(1);
    expect(staging.asked).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
    expect(keys.connected).toEqual(["staging:key-a1", "default:key-a1", "staging:key-a1"]);
  });

  it("a third server is sent nothing queued for the server before it, and asked nothing about it", async () => {
    const keys = keySource(on("key-a1", STAGING));
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m1", "staging/A:m2"));
    keys.configured = on("key-a1", OTHER);
    await syncer.flush();
    expect(other.requests).toEqual([]);
    expect(db.getPendingCount(afp("key-a1", STAGING))).toBe(2);
    expect(linesWith("[engram] 2 queued message(s) wait for another account")).toHaveLength(1);

    await syncer.onMessages("s1", meta("s1"), msgs("other/A:o1"));
    await syncer.flush();
    expect(other.copyOf(db, "s1", on("key-a1", OTHER))).toEqual(["other/A:o1"]);
    expect(other.asked).toEqual([]);

    keys.configured = on("key-a1", STAGING);
    await syncer.flush();
    expect(staging.copyOf(db, "s1", on("key-a1", STAGING))).toEqual(["staging/A:m1", "staging/A:m2"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a new key and a new server together: the next server is asked only about its own rows, and a rotated key there continues the session", async () => {
    const keys = keySource(on("key-a1", STAGING));
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m1"));
    await syncer.flush();
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m2"));

    // config.json now has another key of account A, for the default server.
    keys.configured = on("key-a2", DEFAULT);
    await syncer.checkKey();
    expect(
      linesWith("[engram] new API key and server found — capturing and sending with them from now on"),
    ).toHaveLength(1);
    await syncer.onMessages("s1", meta("s1"), msgs("default/A:d1"));
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s1", on("key-a2", DEFAULT))).toEqual(["default/A:d1"]);
    expect(defaultServer.asked).toEqual([]);
    expect(db.getPendingCount(afp("key-a1", STAGING))).toBe(1);

    // The same key on staging: staging confirms key-a1 is the account's,
    // and the session continues in staging's conversation.
    keys.configured = on("key-a2", STAGING);
    await syncer.flush();
    expect(staging.asked).toEqual([[fp("key-a1")]]);
    expect(
      linesWith(
        "[engram] 1 earlier API key(s) are this account's — sending their 1 queued message(s) with this key",
      ),
    ).toHaveLength(1);
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m3"));
    await syncer.flush();
    expect(staging.copyOf(db, "s1", on("key-a2", STAGING))).toEqual([
      "staging/A:m1",
      "staging/A:m2",
      "staging/A:m3",
    ]);
    expect(staging.count("create")).toBe(1);
    expect(db.getPendingCount()).toBe(0);
  });

  it("a server that would confirm any key is asked about nothing recorded for another server, the default included", async () => {
    other.claimsAll = true;
    const keys = keySource(on("key-a1", DEFAULT));
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("default/A:d1"));
    keys.configured = on("key-b", STAGING);
    await syncer.checkKey();
    await syncer.onMessages("s2", meta("s2"), msgs("staging/B:b1"));

    // The key queued for the default server, now for a third server.
    keys.configured = on("key-a1", OTHER);
    await syncer.flush();
    await syncer.flush();
    expect(other.requests).toEqual([]);
    expect(other.asked).toEqual([]);
    expect(linesWith("[engram] 2 queued message(s) wait for another account")).toHaveLength(1);

    // Each goes to its own server, with its own key.
    keys.configured = on("key-a1", DEFAULT);
    await syncer.flush();
    keys.configured = on("key-b", STAGING);
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s1", on("key-a1", DEFAULT))).toEqual(["default/A:d1"]);
    expect(staging.copyOf(db, "s2", on("key-b", STAGING))).toEqual(["staging/B:b1"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("what an earlier version queued with the key goes to another server once it confirms the key, but nothing this version queued for the default server", async () => {
    db.close();
    writeV3(dbPath, (raw) => {
      // An earlier daemon, started with staging in config.json, synced s1
      // there and queued more for it and for a new session, s2.
      v3.mapping(raw, "s1", "staging_conv_old", fp("key-a1"));
      v3.message(raw, "staging_conv_old", "staging/A:legacy1", fp("key-a1"));
      v3.pendingSession(raw, "s2", "staging/A:legacy2", fp("key-a1"));
    });
    staging.seed("staging_conv_old", "A", ["staging/A:legacy0"]);
    db = track(new DaemonDb(dbPath));
    // This version queued for the default server with the same key.
    db.enqueuePendingSession("s3", meta("s3"), msgs("default/A:new1"), fp("key-a1"));

    // Even a server that would confirm any key gets only what may be its own.
    staging.claimsAll = true;
    const keys = keySource(on("key-a1", STAGING));
    syncer = newSyncer(keys);
    await syncer.flush();
    expect(staging.asked).toEqual([[fp("key-a1")]]);
    expect(
      linesWith(
        "[engram] the server confirmed this API key — sending it the 2 message(s) an earlier " +
          "version of Engram queued with the key",
      ),
    ).toHaveLength(1);
    expect(linesWith("[engram] 1 queued message(s) wait for another account")).toHaveLength(1);
    expect(staging.copyOf(db, "s1", on("key-a1", STAGING))).toEqual([
      "staging/A:legacy0",
      "staging/A:legacy1",
    ]);
    expect(staging.copyOf(db, "s2", on("key-a1", STAGING))).toEqual(["staging/A:legacy2"]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);

    // Asked once.
    await syncer.flush();
    expect(staging.asked).toHaveLength(1);

    // The default server gets what was queued for it, and nothing else.
    keys.configured = on("key-a1", DEFAULT);
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s3", on("key-a1", DEFAULT))).toEqual(["default/A:new1"]);
    expect(defaultServer.asked).toEqual([]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("what was captured while signed out goes to the account that signs in next, and stays that server's", async () => {
    const keys = keySource(undefined);
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("default/A:out1"));
    keys.configured = on("key-a1", DEFAULT);
    await syncer.checkKey();

    // Before it was sent, the key moved to another server that would take anything.
    staging.claimsAll = true;
    keys.configured = on("key-a1", STAGING);
    await syncer.flush();
    expect(staging.requests).toEqual([]);
    expect(db.getPendingCount(fp("key-a1"))).toBe(1);

    keys.configured = on("key-a1", DEFAULT);
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s1", on("key-a1", DEFAULT))).toEqual(["default/A:out1"]);
  });

  it("an opt-out deletes each copy on the server it is on, with that server's key", async () => {
    const keys = keySource(on("key-a1", STAGING));
    syncer = newSyncer(keys);
    await syncer.onMessages("s1", meta("s1"), msgs("staging/A:m1"));
    await syncer.flush();
    keys.configured = on("key-a1", DEFAULT);
    await syncer.checkKey();
    await syncer.onMessages("s1", meta("s1"), msgs("default/A:d1"));
    await syncer.flush();
    expect(defaultServer.copyOf(db, "s1", on("key-a1", DEFAULT))).toEqual(["default/A:d1"]);

    // "engram: ignore" in the session, captured while on the default server.
    await syncer.onMessages("s1", meta("s1"), msgs("engram: ignore"));
    await syncer.flush();
    expect(defaultServer.deleted).toEqual(["default_conv_1"]);
    expect(staging.deleted).toEqual([]);
    expect(db.getPendingRemoteDeletes(afp("key-a1", STAGING)).map((r) => r.conversation_id)).toEqual([
      "staging_conv_1",
    ]);

    keys.configured = on("key-a1", STAGING);
    await syncer.flush();
    expect(staging.deleted).toEqual(["staging_conv_1"]);
    expect(db.getPendingRemoteDeletes(afp("key-a1", STAGING))).toEqual([]);
  });
});

describe("config.json unreadable at start (engram#685)", () => {
  it("nothing is captured, sent, or connected until it is read; then everything goes to the server it names", async () => {
    const keys = keySource(undefined);
    keys.unread = true;
    keys.readError = new Error("config.json can't be read");
    const capture = new FakeCapture();
    syncer = newSyncer(keys, capture);
    // Queued while no key was in use: it goes to whoever signs in next.
    db.enqueuePendingSession("s0", meta("s0"), msgs("staging/A:q0"), null);

    syncer.start();
    expect(capture.events).toEqual([]);
    expect(recordSignedOut).toHaveBeenCalledTimes(1);
    // worker-main said it waits for config.json; this isn't a sign-out.
    expect(linesWith("[engram] signed out")).toEqual([]);
    for (let i = 0; i < 5; i++) {
      later(2_000);
      await syncer.flush();
    }
    expect(allRequests()).toEqual([]);
    expect(keys.connected).toEqual([]);
    expect(errorsWith("[engram] reading the API key failed (will retry)")).toHaveLength(1);

    keys.readError = null;
    keys.configured = on("key-a1", STAGING);
    await syncer.flush();
    expect(capture.events).toEqual(["start"]);
    expect(keys.connected).toEqual(["staging:key-a1"]);
    expect(linesWith("[engram] signed in — capture and sync resumed")).toHaveLength(1);
    expect(staging.copyOf(db, "s0", on("key-a1", STAGING))).toEqual(["staging/A:q0"]);
    expect(defaultServer.requests).toEqual([]);
  });

  it("read at last with no key in it: signed out, said once", async () => {
    const keys = keySource(undefined);
    keys.unread = true;
    keys.readError = new Error("config.json can't be read");
    syncer = newSyncer(keys);
    syncer.start();
    await syncer.flush();
    expect(linesWith("[engram] signed out")).toEqual([]);

    keys.readError = null;
    for (let i = 0; i < 3; i++) {
      later(2_000);
      await syncer.flush();
    }
    expect(linesWith("[engram] signed out")).toHaveLength(1);
    expect(allRequests()).toEqual([]);
  });
});
