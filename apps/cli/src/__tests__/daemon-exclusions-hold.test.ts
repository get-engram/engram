import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engram } from "@getengram/sdk";
import type { HostAdapter } from "../daemon/types.js";

// engram#673: when ~/.engram/config.json was there but couldn't be read or
// parsed, the daemon took it for no exclusions, and captured sessions from
// folders the user had excluded. An exclusion can't be taken back once a
// session is sent. Now the watcher holds the transcript at the line, as it
// does when daemon.db can't queue (engram#584), and captures from there,
// exclusions applied, once config.json can be read again.

const { home } = vi.hoisted(() => ({ home: { dir: "" } }));

// exclusions.ts reads ~/.engram/config.json: a temp home's, written here.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.dir,
}));

// What the daemon reports is checked here, not written to status.json.
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

home.dir = mkdtempSync(join(tmpdir(), "engram-673-hold-"));
const ENGRAM = join(home.dir, ".engram");
const CONFIG = join(ENGRAM, "config.json");
afterAll(() => rmSync(home.dir, { recursive: true, force: true }));

// After the temp home is set: these take their paths from it when imported.
const { DaemonDb, pendingConversationId } = await import("../daemon/db.js");
const { Parser } = await import("../daemon/parser.js");
const { CodexParser } = await import("../daemon/codex-parser.js");
const { Syncer, FIXED_KEY_FP } = await import("../daemon/syncer.js");
const { Watcher } = await import("../daemon/watcher.js");
const { IGNORE_MARKER, resetExclusionCaches } = await import("../daemon/exclusions.js");
const { recordCaptureStall, recordCaptureResumed } = await import("../daemon/status.js");

type Db = InstanceType<typeof DaemonDb>;
type W = InstanceType<typeof Watcher>;

/** Folders sessions run in. */
const WORK = join(home.dir, "work");
const CLIENT = join(home.dir, "client");
const MARKED = join(home.dir, "marked");

/** The end of a made-up key: what must never reach the log. */
const TAIL = "Q9Z7LEAK";
/** A value typed without quotes after the key: JSON.parse's own message
 *  would quote the end of the key. */
const BROKEN = `{"apiKey":"engram_sk_live_test_673_${TAIL}","n":x}`;
const UNREADABLE = "~/.engram/config.json isn't valid JSON";

function config(settings: string | Record<string, unknown>): void {
  mkdirSync(ENGRAM, { recursive: true });
  writeFileSync(CONFIG, typeof settings === "string" ? settings : JSON.stringify(settings));
}

// ── Transcript lines ───────────────────────────────────────────────────────
const cUser = (sessionId: string, cwd: string, text: string) => ({
  type: "user",
  sessionId,
  cwd,
  message: { role: "user", content: text },
});
const xMeta = (payload: Record<string, unknown>) => ({ type: "session_meta", payload });
const xMsg = (role: "user" | "assistant", t: string) => ({
  type: "response_item",
  payload: {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text: t }],
  },
});

const UUID_A = "019f8e95-d0a3-70f3-88af-5f96100f86be";

let dir: string;
const opened: Db[] = [];
const watchers: W[] = [];

function openDb(): Db {
  const db = new DaemonDb(join(dir, "daemon.db"));
  opened.push(db);
  return db;
}

const claudePath = (name: string) => join(dir, "-Users-x-proj", `${name}.jsonl`);
const codexPath = (uuid: string) =>
  join(dir, "2026", "11", "09", `rollout-2026-11-09T10-00-00-${uuid}.jsonl`);

const lineOf = (record: unknown) => JSON.stringify(record) + "\n";

function append(path: string, ...records: unknown[]): void {
  appendFileSync(path, records.map(lineOf).join(""));
}

/** What daemon.db holds for a session that has no conversation yet. */
const queued = (db: Db, sessionId: string) =>
  db.dequeue(pendingConversationId(sessionId), 100, FIXED_KEY_FP).map((r) => r.content);

/**
 * A watcher fed through a real Syncer into a real daemon.db, wired the way
 * worker-main.ts wires the daemon's, and driven directly instead of by
 * chokidar. The exclusions are the real ones, reading CONFIG.
 */
