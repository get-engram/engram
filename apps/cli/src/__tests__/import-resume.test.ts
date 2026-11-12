import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AuthenticationError,
  EngramError,
  TimeoutError,
  type Conversation,
  type CreateConversationParams,
  type CreateConversationResponse,
  type Engram,
  type GetConversationParams,
  type GetConversationResponse,
  type Message,
  type MessageInput,
  type MessageRole,
  type StoreParams,
  type StoreResponse,
} from "@getengram/sdk";
import { importHistory } from "../commands/import.js";
import { isImportMoved } from "../daemon/status.js";
import { engramCommand } from "../daemon/package-runner.js";
import { boundContent, MAX_MESSAGE_CONTENT_CHARS } from "../message-bounds.js";
import {
  ImportDigest,
  importTiming,
  markBatch,
  parseImportCursor,
  patientCaller,
  planFromStored,
  planResume,
  prefixDigest,
  rateLimitWait,
  sameAsStored,
  serverTime,
  StillRefused,
  PATIENCE_MS,
  PAUSE_WAIT_MS,
  SAME_WRITE_MS,
  type ImportCursor,
} from "../import-resume.js";

// engram#751: a re-run of `engram import` finishes what an earlier run
// didn't, and never stores a message twice. The fake Engram below runs the
// worker's own cursor code (apps/mcp-server/src/services/import-cursor.ts)
// to decide what it stores, so these tests fail if the CLI and the worker
// stop agreeing on what a cursor is.

// The import runs with --force (or --dry-run), so no usage check runs. Were
// one to run, it must not read the developer's own ~/.engram/config.json.
vi.mock("../config-guard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config-guard.js")>()),
  configForUse: async () => {
    throw new Error("a test asked for ~/.engram/config.json");
  },
}));

/** The worker's cursor code. Loaded by URL, never imported statically: it
 *  sits outside the CLI's rootDir, and the CLI is published alone. */
const SERVER_CURSOR = "../../../mcp-server/src/services/import-cursor.ts";

interface ServerCursor {
  parseImportCursor(value: unknown): ImportCursor | null;
  takeImportCursor<T extends { metadata?: Record<string, unknown> }>(
    messages: T[],
  ): { messages: T[]; cursor: ImportCursor | null };
  importStartsAt(conversation: Record<string, unknown>, from: number): boolean;
}

let server: ServerCursor;
beforeAll(async () => {
  server = (await import(/* @vite-ignore */ new URL(SERVER_CURSOR, import.meta.url).href)) as ServerCursor;
});

/** A digest that matches no conversation's. */
const DIGEST = "0123456789abcdef".repeat(4);
/** Not on a whole second, so times written to the second are earlier than the message's. */
const START = Date.parse("2026-11-01T00:00:00.750Z");
const iso = (t: number) => new Date(t).toISOString();
/** A time as D1's datetime('now') writes it. */
const sqlTime = (t: number) => iso(t).slice(0, 19).replace("T", " ");

