import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { EngramError, type Engram } from "@getengram/sdk";

// status.ts writes the REAL ~/.engram/status.json; exclusions.ts reads the
// real ~/.engram/config.json. Keep both off the developer's machine.
// classifyError stays real.
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
import { FIXED_KEY_FP, Syncer } from "../daemon/syncer.js";
import { RETRY_BASE_MS } from "../daemon/backoff.js";
import { SecretScrubber, type VaultLike } from "../daemon/scrubber.js";
import { MAX_MESSAGE_CONTENT_CHARS, TRUNCATION_MARKER } from "../message-bounds.js";
import { recordFailure, recordSuccess } from "../daemon/status.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#750: the daemon queued a screenshot in a tool result as megabytes
// of base64 and uploaded all of it, for Engram to replace it with a note on
// arrival (engram#386), and one message past the worker's 8 MB request
// limit was refused on every try, holding its conversation forever. These
// tests pin "file data is a note before it is queued, every body is
// bounded before it is sent, and a refusal for size never loses or
// reorders a message".

type StoreParams = { conversationId: string; messages: Array<{ content: string }> };

/** What the SDK throws for the worker's 413: its body isn't JSON. */
const tooLarge = () => new EngramError("Unexpected response format: Payload Too Large");

class FakeServer {
  /** Every send attempt, failed or not. */
  sends: StoreParams[] = [];
  stored = new Map<string, string[]>();
  /** Per-send failure, decided from what is being sent. */
  failWhen: ((p: StoreParams) => Error | null) | null = null;
  private seq = 0;

  client(): Engram {
    return {
      createConversation: async () => ({ conversationId: `conv_${++this.seq}` }),
      store: async (p: StoreParams) => {
        this.sends.push(p);
        const err = this.failWhen?.(p);
        if (err) throw err;
        const list = this.stored.get(p.conversationId) ?? [];
        list.push(...p.messages.map((m) => m.content));
        this.stored.set(p.conversationId, list);
        return { stored: p.messages.length };
      },
      deleteConversation: async () => {},
    } as unknown as Engram;
  }

  /** What the server holds for a session, via daemon.db's mapping. */
  copyOf(db: DaemonDb, sessionId: string): string[] | undefined {
    const conv = db.getConversationId(sessionId, FIXED_KEY_FP);
    return conv ? this.stored.get(conv) : undefined;
  }

  /** Every message the server received, in order, failed sends included. */
  get received(): string[] {
    return this.sends.flatMap((p) => p.messages.map((m) => m.content));
  }
}

/** A vault whose secrets the test sets. */
class FakeVault implements VaultLike {
  constructor(public secrets: Record<string, string>) {}
  async list(): Promise<Array<{ name: string }>> {
    return Object.keys(this.secrets).map((name) => ({ name }));
  }
  async get(name: string): Promise<string | null> {
    return this.secrets[name] ?? null;
  }
}

/** A PNG of `size` bytes, base64-encoded: the signature, then filler. */
const png = (size: number) =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(size - 8, 0x5a),
  ]).toString("base64");

/** A Claude Code tool result holding a screenshot, as the parser queues it. */
const screenshot = (size: number) =>
  JSON.stringify([
    { type: "text", text: "Took a screenshot" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: png(size) } },
  ]);

/** Ordinary text of exactly `chars` characters (a multiple of 5). */
const words = (chars: number) => "word ".repeat(chars / 5);

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

/** Every row in daemon.db, sent or not, as stored there. */
const queued = (): string[] => {
  const raw = new Database(join(dir, "daemon.db"), { readonly: true });
  try {
    const rows = raw.prepare("SELECT content FROM pending_messages ORDER BY id").all();
    return (rows as Array<{ content: string }>).map((r) => r.content);
  } finally {
    raw.close();
  }
};

const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

/** Move the clock, run one flush, and return how many sends were made. */
async function flushAfter(ms: number): Promise<number> {
  later(ms);
  await syncer.flush();
  return server.sends.length;
}

const failureTypes = () => vi.mocked(recordFailure).mock.calls.map((c) => c[1]);
const errorLog = () => vi.mocked(console.error).mock.calls.map((c) => c.join(" ")).join("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-bound-bodies-"));
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

describe("file data is a note before it is queued (engram#750)", () => {
  it("queues a screenshot in a tool result as a note, and the tool result stays valid JSON", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("look at this", screenshot(300_000)));

    const [, shot] = queued();
    expect(shot.length).toBeLessThan(200);
    expect(JSON.parse(shot)[1].source.data).toBe("[image not stored: PNG, 293 KB]");

    await syncer.flush();
    expect(server.copyOf(db, "s1")).toEqual(["look at this", shot]);
  });

  it("queues ordinary text as it was, however long: the clip waits for the send", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs(words(150_000)));
    expect(queued()).toEqual([words(150_000)]);
  });
});