function daemon(host: "claude" | "codex" = "claude", db: Db = openDb()) {
  const syncer = new Syncer(db, {} as Engram);
  const adapter: HostAdapter = {
    id: host,
    label: host,
    watchDir: dir,
    available: () => true,
    createParser: (cb) => (host === "claude" ? new Parser(cb) : new CodexParser(cb)),
  };
  const watcher = new Watcher(
    db,
    (sessionId, meta, messages) => {
      syncer.onMessages(sessionId, meta, messages).catch(() => {});
    },
    adapter,
  );
  watchers.push(watcher);
  const internals = watcher as unknown as { processFile(p: string, retrying?: boolean): void };
  return {
    db,
    watcher,
    /** A change event for the file. */
    read: (path: string) => internals.processFile(path),
    /** The backoff timer coming due. */
    retry: (path: string) => internals.processFile(path, true),
  };
}

/** Everything the daemon logged. */
const logged = () =>
  [...vi.mocked(console.error).mock.calls, ...vi.mocked(console.log).mock.calls].map((c) => c.join(" "));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-673-"));
  for (const sub of [join(dir, "-Users-x-proj"), join(dir, "2026", "11", "09")]) {
    mkdirSync(sub, { recursive: true });
  }
  for (const folder of [WORK, CLIENT, MARKED]) mkdirSync(folder, { recursive: true });
  rmSync(ENGRAM, { recursive: true, force: true });
  resetExclusionCaches();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // stop() also cancels any retry still scheduled.
  for (const w of watchers.splice(0)) w.stop();
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("a config.json that can't be read holds capture", () => {
  it("queues nothing while it can't tell, and captures from where it stopped once it can", () => {
    config(BROKEN);
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "first"), cUser("s1", WORK, "second"));

    read(A);
    expect(queued(db, "s1")).toEqual([]);
    expect(db.getFileOffset(A)).toBe(0);
    expect(recordCaptureStall).toHaveBeenCalledWith(A, UNREADABLE, "config");
    expect(console.error).toHaveBeenCalledWith(
      `[engram] couldn't capture from ${A}: which folders are excluded can't be told ` +
        `(${UNREADABLE}); holding at byte 0, trying again in 5s`,
    );
    expect(recordCaptureResumed).not.toHaveBeenCalled();

    config({ excludePaths: [CLIENT] });
    retry(A);
    expect(queued(db, "s1")).toEqual(["first", "second"]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
    expect(console.error).toHaveBeenCalledWith(
      `[engram] capturing from ${A} again, after 1 attempt(s) while config.json couldn't be read`,
    );
  });

  // The point of holding: what was typed in an excluded folder while the
  // exclusions couldn't be read is never queued.
  it("drops a session from an excluded folder once it can tell", () => {
    config(BROKEN);
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", join(CLIENT, "src"), "the client's plans"));

    read(A);
    expect(queued(db, "s1")).toEqual([]);

    config({ excludePaths: [CLIENT] });
    retry(A);
    expect(queued(db, "s1")).toEqual([]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
  });

  it("holds at the line after what it captured before the file broke", () => {
    config({ excludePaths: [] });
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "first"));
    read(A);
    expect(queued(db, "s1")).toEqual(["first"]);
    const second = statSync(A).size;

    // Broken in place, at another size: nothing read before stands in.
    config(BROKEN);
    append(A, cUser("s1", WORK, "second"), cUser("s1", WORK, "third"));
    read(A);
    expect(queued(db, "s1")).toEqual(["first"]);
    expect(db.getFileOffset(A)).toBe(second);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(`(${UNREADABLE}); holding at byte ${second}, trying again in 5s`),
    );

    config({ excludePaths: [CLIENT] });
    retry(A);
    expect(queued(db, "s1")).toEqual(["first", "second", "third"]);
  });

  it("doesn't read a held file again before its wait is over, and says it still can't after", () => {
    config(BROKEN);
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "first"));
    read(A);

    // The agent keeps writing; each write is a change event.
    append(A, cUser("s1", WORK, "more"));
    read(A);
    expect(recordCaptureStall).toHaveBeenCalledTimes(1);

    retry(A);
    expect(recordCaptureStall).toHaveBeenCalledTimes(2);
    expect(recordCaptureStall).toHaveBeenLastCalledWith(A, UNREADABLE, "config");
    expect(console.error).toHaveBeenCalledWith(
      `[engram] still can't capture from ${A}: which folders are excluded can't be told ` +
        `(${UNREADABLE}); holding at byte 0, trying again in 30s`,
    );
    expect(queued(db, "s1")).toEqual([]);
  });

  it.each([
    ["is empty", ""],
    ["has an excludePaths that isn't a list of paths", { excludePaths: CLIENT }],
    ["isn't a JSON object", "[]"],
  ])("holds when config.json %s", (problem, settings) => {
    config(settings);
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "hello"));
    read(A);
    expect(queued(db, "s1")).toEqual([]);
    expect(recordCaptureStall).toHaveBeenCalledWith(A, `~/.engram/config.json ${problem}`, "config");
  });

  it("holds when config.json is a folder", () => {
    mkdirSync(CONFIG, { recursive: true });
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "hello"));
    read(A);
    expect(queued(db, "s1")).toEqual([]);
    expect(recordCaptureStall).toHaveBeenCalledWith(A, "~/.engram/config.json is a folder, not a file", "config");
  });

  it("holds an opt-out typed meanwhile, and honours it once it can tell", () => {
    config(BROKEN);
    const { db, read, retry } = daemon();
    const A = claudePath("a");
    append(
      A,
      cUser("s1", WORK, "hello"),
      cUser("s1", WORK, "don't save this to engram"),
      cUser("s1", WORK, "the plans"),
    );
    read(A);
    expect(db.isSessionExcluded("s1")).toBe(false);
    expect(queued(db, "s1")).toEqual([]);

    config({});
    retry(A);
    expect(db.isSessionExcluded("s1")).toBe(true);
    expect(queued(db, "s1")).toEqual([]);
  });

  it("holds a Codex rollout too", () => {
    config(BROKEN);
    const { db, read, retry } = daemon("codex");
    const A = codexPath(UUID_A);
    append(A, xMeta({ id: UUID_A, cwd: WORK }), xMsg("user", "first"));
    read(A);
    expect(queued(db, UUID_A)).toEqual([]);
    expect(recordCaptureStall).toHaveBeenCalledWith(A, UNREADABLE, "config");

    config({});
    retry(A);
    expect(queued(db, UUID_A)).toEqual(["first"]);
    expect(recordCaptureResumed).toHaveBeenCalledWith(A);
  });

  it("never logs the file's contents", () => {
    config(BROKEN);
    const { read, retry } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "hello"));
    read(A);
    retry(A);
    config({});
    retry(A);

    const said = [...logged(), ...vi.mocked(recordCaptureStall).mock.calls.map((c) => c.join(" "))];
    expect(said.length).toBeGreaterThan(0);
    for (const line of said) {
      expect(line).not.toContain(TAIL.slice(-4));
      expect(line).not.toContain("engram_sk_");
    }
  });
});