function talk(n: number, word: string): MessageInput[] {
  return Array.from({ length: n }, (_, i): MessageInput => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${word} message ${i + 1}`,
  }));
}

/** Longer than Engram keeps of one message: stored clipped. */
const LONG = `${"lorem ipsum ".repeat(12_500)}end`;

// --- What Engram answers, as the SDK passes it on ---

/** An isError refusal: the SDK throws its JSON body as the message, with no status. */
const refusal = (error: string, message = error) => new EngramError(JSON.stringify({ error, message }));
const httpError = (status: number) => new EngramError("", "undefined", status);
const rateLimit = () => httpError(429);
const paused = () => refusal("writes_paused", "Paused for maintenance.");
const planLimit = () => refusal("message_limit_exceeded", "This plan's message limit is reached.");
const full = () => refusal("storage_full", "Your Engram memory is full.");
const network = () => new EngramError("Network error: fetch failed");
const serverError = () => httpError(500);
const timeout = () => new TimeoutError();
const auth = () => new AuthenticationError();
const moved = () =>
  refusal(
    "import_moved",
    "This conversation has changed since the import planned what to send to it: another import may be adding to it. " +
      "Nothing from this request was saved; run the import again to pick up where the conversation is now.",
  );
const gone = () => refusal("conversation_not_found", "No conversation with that id exists in this account.");
const notFound = () => new EngramError('{"error":"Conversation not found"}');

type Step = (() => Error) | undefined;
/** A hook that throws the nth step's error on the nth call, and lets the rest through. */
const script =
  (...steps: Step[]) =>
  (n: number) => {
    const step = steps[n - 1];
    if (step) throw step();
  };

interface Row {
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface FakeConversation {
  id: string;
  title: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  rows: Row[];
}

/**
 * The parts of Engram an import talks to. Stores a batch the way the
 * worker's appendMessages does: bounded, the cursor taken off its last
 * message and recorded on the conversation, and refused whole when it
 * doesn't start where the conversation's import is.
 */
class FakeEngram {
  clock = START;
  private ids = 0;
  readonly conversations = new Map<string, FakeConversation>();
  private readonly byFingerprint = new Map<string, string>();
  readonly creates: CreateConversationParams[] = [];
  readonly gets: GetConversationParams[] = [];
  readonly stores: StoreParams[] = [];
  /** Answer create_conversation without message_count, as an older Engram does. */
  omitCount = false;
  /** Leave message bodies out, as an account's privacy setting can. */
  hideBodies = false;
  /** Hooks, each told how many calls of its kind there have been, this one included. */
  on: {
    create?: (n: number) => void;
    get?: (n: number, id: string) => void;
    store?: (n: number, req: StoreParams) => void;
    /** After the request is stored, before its answer. */
    stored?: (n: number, req: StoreParams) => void;
  } = {};

  tick(ms = 1000): number {
    this.clock += ms;
    return this.clock;
  }

  async createConversation(params: CreateConversationParams = {}): Promise<CreateConversationResponse> {
    this.creates.push(structuredClone(params));
    this.on.create?.(this.creates.length);
    const fp = params.metadata?.import_fingerprint;
    const found = typeof fp === "string" ? this.byFingerprint.get(fp) : undefined;
    if (found) {
      const c = this.conversation(found);
      return { conversationId: found, existing: true, ...(this.omitCount ? {} : { messageCount: c.rows.length }) };
    }
    return { conversationId: this.make(params).id };
  }

  async getConversation(params: string | GetConversationParams): Promise<GetConversationResponse> {
    const p = typeof params === "string" ? { conversationId: params } : params;
    this.gets.push({ ...p });
    this.on.get?.(this.gets.length, p.conversationId);
    const c = this.conversations.get(p.conversationId);
    if (!c) throw notFound();
    const limit = Math.min(p.messageLimit ?? 100, 500);
    const offset = p.messageOffset ?? 0;
    const messages = c.rows.slice(offset, offset + limit).map(
      (r, i): Message => ({
        id: `msg_${offset + i + 1}`,
        conversationId: c.id,
        role: r.role,
        content: this.hideBodies ? (undefined as unknown as string) : r.content,
        toolCallId: null,
        toolName: null,
        sequence: offset + i + 1,
        metadata: structuredClone(r.metadata),
        createdAt: r.createdAt,
      }),
    );
    return {
      conversation: {
        id: c.id,
        title: c.title,
        agentId: null,
        tags: [],
        metadata: structuredClone(c.metadata),
        messageCount: c.rows.length,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      },
      messages,
    };
  }

  async store(req: StoreParams): Promise<StoreResponse> {
    this.stores.push(structuredClone(req));
    const n = this.stores.length;
    this.on.store?.(n, req);
    const appended = this.apply(req);
    this.on.stored?.(n, req);
    return { appended, messageIds: [] };
  }

  /** Store a request's messages, as appendMessages does. */
  apply(req: StoreParams): number {
    const c = this.conversations.get(req.conversationId);
    if (!c) throw gone();
    const { messages, cursor } = server.takeImportCursor(
      req.messages.map((m) => ({ ...m, content: boundContent(m.content) })),
    );
    if (
      cursor &&
      !server.importStartsAt(
        { metadata: JSON.stringify(c.metadata), message_count: c.rows.length },
        cursor.next - messages.length,
      )
    ) {
      throw moved();
    }
    const t = this.tick();
    for (const m of messages) {
      c.rows.push({ role: m.role, content: m.content, metadata: m.metadata ?? {}, createdAt: iso(t) });
    }
    if (cursor) c.metadata = { ...c.metadata, import_cursor: cursor };
    c.updatedAt = sqlTime(t);
    return messages.length;
  }

  private make(params: CreateConversationParams): FakeConversation {
    const t = sqlTime(this.tick());
    const c: FakeConversation = {
      id: `conv_${++this.ids}`,
      title: params.title ?? null,
      metadata: structuredClone(params.metadata ?? {}),
      createdAt: t,
      updatedAt: t,
      rows: [],
    };
    this.conversations.set(c.id, c);
    const fp = params.metadata?.import_fingerprint;
    if (typeof fp === "string") this.byFingerprint.set(fp, c.id);
    return c;
  }

  /** The user deletes the conversation. */
  remove(id: string): void {
    this.conversations.delete(id);
    for (const [fp, cid] of this.byFingerprint) if (cid === id) this.byFingerprint.delete(fp);
  }

  /** The user deletes messages (by position): the conversation's update time moves. */
  deleteRows(id: string, positions: number[]): void {
    const c = this.conversation(id);
    const drop = new Set(positions);
    c.rows = c.rows.filter((_, i) => !drop.has(i));
    c.updatedAt = sqlTime(this.tick(60_000));
  }

  /** A conversation an import made before there were cursors: batches of 100, none marked. */
  seedLegacy(fingerprint: string, rows: readonly MessageInput[], title = "Alpha"): string {
    const { id } = this.make({
      title,
      metadata: { source: "claude-export", original_create_time: "2026-01-01T00:00:00Z", import_fingerprint: fingerprint },
    });
    for (let i = 0; i < rows.length; i += 100) this.apply({ conversationId: id, messages: rows.slice(i, i + 100) });
    return id;
  }

  copy(id: string): { role: MessageRole; content: string }[] {
    return this.conversation(id).rows.map(({ role, content }) => ({ role, content }));
  }

  conversation(id: string): FakeConversation {
    const c = this.conversations.get(id);
    if (!c) throw new Error(`no conversation ${id}`);
    return c;
  }
}

interface Source {
  uuid: string;
  name: string;
  messages: MessageInput[];
}

const ALPHA: Source = { uuid: "uuid-alpha", name: "Alpha", messages: talk(250, "Alpha") };
const BRAVO: Source = { uuid: "uuid-bravo", name: "Bravo", messages: talk(3, "Bravo") };
const A5: Source = { ...ALPHA, messages: talk(5, "Alpha") };
const chats = (n: number): Source[] =>
  Array.from({ length: n }, (_, i) => ({ uuid: `uuid-chat-${i + 1}`, name: `Chat ${i + 1}`, messages: talk(3, "Chat") }));

const AGAIN = "run the same command again: it skips what's already imported and sends only what's missing.";
const LEFT_HOW =
  "what Engram has doesn't match this file, so nothing was added. To replace Engram's copy with this file's, " +
  "delete it (everything in Engram's copy goes with it), then run the same command again:";

let dir: string;
let said: string[];
let waits: number[];

beforeEach(() => {
  said = [];
  waits = [];
  vi.spyOn(importTiming, "sleep").mockImplementation(async (ms: number) => {
    waits.push(ms);
  });
  vi.spyOn(importTiming, "random").mockReturnValue(1);
  const hear = (...args: unknown[]) => {
    said.push(args.map(String).join(" ").replace(/\x1b\[[0-9;]*m/g, ""));
  };
  vi.spyOn(console, "log").mockImplementation(hear);
  vi.spyOn(console, "error").mockImplementation(hear);
  dir = mkdtempSync(join(tmpdir(), "import-resume-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** A Claude export of these conversations. */
function exportFile(...convs: Source[]): string {
  const file = join(dir, "conversations.json");
  writeFileSync(
    file,
    JSON.stringify(
      convs.map((c) => ({
        uuid: c.uuid,
        name: c.name,
        created_at: "2026-01-01T00:00:00Z",
        chat_messages: c.messages.map((m) => ({ sender: m.role === "user" ? "human" : "assistant", text: m.content })),
      })),
    ),
  );
  return file;
}

async function run(fake: FakeEngram, file: string, flags: Record<string, string> = { force: "" }) {
  said.length = 0;
  await importHistory(fake as unknown as Engram, [file], flags);
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  const text = said.join("\n");
  return { text, lines: text.split("\n"), exitCode };
}

/** Import these conversations with the first one's second batch lost to the network: it has 100 messages. */
async function cutAfterFirstBatch(fake: FakeEngram, ...convs: Source[]): Promise<void> {
  fake.on = { store: script(undefined, network) };
  const first = await run(fake, exportFile(...convs));
  expect(first.lines[1]).toMatch(/— Network error: fetch failed \(100 messages of it saved first\)$/);
  fake.on = {};
}

const gotten = (fake: FakeEngram) => fake.gets.map((g) => [g.messageLimit, g.messageOffset]);

describe("the import cursor reads the same in the CLI and the worker", () => {
  const valid: [unknown, ImportCursor][] = [
    [{ v: 1, next: 100, digest: DIGEST }, { v: 1, next: 100, digest: DIGEST }],
    [{ v: 1, next: 1, digest: DIGEST }, { v: 1, next: 1, digest: DIGEST }],
    [
      { v: 1, next: Number.MAX_SAFE_INTEGER, digest: DIGEST },
      { v: 1, next: Number.MAX_SAFE_INTEGER, digest: DIGEST },
    ],
    [{ v: 1, next: 3, digest: DIGEST, extra: "dropped" }, { v: 1, next: 3, digest: DIGEST }],
  ];
  const invalid: unknown[] = [
    null,
    undefined,
    JSON.stringify({ v: 1, next: 3, digest: DIGEST }),
    3,
    [{ v: 1, next: 3, digest: DIGEST }],
    { v: 2, next: 3, digest: DIGEST },
    { v: "1", next: 3, digest: DIGEST },
    { v: 1, next: 0, digest: DIGEST },
    { v: 1, next: -1, digest: DIGEST },
    { v: 1, next: 1.5, digest: DIGEST },
    { v: 1, next: "3", digest: DIGEST },
    { v: 1, next: Number.NaN, digest: DIGEST },
    { v: 1, next: Number.POSITIVE_INFINITY, digest: DIGEST },
    { v: 1, next: 2 ** 53, digest: DIGEST },
    { v: 1, next: 3, digest: DIGEST.toUpperCase() },
    { v: 1, next: 3, digest: DIGEST.slice(1) },
    { v: 1, next: 3, digest: `${DIGEST}0` },
    { v: 1, next: 3, digest: `${DIGEST}\n` },
    { v: 1, next: 3, digest: 123 },
    { v: 1, next: 3 },
  ];

  it("accepts exactly the cursors the CLI writes, keeping only their fields", () => {
    for (const [value, want] of valid) {
      expect(parseImportCursor(value), JSON.stringify(value)).toEqual(want);
      expect(server.parseImportCursor(value), JSON.stringify(value)).toEqual(want);
    }
  });

  it("refuses anything else, on both sides", () => {
    for (const [i, value] of invalid.entries()) {
      expect(parseImportCursor(value), `case ${i}`).toBeNull();
      expect(server.parseImportCursor(value), `case ${i}`).toBeNull();
    }
  });

  it("is taken off the batch markBatch makes, and recorded from its last message", () => {
    const batch = talk(3, "Alpha");
    const cursor: ImportCursor = { v: 1, next: 3, digest: prefixDigest(batch, 3) };
    const marked = markBatch(batch, cursor);
    const taken = server.takeImportCursor(marked);
    expect(taken.cursor).toEqual(cursor);
    expect(taken.messages[0]).toBe(marked[0]);
    expect(taken.messages[1]).toBe(marked[1]);
    expect(taken.messages[2]).toEqual({ ...batch[2], metadata: {} });
  });

  it("is dropped, never kept on the message, where no batch can end at it", () => {
    const batch = talk(3, "Alpha");
    const short = server.takeImportCursor(markBatch(batch, { v: 1, next: 2, digest: DIGEST }));
    expect(short.cursor).toBeNull();
    expect(short.messages[2].metadata).toEqual({});

    const early = server.takeImportCursor([
      { ...batch[0], metadata: { import_cursor: { v: 1, next: 3, digest: DIGEST }, keep: true } },
      batch[1],
      batch[2],
    ]);
    expect(early.cursor).toBeNull();
    expect(early.messages[0].metadata).toEqual({ keep: true });
  });

  it("can count more messages than the batch: the ones stored before it", () => {
    const taken = server.takeImportCursor(markBatch(talk(3, "Alpha"), { v: 1, next: 250, digest: DIGEST }));
    expect(taken.cursor).toEqual({ v: 1, next: 250, digest: DIGEST });
  });
});

describe("ImportDigest covers roles and lengths, never words", () => {
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const m = (role: MessageRole, content: string): MessageInput => ({ role, content });

  it("is pinned: a change to it strands every cursor already recorded", () => {
    expect(prefixDigest([m("user", "hello"), m("assistant", "hey")], 2)).toBe(
      sha("engram-import-cursor/1\nuser 5\nassistant 3\n"),
    );
    expect(prefixDigest([], 0)).toBe(sha("engram-import-cursor/1\n"));
    expect(prefixDigest([m("user", "hello")], 0)).toBe(sha("engram-import-cursor/1\n"));
  });

  it("can't tell two secrets of the same length apart", () => {
    expect(prefixDigest([m("user", "my pin is 4821")], 1)).toBe(prefixDigest([m("user", "my pin is 9037")], 1));
  });

  it("changes with a role, a length, or the order", () => {
    const base = prefixDigest([m("user", "hi"), m("assistant", "hey")], 2);
    expect(prefixDigest([m("assistant", "hi"), m("assistant", "hey")], 2)).not.toBe(base);
    expect(prefixDigest([m("user", "hi!"), m("assistant", "hey")], 2)).not.toBe(base);
    expect(prefixDigest([m("assistant", "hey"), m("user", "hi")], 2)).not.toBe(base);
  });

  it("can be read between messages", () => {
    const messages = [m("user", "a"), m("assistant", "bb")];
    const digest = new ImportDigest();
    digest.add(messages[0]);
    expect(digest.hex()).toBe(prefixDigest(messages, 1));
    digest.add(messages[1]);
    expect(digest.hex()).toBe(prefixDigest(messages, 2));
  });
});

describe("markBatch", () => {
  const cursor: ImportCursor = { v: 1, next: 2, digest: DIGEST };

  it("marks a copy of the last message, keeping its metadata, and leaves the batch as it was", () => {
    const batch: MessageInput[] = [
      { role: "user", content: "a" },
      { role: "assistant", content: "b", metadata: { keep: 1 } },
    ];
    const before = structuredClone(batch);
    const marked = markBatch(batch, cursor);
    expect(marked[0]).toBe(batch[0]);
    expect(marked[1]).toEqual({ role: "assistant", content: "b", metadata: { keep: 1, import_cursor: cursor } });
    expect(batch).toEqual(before);
  });

  it("marks a last message that had no metadata", () => {
    expect(markBatch([{ role: "user", content: "a" }], cursor)[0].metadata).toEqual({ import_cursor: cursor });
  });
});

describe("serverTime", () => {
  it("reads the times Engram writes, as UTC", () => {
    const at = Date.UTC(2026, 10, 12, 20, 55, 44);
    expect(serverTime("2026-11-12 20:55:44")).toBe(at);
    expect(serverTime("2026-11-12T20:55:44Z")).toBe(at);
    expect(serverTime("2026-11-12T20:55:44.123Z")).toBe(at + 123);
    expect(serverTime("2026-11-12T20:55:44.5Z")).toBe(at + 500);
    expect(serverTime("2026-11-12 20:55:44.25")).toBe(at + 250);
  });

  it("reads them as UTC on a machine whose clock is set to another zone", () => {
    vi.stubEnv("TZ", "Asia/Kolkata");
    try {
      const at = Date.UTC(2026, 10, 12, 20, 55, 44);
      // The zone took: this machine's clock reads 5 1/2 hours past UTC.
      expect(new Date(at).getHours()).toBe(2);
      expect(serverTime("2026-11-12 20:55:44")).toBe(at);
      expect(serverTime("2026-11-12 20:55:44.25")).toBe(at + 250);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reads nothing else", () => {
    for (const value of [
      "",
      "yesterday",
      null,
      undefined,
      Date.UTC(2026, 10, 12),
      "2026-11-12",
      "2026-11-12 20:55",
      "2026-13-45 99:99:99",
      "2026-11-12T20:55:44+01:00",
      " 2026-11-12 20:55:44",
      "+002026-11-12 20:55:44",
      "-002026-11-12 20:55:44",
      "2026-11-12 20:55:44.1234Z",
    ]) {
      expect(serverTime(value), String(value)).toBeNull();
    }
  });
});

function described(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "conv_1",
    title: "Alpha",
    agentId: null,
    tags: [],
    metadata: {},
    messageCount: 0,
    createdAt: "2026-11-01 00:00:00",
    updatedAt: "2026-11-01 00:00:00",
    ...over,
  };
}

describe("planResume", () => {
  const source = talk(5, "Alpha");
  const at = (next: number, digest = prefixDigest(source, next)) => ({ import_cursor: { v: 1, next, digest } });

  it("goes by the cursor, whatever the count says: deleted messages don't come back", () => {
    for (const messageCount of [0, 2, 3, 99]) {
      expect(planResume(described({ metadata: at(3), messageCount }), source)).toEqual({ kind: "send", from: 3 });
    }
    expect(planResume(described({ metadata: at(5), messageCount: 1 }), source)).toEqual({ kind: "done" });
  });

  it("leaves a conversation whose file no longer begins with what was sent", () => {
    expect(planResume(described({ metadata: at(6, DIGEST), messageCount: 6 }), source)).toEqual({ kind: "changed" });
    expect(planResume(described({ metadata: at(3, DIGEST), messageCount: 3 }), source)).toEqual({ kind: "changed" });
    const edited = source.map((m, i) => (i === 1 ? { ...m, content: `${m.content}, edited` } : m));
    expect(planResume(described({ metadata: at(3), messageCount: 3 }), edited)).toEqual({ kind: "changed" });
  });

  it("checks what Engram has where there's no cursor it can read", () => {
    const odd: unknown[] = [{ import_cursor: { v: 1, next: "3", digest: DIGEST } }, "x", null, []];
    for (const metadata of odd) {
      expect(
        planResume(described({ metadata: metadata as Record<string, unknown>, messageCount: 3 }), source),
      ).toEqual({ kind: "check" });
    }
    expect(planResume(described({ messageCount: 2 }), source)).toEqual({ kind: "check" });
  });

  it("is done where Engram has as many messages as the file, or more", () => {
    expect(planResume(described({ messageCount: 5 }), source)).toEqual({ kind: "done" });
    expect(planResume(described({ messageCount: 6 }), source)).toEqual({ kind: "done" });
  });

  it("leaves it where the count can't be read", () => {
    for (const messageCount of [Number.NaN, -1, 1.5, undefined]) {
      expect(
        planResume(described({ messageCount: messageCount as unknown as number }), source),
        String(messageCount),
      ).toEqual({ kind: "kept", stored: 0 });
    }
  });

  it("sends all of an empty conversation nothing was ever written to, and leaves one emptied by deletes", () => {
    expect(planResume(described(), source)).toEqual({ kind: "send", from: 0 });
    expect(planResume(described({ updatedAt: "2026-11-01 00:01:00" }), source)).toEqual({ kind: "kept", stored: 0 });
    expect(planResume(described({ createdAt: "whenever", updatedAt: "whenever" }), source)).toEqual({
      kind: "kept",
      stored: 0,
    });
  });
});

function storedRows(rows: readonly MessageInput[], createdAt: string): Message[] {
  return rows.map((r, i) => ({
    id: `msg_${i + 1}`,
    conversationId: "conv_1",
    role: r.role,
    content: r.content,
    toolCallId: null,
    toolName: null,
    sequence: i + 1,
    metadata: {},
    createdAt,
  }));
}

describe("planFromStored", () => {
  const source = talk(5, "Alpha");
  const last = iso(START);
  const conv = (messageCount: number, updatedAt = sqlTime(START)) => described({ messageCount, updatedAt });

  it("sends the rest where Engram has exactly the file's first messages, last written by the import", () => {
    expect(planFromStored(storedRows(source.slice(0, 3), last), conv(3), source)).toEqual({ kind: "send", from: 3 });
  });

  it("is done where Engram has them all", () => {
    expect(planFromStored(storedRows(source, last), conv(5), source)).toEqual({ kind: "done" });
  });

  it("leaves it where anything differs or can't be read", () => {
    const kept = (stored: number) => ({ kind: "kept", stored });
    expect(planFromStored([], conv(0), source)).toEqual(kept(0));
    expect(planFromStored(storedRows(source.slice(0, 3), last), conv(4), source)).toEqual(kept(3));
    const role = source.slice(0, 3).map((m, i) => (i === 1 ? { ...m, role: "user" as const } : m));
    expect(planFromStored(storedRows(role, last), conv(3), source)).toEqual(kept(3));
    const words = source.slice(0, 3).map((m, i) => (i === 2 ? { ...m, content: "something else" } : m));
    expect(planFromStored(storedRows(words, last), conv(3), source)).toEqual(kept(3));
    const hidden = storedRows(source.slice(0, 3), last).map((m) => ({ ...m, content: undefined as unknown as string }));
    expect(planFromStored(hidden, conv(3), source)).toEqual(kept(3));
    expect(planFromStored(storedRows(source.slice(0, 3), "soon"), conv(3), source)).toEqual(kept(3));
    expect(planFromStored(storedRows(source.slice(0, 3), last), conv(3, "soon"), source)).toEqual(kept(3));
  });

  it("matches a message Engram clipped, and one with a secret taken out", () => {
    expect(LONG.length).toBeGreaterThan(MAX_MESSAGE_CONTENT_CHARS);
    const file: MessageInput[] = [
      { role: "user", content: LONG },
      { role: "assistant", content: "my key is FAKE-KEY-0000, keep it" },
      { role: "user", content: "thanks" },
    ];
    const stored = storedRows(
      [
        { role: "user", content: boundContent(LONG) },
        { role: "assistant", content: "my key is [REDACTED], keep it" },
      ],
      last,
    );
    expect(sameAsStored(boundContent(LONG), LONG)).toBe(false);
    expect(planFromStored(stored, conv(2), file)).toEqual({ kind: "send", from: 2 });
  });

  it("matches a picture an earlier import stored before Engram took pictures out of messages", () => {
    const png = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), Buffer.alloc(40)]).toString("base64");
    const picture = `here: data:image/png;base64,${png} what is it?`;
    expect(boundContent(picture)).not.toBe(picture);
    const file: MessageInput[] = [
      { role: "user", content: picture },
      { role: "assistant", content: "a picture" },
      { role: "user", content: "thanks" },
    ];
    // Stored as it was sent, and with its payload taken for a token and redacted.
    for (const kept of [picture, "here: data:image/png;base64,[REDACTED] what is it?"]) {
      const stored = storedRows([{ role: "user", content: kept }, file[1]], last);
      expect(planFromStored(stored, conv(2), file)).toEqual({ kind: "send", from: 2 });
    }
  });

  it("leaves it where something was written after the import's last append, a delete included", () => {
    const rows = storedRows(source.slice(0, 3), last);
    for (const ms of [SAME_WRITE_MS, -SAME_WRITE_MS]) {
      expect(planFromStored(rows, conv(3, iso(START + ms)), source)).toEqual({ kind: "send", from: 3 });
    }
    for (const ms of [SAME_WRITE_MS + 1, -SAME_WRITE_MS - 1, 60_000]) {
      expect(planFromStored(rows, conv(3, iso(START + ms)), source)).toEqual({ kind: "kept", stored: 3 });
    }
  });
});

describe("sameAsStored", () => {
  it("is plain equality where nothing was taken out", () => {
    expect(sameAsStored("abc", "abc")).toBe(true);
    expect(sameAsStored("abc", "abd")).toBe(false);
    expect(sameAsStored("abc", "abcd")).toBe(false);
    expect(sameAsStored("abcd", "abc")).toBe(false);
  });

  it("lets each stand-in cover one character or more, never none", () => {
    expect(sameAsStored("[REDACTED]", "x")).toBe(true);
    expect(sameAsStored("[REDACTED]", "")).toBe(false);
    expect(sameAsStored("key: [REDACTED]", "key: hunter2")).toBe(true);
    expect(sameAsStored("key: [REDACTED]", "key: ")).toBe(false);
    expect(sameAsStored("kay: [REDACTED]", "key: hunter2")).toBe(false);
    expect(sameAsStored("[REDACTED] is it", "hunter2 is it")).toBe(true);
    expect(sameAsStored("[REDACTED] is it", "hunter2 is not it")).toBe(false);
    expect(sameAsStored("a[REDACTED][REDACTED]b", "axyb")).toBe(true);
    expect(sameAsStored("a[REDACTED][REDACTED]b", "axb")).toBe(false);
  });

  it("never lets the text before a stand-in and the text after it overlap", () => {
    expect(sameAsStored("ab[REDACTED]ba", "aba")).toBe(false);
    expect(sameAsStored("ab[REDACTED]ba", "ab-ba")).toBe(true);
  });

  it("finds the text between stand-ins in order", () => {
    const stored = "x[REDACTED]mid[VAULT:vlt_1]y";
    expect(sameAsStored(stored, "x123mid456y")).toBe(true);
    expect(sameAsStored(stored, "x123mi456y")).toBe(false);
    expect(sameAsStored(stored, "xmid456y")).toBe(false);
    expect(sameAsStored(stored, "x123mid y")).toBe(true);
    expect(sameAsStored(stored, "x123midy")).toBe(false);
    expect(sameAsStored(stored, "x1mid2mid3y")).toBe(true);
    expect(sameAsStored("a[REDACTED]b[REDACTED]c", "a1b2b3c")).toBe(true);
    expect(sameAsStored("a[REDACTED]b[REDACTED]c", "a1c2b3c")).toBe(true);
    expect(sameAsStored("a[REDACTED]b[REDACTED]c", "abc")).toBe(false);
  });

  it("reads only Engram's stand-ins as stand-ins", () => {
    expect(sameAsStored("[VAULT:a b]", "secret")).toBe(false);
    expect(sameAsStored("[VAULT:a b]", "[VAULT:a b]")).toBe(true);
    expect(sameAsStored("[VAULT:]", "secret")).toBe(false);
    expect(sameAsStored(`[VAULT:${"v".repeat(101)}]`, "secret")).toBe(false);
    expect(sameAsStored(`[VAULT:${"v".repeat(100)}]`, "secret")).toBe(true);
    expect(sameAsStored("[redacted]", "secret")).toBe(false);
  });

  it("treats the text as text, never as a pattern", () => {
    expect(sameAsStored("a.*b[REDACTED](c)", "a.*bSECRET(c)")).toBe(true);
    expect(sameAsStored("a.*b[REDACTED](c)", "aXXbSECRET(c)")).toBe(false);
    expect(sameAsStored("^[REDACTED]$", "^x$")).toBe(true);
  });
});

describe("waiting out a rate limit or a pause", () => {
  it("waits 5 s doubling to a minute, each with jitter between half and all of it", () => {
    const attempts = [0, 1, 2, 3, 4, 10];
    expect(attempts.map((a) => rateLimitWait(a, 1))).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
    expect(attempts.map((a) => rateLimitWait(a, 0))).toEqual([2_500, 5_000, 10_000, 20_000, 30_000, 30_000]);
    expect(attempts.map((a) => rateLimitWait(a, 0.5))).toEqual([3_750, 7_500, 15_000, 30_000, 45_000, 45_000]);
    expect(rateLimitWait(0)).toBe(5_000);
    vi.mocked(importTiming.random).mockReturnValue(0);
    expect(rateLimitWait(0)).toBe(2_500);
  });

  it("gives up on a rate limit after 15 minutes of waiting, with the last refusal", async () => {
    const say = vi.fn();
    const refusals: Error[] = [];
    const err = await patientCaller(say)(async () => {
      const e = rateLimit();
      refusals.push(e);
      throw e;
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StillRefused);
    const still = err as StillRefused;
    expect(still.kind).toBe("rate_limit");
    expect(still.refusal).toBe(refusals[refusals.length - 1]);
    expect(still.message).toBe("Engram is still limiting how fast this account can save");
    expect(refusals).toHaveLength(18);
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000, ...Array<number>(13).fill(60_000)]);
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(PATIENCE_MS.rate_limit);
    expect(total + 60_000).toBeGreaterThan(PATIENCE_MS.rate_limit);
    expect(say.mock.calls).toEqual([["rate_limit"]]);
  });

  it("gives up on a pause after 30 minutes of waiting", async () => {
    let calls = 0;
    const err = await patientCaller(() => {})(async () => {
      calls++;
      throw paused();
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StillRefused);
    expect((err as StillRefused).kind).toBe("paused");
    expect((err as Error).message).toBe("Engram is still paused for maintenance");
    expect(calls).toBe(61);
    expect(waits).toEqual(Array<number>(60).fill(PAUSE_WAIT_MS));
    expect(60 * PAUSE_WAIT_MS).toBe(PATIENCE_MS.paused);
  });

  it("says each kind once per import, before the first wait for it", async () => {
    const heard: [string, number][] = [];
    const say = (kind: string) => heard.push([kind, waits.length]);
    const call = patientCaller(say);
    const fails = (...errors: (() => Error)[]) => {
      let n = 0;
      return async () => {
        const make = errors[n++];
        if (make) throw make();
        return "ok";
      };
    };
    await expect(call(fails(rateLimit, paused, rateLimit, paused))).resolves.toBe("ok");
    await expect(call(fails(rateLimit, paused))).resolves.toBe("ok");
    expect(heard).toEqual([
      ["rate_limit", 0],
      ["paused", 1],
    ]);
    await expect(patientCaller(say)(fails(paused))).resolves.toBe("ok");
    expect(heard[2]).toEqual(["paused", 6]);
  });

  it("starts its patience again with each call", async () => {
    const call = patientCaller(() => {});
    for (const _ of [1, 2]) {
      let n = 0;
      await expect(
        call(async () => {
          if (n++ < 17) throw rateLimit();
          return n;
        }),
      ).resolves.toBe(18);
    }
    expect(waits).toHaveLength(34);
  });

  it("throws every other failure at once, as it came", async () => {
    const call = patientCaller(() => {
      throw new Error("said something");
    });
    for (const make of [network, serverError, timeout, auth, moved, gone, notFound, planLimit, full]) {
      const e = make();
      await expect(
        call(async () => {
          throw e;
        }),
      ).rejects.toBe(e);
    }
    expect(waits).toEqual([]);
  });

  it("returns what the call does once it passes", async () => {
    let n = 0;
    await expect(
      patientCaller(() => {})(async () => {
        if (n++ < 2) throw rateLimit();
        return "stored";
      }),
    ).resolves.toBe("stored");
    expect(waits).toEqual([5_000, 10_000]);
  });
});

describe("isImportMoved", () => {
  it("reads Engram's refusal, and nothing else", () => {
    expect(isImportMoved(moved())).toBe(true);
    expect(isImportMoved('{"error":"import_moved"}')).toBe(true);
    expect(isImportMoved(new EngramError('{"error":"import_moved"}', "import_moved", 409))).toBe(false);
    expect(isImportMoved(new EngramError("import_moved"))).toBe(false);
    expect(isImportMoved(gone())).toBe(false);
    expect(isImportMoved(null)).toBe(false);
    expect(isImportMoved(undefined)).toBe(false);
  });
});

describe("engram import picks up where an earlier run stopped (engram#751)", () => {
  it("sends only what a cut-off conversation is missing, then nothing", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(undefined, network) };
    const first = await run(fake, exportFile(ALPHA, BRAVO));
    expect(first.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  ✗ [1/2] Alpha (250 msgs) — Network error: fetch failed (100 messages of it saved first)",
      "  ✓ [2/2] Bravo (3 msgs)",
      "",
      "Done. 1 imported, 103 messages, 1 failed.",
      "",
      `To retry what failed, ${AGAIN}`,
    ]);
    expect(first.exitCode).toBe(1);
    expect(fake.conversation("conv_2").metadata.import_cursor).toEqual({
      v: 1,
      next: 3,
      digest: prefixDigest(BRAVO.messages, 3),
    });

    fake.on = {};
    const again = await run(fake, exportFile(ALPHA, BRAVO));
    expect(again.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  ✓ [1/2] Alpha (250 msgs) — added the 150 messages Engram didn't have yet",
      "  ↷ already imported [2/2] Bravo (3 msgs)",
      "",
      "Done. 0 imported, 150 messages, 1 updated, 1 already imported.",
    ]);
    expect(again.exitCode).toBeUndefined();
    expect(fake.stores[3].messages[99].metadata?.import_cursor).toMatchObject({ next: 200 });
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
    expect(fake.copy("conv_2")).toEqual(BRAVO.messages);

    const [gets, stores] = [fake.gets.length, fake.stores.length];
    const third = await run(fake, exportFile(ALPHA, BRAVO));
    expect(third.lines.slice(-1)).toEqual(["Done. 0 imported, 0 messages, 2 already imported."]);
    expect([fake.gets.length, fake.stores.length]).toEqual([gets, stores]);
  });

  it("marks the last message of each batch with the file's own lengths, and Engram keeps it off the message", async () => {
    const source = talk(150, "Wire");
    source[10] = { role: "user", content: LONG };
    const wire: Source = { uuid: "uuid-wire", name: "Wire", messages: source };
    const fake = new FakeEngram();
    await cutAfterFirstBatch(fake, wire);
    const again = await run(fake, exportFile(wire));
    expect(again.lines[1]).toBe("  ✓ [1/1] Wire (150 msgs) — added the 50 messages Engram didn't have yet");

    const sent = fake.stores.map((s) => s.messages);
    expect(sent.map((b) => b.length)).toEqual([100, 50, 50]);
    expect(sent[2]).toEqual(sent[1]);
    for (const [batch, next] of [
      [sent[0], 100],
      [sent[2], 150],
    ] as const) {
      expect(batch.slice(0, -1).every((m) => m.metadata === undefined)).toBe(true);
      expect(batch[batch.length - 1].metadata).toEqual({
        import_cursor: { v: 1, next, digest: prefixDigest(source, next) },
      });
    }
    expect(sent[0][10].content).toBe(boundContent(LONG));
    const asSent = source.map((m) => ({ ...m, content: boundContent(m.content) }));
    expect(prefixDigest(source, 100)).not.toBe(prefixDigest(asSent, 100));

    const c = fake.conversation("conv_1");
    expect(c.rows.every((r) => Object.keys(r.metadata).length === 0)).toBe(true);
    expect(c.metadata).toEqual({
      source: "claude-export",
      original_create_time: "2026-01-01T00:00:00Z",
      import_fingerprint: "claude:uuid-wire",
      import_cursor: { v: 1, next: 150, digest: prefixDigest(source, 150) },
    });
    expect(fake.copy("conv_1")).toEqual(asSent);
  });

  it("never brings back a message the user deleted, or sends one twice", async () => {
    const fake = new FakeEngram();
    await cutAfterFirstBatch(fake, ALPHA);
    fake.deleteRows("conv_1", [10, 11]);
    const again = await run(fake, exportFile(ALPHA));
    expect(again.lines[1]).toBe("  ✓ [1/1] Alpha (250 msgs) — added the 150 messages Engram didn't have yet");
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages.filter((_, i) => i !== 10 && i !== 11));

    fake.deleteRows("conv_1", [247]);
    const stores = fake.stores.length;
    const third = await run(fake, exportFile(ALPHA));
    expect(third.lines[1]).toBe("  ↷ already imported [1/1] Alpha (250 msgs)");
    expect(fake.stores.length).toBe(stores);
    expect(fake.copy("conv_1")).toHaveLength(247);
  });

  it("adds what a conversation said after it was imported", async () => {
    const fake = new FakeEngram();
    await run(fake, exportFile(A5));
    const later: Source = { ...A5, messages: talk(8, "Alpha") };
    const again = await run(fake, exportFile(later));
    expect(again.lines[1]).toBe("  ✓ [1/1] Alpha (8 msgs) — added the 3 messages Engram didn't have yet");
    expect(fake.copy("conv_1")).toEqual(later.messages);
  });

  it("leaves a conversation whose file no longer begins with what was imported, and says how to replace it", async () => {
    const fake = new FakeEngram();
    await run(fake, exportFile(A5));
    const messages = talk(7, "Alpha");
    messages[2] = { ...messages[2], content: `${messages[2].content}, edited` };
    const stores = fake.stores.length;
    const again = await run(fake, exportFile({ ...A5, messages }));
    expect(again.lines).toEqual([
      "claude import (1 of 1 conversation)",
      "  ↷ left as it is [1/1] Alpha (7 msgs) — this file's copy of it differs from the one imported before",
      "",
      "Done. 0 imported, 0 messages, 1 left as it is.",
      "",
      `One conversation was left as it is: ${LEFT_HOW}`,
      "  Alpha",
      `    ${engramCommand("conversations delete conv_1 --force")}`,
    ]);
    expect(again.exitCode).toBeUndefined();
    expect(fake.stores.length).toBe(stores);
    expect(fake.copy("conv_1")).toEqual(A5.messages);
  });

  it("says how to replace each of several it left", async () => {
    const fake = new FakeEngram();
    const b5: Source = { ...BRAVO, messages: talk(5, "Bravo") };
    await run(fake, exportFile(A5, b5));
    const longer = (s: Source): Source => ({
      ...s,
      messages: talk(6, s.name).map((m, i) => (i === 0 ? { ...m, content: `${m.content}!` } : m)),
    });
    const again = await run(fake, exportFile(longer(A5), longer(b5)));
    expect(again.lines.slice(3)).toEqual([
      "",
      "Done. 0 imported, 0 messages, 2 left as they are.",
      "",
      `2 conversations were left as they are: ${LEFT_HOW}`,
      "  Alpha",
      `    ${engramCommand("conversations delete conv_1 --force")}`,
      "  Bravo",
      `    ${engramCommand("conversations delete conv_2 --force")}`,
    ]);
  });
});

describe("engram import finishes a conversation imported before there were cursors", () => {
  it("checks every message Engram has against the file, stand-ins and all, then sends the rest", async () => {
    const fake = new FakeEngram();
    const rows = ALPHA.messages
      .slice(0, 100)
      .map((m, i) => (i === 5 ? { ...m, content: m.content.replace("message", "[REDACTED]") } : m));
    const id = fake.seedLegacy("claude:uuid-alpha", rows);
    const r = await run(fake, exportFile(ALPHA));
    expect(r.lines[1]).toBe("  ✓ [1/1] Alpha (250 msgs) — added the 150 messages Engram didn't have yet");
    expect(gotten(fake)).toEqual([
      [1, 0],
      [500, 0],
    ]);
    expect(fake.conversation(id).metadata.import_cursor).toEqual({
      v: 1,
      next: 250,
      digest: prefixDigest(ALPHA.messages, 250),
    });
    expect(fake.copy(id)).toEqual([...rows, ...ALPHA.messages.slice(100)]);
  });

  it("reads past one page of messages", async () => {
    const fake = new FakeEngram();
    const long: Source = { uuid: "uuid-long", name: "Long", messages: talk(700, "Long") };
    const id = fake.seedLegacy("claude:uuid-long", long.messages.slice(0, 600), "Long");
    const r = await run(fake, exportFile(long));
    expect(r.lines[1]).toBe("  ✓ [1/1] Long (700 msgs) — added the 100 messages Engram didn't have yet");
    expect(gotten(fake)).toEqual([
      [1, 0],
      [500, 0],
      [500, 500],
    ]);
    expect(fake.copy(id)).toEqual(long.messages);
  });

  it("reads no further than the file goes, even while the conversation grows", async () => {
    const fake = new FakeEngram();
    const later = talk(1_000, "Long");
    const long: Source = { uuid: "uuid-long", name: "Long", messages: later.slice(0, 700) };
    const id = fake.seedLegacy("claude:uuid-long", later.slice(0, 600), "Long");
    // An import of a later export of it adds the rest while this one reads.
    fake.on = { get: (n) => void (n === 2 && fake.apply({ conversationId: id, messages: later.slice(600) })) };
    const r = await run(fake, exportFile(long));
    expect(r.lines[1]).toBe("  ↷ already imported [1/1] Long (700 msgs)");
    expect(gotten(fake)).toEqual([
      [1, 0],
      [500, 0],
      [500, 500],
    ]);
    expect(fake.stores).toEqual([]);
  });

  it("goes by the conversation as Engram describes it with the last messages it reads", async () => {
    const fake = new FakeEngram();
    const id = fake.seedLegacy("claude:uuid-alpha", ALPHA.messages.slice(0, 100));
    // An older import of the same file stores its next batch between this one's reads.
    fake.on = { get: (n) => void (n === 2 && fake.apply({ conversationId: id, messages: ALPHA.messages.slice(100, 200) })) };
    const r = await run(fake, exportFile(ALPHA));
    expect(r.lines[1]).toBe("  ✓ [1/1] Alpha (250 msgs) — added the 50 messages Engram didn't have yet");
    expect(fake.copy(id)).toEqual(ALPHA.messages);
  });

  it.each([
    ["a message that differs", (fake: FakeEngram, id: string) => {
      fake.conversation(id).rows[50].content = "something else entirely";
    }, 100],
    ["its last message deleted", (fake: FakeEngram, id: string) => fake.deleteRows(id, [99]), 99],
    ["bodies Engram won't show", (fake: FakeEngram) => {
      fake.hideBodies = true;
    }, 100],
  ])("leaves it as it is with %s", async (_, change, stored) => {
    const fake = new FakeEngram();
    const id = fake.seedLegacy("claude:uuid-alpha", ALPHA.messages.slice(0, 100));
    change(fake, id);
    const before = fake.copy(id);
    const r = await run(fake, exportFile(ALPHA));
    expect(r.lines[1]).toBe(
      `  ↷ left as it is [1/1] Alpha (250 msgs) — Engram has ${stored} messages of it that can't be matched to this file's first ones`,
    );
    expect(fake.stores).toEqual([]);
    expect(fake.copy(id)).toEqual(before);
  });

  it("sends all of an empty conversation nothing was written to, and leaves one the user emptied", async () => {
    const untouched = new FakeEngram();
    const id = untouched.seedLegacy("claude:uuid-alpha", []);
    const r = await run(untouched, exportFile(A5));
    expect(r.lines[1]).toBe("  ✓ [1/1] Alpha (5 msgs) — added the 5 messages Engram didn't have yet");
    expect(untouched.copy(id)).toEqual(A5.messages);

    const emptied = new FakeEngram();
    const id2 = emptied.seedLegacy("claude:uuid-alpha", A5.messages.slice(0, 2));
    emptied.deleteRows(id2, [0, 1]);
    const left = await run(emptied, exportFile(A5));
    expect(left.lines[1]).toBe(
      "  ↷ left as it is [1/1] Alpha (5 msgs) — Engram's copy is empty, but was changed after the import made it",
    );
    expect(emptied.stores).toEqual([]);
  });
});

describe("engram import when Engram refuses or can't be reached", () => {
  it("waits out rate limits and pauses, saying so once each, and loses nothing", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(rateLimit, rateLimit, undefined, paused, undefined, rateLimit, undefined) };
    const r = await run(fake, exportFile(ALPHA));
    expect(r.lines).toEqual([
      "claude import (1 of 1 conversation)",
      "  Engram is limiting how fast this account can save: slowing down and trying again…",
      "  Engram paused saving for maintenance: waiting, and nothing is lost meanwhile…",
      "  ✓ [1/1] Alpha (250 msgs)",
      "",
      "Done. 1 imported, 250 messages.",
    ]);
    expect(waits).toEqual([5_000, 10_000, PAUSE_WAIT_MS, 5_000]);
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });

  it("stops after waiting too long, and a later run finishes", async () => {
    const fake = new FakeEngram();
    fake.on = {
      store: () => {
        throw rateLimit();
      },
    };
    const r = await run(fake, exportFile(A5, BRAVO));
    expect(r.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  Engram is limiting how fast this account can save: slowing down and trying again…",
      "  ✗ [1/2] Alpha (5 msgs) — Engram is still limiting how fast this account can save after 15 minutes of waiting",
      "",
      "Stopped. 0 imported, 0 messages, 1 failed.",
      "",
      `Later, ${AGAIN}`,
    ]);
    expect(r.exitCode).toBe(1);
    expect(fake.creates).toHaveLength(1);
    expect(waits).toHaveLength(17);
    expect(fake.stores).toHaveLength(18);

    fake.on = {};
    const again = await run(fake, exportFile(A5, BRAVO));
    expect(again.lines.slice(1)).toEqual([
      "  ✓ [1/2] Alpha (5 msgs) — added the 5 messages Engram didn't have yet",
      "  ✓ [2/2] Bravo (3 msgs)",
      "",
      "Done. 1 imported, 8 messages, 1 updated.",
    ]);
  });

  it("stops at a plan limit, and a later run finishes", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(undefined, planLimit) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  ✗ [1/2] Alpha (250 msgs) — This plan's message limit is reached. (100 messages of it saved first)",
      "",
      "Hit a plan limit: upgrade at https://getengram.app/pricing for more.",
      "",
      "Stopped. 0 imported, 100 messages, 1 failed.",
      "",
      `Once you've upgraded, ${AGAIN}`,
    ]);
    expect(r.exitCode).toBe(1);
    expect(fake.creates).toHaveLength(1);

    fake.on = {};
    const again = await run(fake, exportFile(ALPHA, BRAVO));
    expect(again.lines.slice(-1)).toEqual(["Done. 1 imported, 153 messages, 1 updated."]);
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });

  it("stops when Engram refuses the key", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(auth) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  ✗ [1/2] Alpha (250 msgs) — Engram refused this API key: Invalid or missing API key",
      "",
      "Stopped. 0 imported, 0 messages, 1 failed.",
      "",
      `Once the key works (${engramCommand("login")} makes a new one), ${AGAIN}`,
    ]);
    expect(fake.creates).toHaveLength(1);
  });

  it("stops when memory is full, keeping what was imported", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(undefined, full) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines).toEqual([
      "claude import (2 of 2 conversations)",
      "  ✗ [1/2] Alpha (250 msgs) — memory full (100 messages of it saved first)",
      "",
      "Your Engram memory is full.",
      "",
      "Stopped. 0 imported, 100 messages, 1 failed.",
      "",
      `Once there's room, ${AGAIN} Everything imported stays saved.`,
    ]);
    expect(r.exitCode).toBe(1);
  });

  it("goes on past a conversation another import is adding to", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(moved, moved, moved) };
    const r = await run(fake, exportFile(...chats(4)));
    const why = "it changed while this import ran: another import may be adding to it";
    expect(r.lines).toEqual([
      "claude import (4 of 4 conversations)",
      `  ✗ [1/4] Chat 1 (3 msgs) — ${why}`,
      `  ✗ [2/4] Chat 2 (3 msgs) — ${why}`,
      `  ✗ [3/4] Chat 3 (3 msgs) — ${why}`,
      "  ✓ [4/4] Chat 4 (3 msgs)",
      "",
      "Done. 1 imported, 3 messages, 3 failed.",
      "",
      `To retry what failed, ${AGAIN}`,
    ]);
  });

  it("stops after three conversations in a row Engram can't be reached for", async () => {
    const fake = new FakeEngram();
    fake.on = { store: script(network, network, undefined, timeout, serverError, network) };
    const r = await run(fake, exportFile(...chats(7)));
    expect(r.lines).toEqual([
      "claude import (7 of 7 conversations)",
      "  ✗ [1/7] Chat 1 (3 msgs) — Network error: fetch failed",
      "  ✗ [2/7] Chat 2 (3 msgs) — Network error: fetch failed",
      "  ✓ [3/7] Chat 3 (3 msgs)",
      "  ✗ [4/7] Chat 4 (3 msgs) — Request timed out",
      "  ✗ [5/7] Chat 5 (3 msgs) — Engram answered HTTP 500",
      "  ✗ [6/7] Chat 6 (3 msgs) — Network error: fetch failed",
      "",
      "3 conversations in a row couldn't be saved: Engram can't be reached, or is having a problem.",
      "",
      "Stopped. 1 imported, 3 messages, 5 failed.",
      "",
      `Once Engram can be reached, ${AGAIN}`,
    ]);
    expect(fake.creates).toHaveLength(6);
  });

  it.each([
    ["another import got there first", moved],
    ["the conversation is gone", gone],
    ["the request is too large", () => httpError(413)],
  ])("counts any answer from Engram as reaching it: %s", async (_, answer) => {
    const fake = new FakeEngram();
    fake.on = { store: script(network, network, answer, network, network) };
    const r = await run(fake, exportFile(...chats(6)));
    expect(r.lines.slice(-3)).toEqual(["Done. 1 imported, 3 messages, 5 failed.", "", `To retry what failed, ${AGAIN}`]);
    expect(fake.creates).toHaveLength(6);
  });

  it("goes on past a conversation deleted while it ran", async () => {
    const before = new FakeEngram();
    await cutAfterFirstBatch(before, ALPHA, BRAVO);
    before.on = { get: (_, id) => before.remove(id) };
    const r = await run(before, exportFile(ALPHA, BRAVO));
    expect(r.lines.slice(1, 5)).toEqual([
      "  ✗ [1/2] Alpha (250 msgs) — it was deleted from Engram while this import ran",
      "  ↷ already imported [2/2] Bravo (3 msgs)",
      "",
      "Done. 0 imported, 0 messages, 1 already imported, 1 failed.",
    ]);

    const during = new FakeEngram();
    during.on = { stored: (n, req) => (n === 1 ? during.remove(req.conversationId) : undefined) };
    const r2 = await run(during, exportFile(ALPHA, BRAVO));
    expect(r2.lines.slice(1, 5)).toEqual([
      "  ✗ [1/2] Alpha (250 msgs) — it was deleted from Engram while this import ran (100 messages of it saved first)",
      "  ✓ [2/2] Bravo (3 msgs)",
      "",
      "Done. 1 imported, 103 messages, 1 failed.",
    ]);
  });

  it("sends a batch whose answer was lost only if Engram doesn't have it", async () => {
    const fake = new FakeEngram();
    fake.on = { stored: script(undefined, timeout) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines[1]).toBe("  ✗ [1/2] Alpha (250 msgs) — Request timed out (100 messages of it saved first)");

    fake.on = {};
    const again = await run(fake, exportFile(ALPHA, BRAVO));
    expect(again.lines.slice(1)).toEqual([
      "  ✓ [1/2] Alpha (250 msgs) — added the 50 messages Engram didn't have yet",
      "  ↷ already imported [2/2] Bravo (3 msgs)",
      "",
      "Done. 0 imported, 50 messages, 1 updated, 1 already imported.",
    ]);
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });

  it("never stores a batch twice when two imports send it", async () => {
    const fake = new FakeEngram();
    fake.on = { store: (n, req) => (n === 2 ? void fake.apply(req) : undefined) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines[1]).toBe(
      "  ✗ [1/2] Alpha (250 msgs) — it changed while this import ran: another import may be adding to it (100 messages of it saved first)",
    );
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages.slice(0, 200));

    fake.on = {};
    const again = await run(fake, exportFile(ALPHA, BRAVO));
    expect(again.lines[1]).toBe("  ✓ [1/2] Alpha (250 msgs) — added the 50 messages Engram didn't have yet");
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });

  it("never stores a batch twice when its answer was a rate limit after all", async () => {
    const fake = new FakeEngram();
    fake.on = { stored: script(rateLimit) };
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines.slice(0, 4)).toEqual([
      "claude import (2 of 2 conversations)",
      "  Engram is limiting how fast this account can save: slowing down and trying again…",
      "  ✗ [1/2] Alpha (250 msgs) — it changed while this import ran: another import may be adding to it",
      "  ✓ [2/2] Bravo (3 msgs)",
    ]);
    expect(waits).toEqual([5_000]);
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages.slice(0, 100));

    fake.on = {};
    const again = await run(fake, exportFile(ALPHA, BRAVO));
    expect(again.lines[1]).toBe("  ✓ [1/2] Alpha (250 msgs) — added the 150 messages Engram didn't have yet");
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });

  it("waits out a rate limit on the read that plans a re-run", async () => {
    const fake = new FakeEngram();
    await cutAfterFirstBatch(fake, ALPHA);
    fake.on = { get: script(rateLimit) };
    const r = await run(fake, exportFile(ALPHA));
    expect(waits).toEqual([5_000]);
    expect(r.lines[2]).toBe("  ✓ [1/1] Alpha (250 msgs) — added the 150 messages Engram didn't have yet");
    expect(fake.copy("conv_1")).toEqual(ALPHA.messages);
  });
});