describe("every body is bounded before it is sent (engram#750)", () => {
  it("sends a long message cut, with the marker, and daemon.db keeps it whole", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs(words(150_000), "short"));
    await syncer.flush();

    expect(server.copyOf(db, "s1")).toEqual([words(MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER, "short"]);
    expect(queued()).toEqual([words(150_000), "short"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("sends a row an earlier version queued with its file data as a note", async () => {
    // Queued before this release: nothing stripped it on the way in.
    db.enqueue("conv_old", [{ role: "user", content: screenshot(300_000) }], FIXED_KEY_FP);
    await syncer.flush();

    expect(server.sends).toHaveLength(1);
    const [sent] = server.received;
    expect(sent.length).toBeLessThan(200);
    expect(JSON.parse(sent)[1].source.data).toBe("[image not stored: PNG, 293 KB]");
    expect(db.getPendingCount()).toBe(0);
  });

  it("fills a batch by what is sent, not by what is queued", async () => {
    // 200,000 characters each as queued, about 100,000 each as sent: two
    // fit the batch budget, where queued sizes would send one at a time.
    await syncer.onMessages("s1", meta("s1"), msgs(words(200_000), words(200_000), words(200_000)));
    await syncer.flush();

    expect(server.sends.map((p) => p.messages.length)).toEqual([2, 1]);
    expect(server.copyOf(db, "s1")).toEqual(
      Array(3).fill(words(MAX_MESSAGE_CONTENT_CHARS) + TRUNCATION_MARKER),
    );
  });

  it("cuts only after the vault scrub, so a secret at the cut is never half sent", async () => {
    const vault = new FakeVault({});
    const scrubber = new SecretScrubber(vault, "base64-vault-key-value");
    await scrubber.refresh();
    syncer = new Syncer(db, server.client(), scrubber);

    // Captured before the secret was saved to the vault; it straddles the cut.
    const secret = "tok_9f8e7d6c5b4a3928_1706f5e4d3c2b1a0";
    const text = words(MAX_MESSAGE_CONTENT_CHARS - 10) + secret + " is the token";
    await syncer.onMessages("s1", meta("s1"), msgs(text));
    vault.secrets.TOK = secret;
    await scrubber.refresh();
    await syncer.flush();

    const [sent] = server.received;
    expect(sent).toBe(words(MAX_MESSAGE_CONTENT_CHARS - 10) + "[VAULT:TOK" + TRUNCATION_MARKER);
    expect(sent).not.toContain(secret.slice(0, 10));
    // daemon.db holds the whole text, scrubbed.
    expect(queued()).toEqual([words(MAX_MESSAGE_CONTENT_CHARS - 10) + "[VAULT:TOK] is the token"]);
  });
});

describe("a refusal for size never loses or reorders a message (engram#750)", () => {
  it("sends a batch refused as too large again in halves, at once, until it all goes", async () => {
    // Something on the way accepts at most two of these at a time.
    const all = Array.from({ length: 8 }, (_, i) => `m${i}`);
    await syncer.onMessages("s1", meta("s1"), msgs(...all));
    server.failWhen = (p) => (p.messages.length > 2 ? tooLarge() : null);

    await syncer.flush();

    expect(server.sends.slice(0, 3).map((p) => p.messages.length)).toEqual([8, 4, 2]);
    expect(server.copyOf(db, "s1")).toEqual(all);
    expect(db.getPendingCount()).toBe(0);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledTimes(1);
    expect(errorLog()).toContain("send refused as too large — sending it again in batches of 4");
  });

  it("keeps a single message that is still refused queued, in its place, and tries it again after a wait", async () => {
    await syncer.onMessages("s1", meta("s1"), msgs("a", "b", "c"));
    server.failWhen = (p) => (p.messages.some((m) => m.content === "b") ? tooLarge() : null);

    await syncer.flush();
    expect(server.copyOf(db, "s1")).toEqual(["a"]);
    expect(db.getPendingCount()).toBe(2);
    expect(failureTypes()).toEqual(["too_large"]);
    // "c" was only ever sent right behind "b", never ahead of it.
    for (const p of server.sends) {
      const contents = p.messages.map((m) => m.content);
      if (contents.includes("c")) expect(contents[contents.indexOf("c") - 1]).toBe("b");
    }
    const sends = server.sends.length;

    // Waits like any other failure; another conversation goes meanwhile.
    await syncer.onMessages("s2", meta("s2"), msgs("other"));
    expect(await flushAfter(RETRY_BASE_MS / 2 - 1)).toBe(sends + 1);
    expect(server.copyOf(db, "s2")).toEqual(["other"]);
    expect(server.copyOf(db, "s1")).toEqual(["a"]);

    server.failWhen = null;
    await flushAfter(RETRY_BASE_MS);
    expect(server.copyOf(db, "s1")).toEqual(["a", "b", "c"]);
    expect(db.getPendingCount()).toBe(0);
  });
});