describe("what doesn't hold", () => {
  it("a folder with a marker is excluded whatever config.json says", () => {
    config(BROKEN);
    writeFileSync(join(MARKED, IGNORE_MARKER), "");
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", join(MARKED, "src"), "hidden"));
    read(A);
    expect(queued(db, "s1")).toEqual([]);
    expect(db.getFileOffset(A)).toBe(statSync(A).size);
    expect(recordCaptureStall).not.toHaveBeenCalled();
  });

  it("no config.json means no exclusions", () => {
    const { db, read } = daemon();
    const A = claudePath("a");
    append(A, cUser("s1", WORK, "hello"));
    read(A);
    expect(queued(db, "s1")).toEqual(["hello"]);
    expect(recordCaptureStall).not.toHaveBeenCalled();
  });

  it("a config.json that reads fine applies its exclusions", () => {
    config({ excludePaths: [CLIENT] });
    const { db, read } = daemon();
    const A = claudePath("a");
    const B = claudePath("b");
    append(A, cUser("sa", CLIENT, "kept out"));
    append(B, cUser("sb", WORK, "captured"));
    read(A);
    read(B);
    expect(queued(db, "sa")).toEqual([]);
    expect(queued(db, "sb")).toEqual(["captured"]);
    expect(recordCaptureStall).not.toHaveBeenCalled();
  });
});