describe("engram import, otherwise", () => {
  it("writes nothing on a dry run", async () => {
    const fake = new FakeEngram();
    const r = await run(fake, exportFile(ALPHA, BRAVO), { "dry-run": "" });
    expect(r.lines).toEqual([
      "claude import (2 of 2 conversations, dry run)",
      "  would import [1/2] Alpha (250 msgs)",
      "  would import [2/2] Bravo (3 msgs)",
      "",
      "Done. 2 imported, 253 messages.",
      "Dry run — nothing was written. Re-run without --dry-run to import.",
    ]);
    expect([fake.creates.length, fake.gets.length, fake.stores.length]).toEqual([0, 0, 0]);
  });

  it("reads the cursor when Engram doesn't say how many messages it has", async () => {
    const fake = new FakeEngram();
    await run(fake, exportFile(ALPHA, BRAVO));
    fake.omitCount = true;
    const stores = fake.stores.length;
    const r = await run(fake, exportFile(ALPHA, BRAVO));
    expect(r.lines.slice(1, 3)).toEqual([
      "  ↷ already imported [1/2] Alpha (250 msgs)",
      "  ↷ already imported [2/2] Bravo (3 msgs)",
    ]);
    expect(gotten(fake)).toEqual([
      [1, 0],
      [1, 0],
    ]);
    expect(fake.stores.length).toBe(stores);
  });
});
