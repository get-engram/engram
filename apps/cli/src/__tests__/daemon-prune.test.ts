import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Engram } from "@getengram/sdk";

// The end-to-end test runs the real Syncer. status.ts writes the REAL
// ~/.engram/status.json and exclusions.ts reads the real config.json: keep
// both off the developer's machine.
vi.mock("../daemon/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/status.js")>()),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  recordCaptureStall: vi.fn(),
  recordCaptureResumed: vi.fn(),
  recordSignedOut: vi.fn(),
  recordSignedIn: vi.fn(),
  updatePending: vi.fn(),
}));
vi.mock("../daemon/exclusions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/exclusions.js")>()),
  isPathExcluded: () => false,
}));

import { DaemonDb, PRUNE_SENT_SQL, SCHEMA_VERSION, sqliteTime } from "../daemon/db.js";
import {
  PRUNE_BATCH,
  Pruner,
  SENT_RETENTION_MS,
  freeBytesAt,
  sqliteTempDir,
  type PrunerOptions,
} from "../daemon/prune.js";
import { Syncer } from "../daemon/syncer.js";
import type { ParsedMessage, SessionMeta } from "../daemon/types.js";

// engram#598: daemon.db kept every message it had ever sent. Sent rows now
// leave it SENT_RETENTION_DAYS days after the server confirmed it has them,
// and what is deleted leaves the file too. The rule these tests pin above
// all: a message the server doesn't have is never deleted.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const GB = 1024 * 1024 * 1024;

let dir: string;
let dbPath: string;
const opened: Array<{ close(): void }> = [];

function track<T extends { close(): void }>(handle: T): T {
  opened.push(handle);
  return handle;
}

const openDb = (path = dbPath) => track(new DaemonDb(path));

const msgs = (...contents: string[]): ParsedMessage[] =>
  contents.map((content, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content }));

/** A message long enough to need overflow pages (most transcript turns). */
const long = (marker: string) => `${marker}:start ${"x".repeat(20_000)} ${marker}:end`;

type Row = { id: number; conversation_id: string; content: string; sent_at: string | null };

/** Every queued row, sent or not, read through a separate connection. */
function queued(path = dbPath): Row[] {
  const raw = new Database(path, { readonly: true });
  try {
    return raw
      .prepare("SELECT id, conversation_id, content, sent_at FROM pending_messages ORDER BY id")
      .all() as Row[];
  } finally {
    raw.close();
  }
}

/** Ids of the rows queued for a conversation, in order. */
const idsOf = (conversationId: string) =>
  queued()
    .filter((r) => r.conversation_id === conversationId)
    .map((r) => r.id);

/** Set when rows were sent (markSent always writes the current time). A
 *  string is written as it is. */
function setSentTimes(times: Iterable<readonly [number, Date | string | null]>): void {
  // One connection and one transaction for all of them: a commit per row is
  // slow on slow disks (Windows runners).
  const raw = new Database(dbPath);
  try {
    raw.pragma("secure_delete = ON"); // leave no trace of its own
    const set = raw.prepare("UPDATE pending_messages SET sent_at = ? WHERE id = ?");
    raw.transaction(() => {
      for (const [id, at] of times) set.run(at instanceof Date ? sqliteTime(at) : at, id);
    })();
  } finally {
    raw.close();
  }
}

function setSentAt(ids: number[], at: Date | string | null): void {
  setSentTimes(ids.map((id) => [id, at] as const));
}

/** Whether `text` is in daemon.db's write-ahead log. */
function walHas(text: string): boolean {
  const wal = `${dbPath}-wal`;
  return existsSync(wal) && readFileSync(wal).includes(Buffer.from(text));
}

/** Whether `text` is anywhere in a database's file or its write-ahead log. */
function onDisk(text: string, path = dbPath): boolean {
  const needle = Buffer.from(text);
  return [path, `${path}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(needle));
}

/** Every table's rows, in rowid order, as one comparable value. */
function everything(path = dbPath): Record<string, unknown[]> {
  const raw = new Database(path, { readonly: true });
  try {
    const tables = raw
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    return Object.fromEntries(
      tables.map(({ name }) => [name, raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]),
    );
  } finally {
    raw.close();
  }
}

/** A daemon.db as versions before engram#598 left it: schema version 1,
 *  and freed space never given back to the disk (auto_vacuum NONE). */
function makeOldDb(path = dbPath): void {
  new DaemonDb(path).close();
  const raw = new Database(path);
  try {
    raw.exec("DROP INDEX idx_pending_sent");
    raw.pragma("user_version = 1");
    raw.pragma("auto_vacuum = NONE");
    raw.exec("VACUUM");
    expect(raw.pragma("auto_vacuum", { simple: true })).toBe(0);
  } finally {
    raw.close();
  }
}

/** Text an older daemon deleted (an opt-out, a rewrite): without
 *  secure_delete, SQLite leaves it in the file's free pages. */
function leaveDeletedText(marker: string, path = dbPath): void {
  const raw = new Database(path);
  try {
    raw.pragma("secure_delete = OFF");
    const add = raw.prepare(
      `INSERT INTO pending_messages (conversation_id, role, content, created_at)
       VALUES ('conv_gone', 'user', ?, datetime('now'))`,
    );
    raw.transaction(() => {
      for (let i = 0; i < 30; i++) add.run(long(marker));
    })();
    raw.exec("DELETE FROM pending_messages WHERE conversation_id = 'conv_gone'");
    raw.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    raw.close();
  }
}

/** A pruner whose clock is `offset` ahead, logging into `lines`. */
function pruner(db: DaemonDb, lines: string[], opts: Partial<PrunerOptions> & { offset?: number } = {}) {
  const { offset = 0, ...rest } = opts;
  return new Pruner(db, dbPath, {
    log: (msg) => lines.push(msg),
    now: () => Date.now() + offset,
    pause: async () => {},
    freeBytes: () => 100 * GB,
    tempDir: () => dir,
    ...rest,
  });
}

/** 30 days and an hour ahead: everything sent by now is due. */
const DUE = 30 * DAY + HOUR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engram-prune-"));
  dbPath = join(dir, "daemon.db");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const handle of opened.splice(0)) {
    try {
      handle.close();
    } catch {
      // closed by the test
    }
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("DaemonDb.pruneSent (engram#598)", () => {
  it("never deletes a message that hasn't been sent, however old, and deletes sent ones only once they're due", () => {
    const now = Date.parse("2026-11-09T12:00:00Z");
    const cutoff = new Date(now - SENT_RETENTION_MS);
    for (const seed of [1, 7, 42, 598, 2026]) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      const db = new DaemonDb(dbPath);
      let state = seed;
      const random = () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };
      for (let c = 0; c < 6; c++) {
        db.enqueue(`conv_${c}`, msgs(...Array.from({ length: 50 }, (_, i) => `m${c}-${i}`)), null);
      }
      const all = queued().map((r) => r.id);
      const unsent: number[] = [];
      const due: number[] = [];
      const recent: number[] = [];
      for (const id of all) {
        const r = random();
        if (r < 0.4) unsent.push(id);
        else if (r < 0.7) due.push(id);
        else recent.push(id);
      }
      db.markSent([...due, ...recent]);
      const times: Array<[number, Date]> = [];
      for (const id of due) times.push([id, new Date(cutoff.getTime() - 1000 - Math.floor(random() * 400 * DAY))]);
      for (const id of recent) times.push([id, new Date(cutoff.getTime() + Math.floor(random() * 29 * DAY))]);
      setSentTimes(times);
      // Queued years ago and never sent: still never deleted.
      const raw = new Database(dbPath);
      raw.prepare("UPDATE pending_messages SET created_at = '2020-01-01 00:00:00' WHERE sent_at IS NULL").run();
      raw.close();

      expect(db.pruneSent(cutoff, 1_000_000)).toBe(due.length);
      expect(queued().map((r) => r.id)).toEqual([...unsent, ...recent].sort((a, b) => a - b));
      expect(db.getPendingCount()).toBe(unsent.length);
      expect(db.pruneSent(new Date(now + 400 * DAY), 1_000_000)).toBe(recent.length);
      expect(queued().map((r) => r.id)).toEqual(unsent);
      db.close();
    }
  });

  it("deletes the oldest first, at most `limit` at a time, and keeps a row sent exactly at the cutoff", () => {
    const db = openDb();
    db.enqueue("conv_a", msgs("a", "b", "c", "d", "e"), null);
    const [a, b, c, d, e] = idsOf("conv_a");
    const cutoff = new Date("2026-10-10T08:00:00Z");
    db.markSent([a!, b!, c!, d!]);
    // markSent writes datetime('now'): UTC, to the second. The cutoff is
    // compared with that text, so it must be written the same way.
    const written = queued().find((r) => r.id === a)!.sent_at!;
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(sqliteTime(new Date("2026-10-10T08:00:00.789Z"))).toBe("2026-10-10 08:00:00");
    setSentAt([a!], new Date(cutoff.getTime() - 1000)); // a second before
    setSentAt([b!], new Date(cutoff.getTime() - 10 * DAY));
    setSentAt([c!], "2026-10-10 08:00:00"); // exactly at it, as datetime('now') writes it
    setSentAt([d!], new Date(cutoff.getTime() - 5 * DAY));

    expect(db.pruneSent(cutoff, 1)).toBe(1);
    expect(idsOf("conv_a")).toEqual([a, c, d, e]); // b, the oldest
    expect(db.pruneSent(cutoff, 1)).toBe(1);
    expect(idsOf("conv_a")).toEqual([a, c, e]); // then d
    expect(db.pruneSent(cutoff, 5)).toBe(1);
    expect(idsOf("conv_a")).toEqual([c, e]); // then a; c isn't before the cutoff
    expect(db.pruneSent(cutoff, 5)).toBe(0);
  });

  it("finds due rows through the sent index, without reading the table", () => {
    const db = openDb();
    db.enqueue("conv_a", msgs("a"), null);
    const raw = track(new Database(dbPath, { readonly: true }));
    const plan = (
      raw.prepare(`EXPLAIN QUERY PLAN ${PRUNE_SENT_SQL}`).all(sqliteTime(new Date()), PRUNE_BATCH) as Array<{
        detail: string;
      }>
    ).map((step) => step.detail);
    expect(plan.join("\n")).toContain("USING COVERING INDEX idx_pending_sent");
    expect(plan.some((step) => /^SCAN pending_messages/.test(step))).toBe(false);
  });

  it("what it deletes leaves daemon.db and its write-ahead log, where a plain delete leaves it behind", () => {
    // The control: SQLite's default keeps deleted text in free pages.
    const controlPath = join(dir, "control.db");
    const control = new Database(controlPath);
    control.pragma("journal_mode = WAL");
    control.exec("CREATE TABLE t (content TEXT)");
    control.prepare("INSERT INTO t VALUES (?)").run(long("CONTROL-7f3a"));
    control.exec("DELETE FROM t");
    control.pragma("wal_checkpoint(TRUNCATE)");
    control.close();
    expect(onDisk("CONTROL-7f3a:start", controlPath)).toBe(true);
    expect(onDisk("CONTROL-7f3a:end", controlPath)).toBe(true);

    const db = openDb();
    db.enqueue("conv_a", msgs(long("SENT-91c2"), "SENT-91c2:short"), null);
    db.enqueue("conv_b", msgs(long("UNSENT-04be")), null);
    db.markSent(idsOf("conv_a"));
    expect(onDisk("SENT-91c2:end")).toBe(true);

    expect(db.pruneSent(new Date(Date.now() + DUE), 100)).toBe(2);
    expect(db.checkpoint()).toBe(true);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    for (const gone of ["SENT-91c2:start", "SENT-91c2:end", "SENT-91c2:short"]) {
      expect(onDisk(gone)).toBe(false);
    }
    expect(onDisk("UNSENT-04be:start")).toBe(true);
    expect(onDisk("UNSENT-04be:end")).toBe(true);
  });

  it("a checkpoint doesn't wait for a reader that is behind, and leaves the busy timeout as it was", () => {
    const db = openDb();
    db.enqueue("conv_a", msgs("one"), null);
    const reader = track(new Database(dbPath, { readonly: true }));
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) FROM pending_messages").get();
    db.enqueue("conv_a", msgs("two"), null); // the reader is now behind

    const started = Date.now();
    expect(db.checkpoint()).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    const inner = (db as unknown as { db: Database.Database }).db;
    expect(inner.pragma("busy_timeout", { simple: true })).toBe(5000);

    reader.exec("COMMIT");
    expect(db.checkpoint()).toBe(true);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
  });
});

describe("daemon.db schema version 2 (engram#598)", () => {
  it("a new daemon.db is made to give freed space back to the disk", () => {
    const db = openDb();
    expect(db.storage()).toMatchObject({ incremental: true, freePages: 0 });
    const raw = track(new Database(dbPath, { readonly: true }));
    expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("brings a version 1 daemon.db to version 2 once, keeping every row", () => {
    const db = openDb();
    db.enqueue("conv_a", msgs("a", "b"), null);
    db.markSent(idsOf("conv_a").slice(0, 1));
    db.setFileOffset("/t/one.jsonl", 123);
    db.close();
    const raw = new Database(dbPath);
    raw.exec("DROP INDEX idx_pending_sent");
    raw.pragma("user_version = 1");
    raw.close();
    const before = everything();

    openDb().close();
    const check = new Database(dbPath, { readonly: true });
    expect(check.pragma("user_version", { simple: true })).toBe(2);
    expect(
      check.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_pending_sent'").get(),
    ).toEqual({ name: "idx_pending_sent" });
    check.close();
    expect(everything()).toEqual(before);
  });
});

describe("Pruner (engram#598)", () => {
  // Writes 9 MB several times over, so that giving the space back takes more
  // than one step: slow disks (Windows runners) need more than the default 5 s.
  it("removes what is due in batches, gives the space back, and says how many in words", { timeout: 30_000 }, async () => {
    const db = openDb();
    db.enqueue("conv_old", msgs(...Array.from({ length: 450 }, (_, i) => long(`OLD-${i}`))), null);
    db.enqueue("conv_new", msgs("NEW-1"), null);
    db.markSent(idsOf("conv_old"));
    db.checkpoint();
    const sizeBefore = statSync(dbPath).size;
    const lines: string[] = [];

    await pruner(db, lines, { offset: 30 * DAY - HOUR }).pass(); // not yet
    expect(lines).toEqual([]);
    expect(queued()).toHaveLength(451);

    const prune = vi.spyOn(db, "pruneSent");
    const release = vi.spyOn(db, "releaseFreePages");
    await pruner(db, lines, { offset: DUE }).pass();

    expect(prune.mock.results.map((r) => r.value)).toEqual([PRUNE_BATCH, PRUNE_BATCH, 50]);
    expect(lines).toEqual([
      "removed 450 messages sent over 30 days ago from the local queue (the server keeps them)",
    ]);
    expect(queued().map((r) => r.content)).toEqual(["NEW-1"]);
    expect(release.mock.calls.length).toBeGreaterThan(1); // more than one step
    expect(release.mock.results.every((r) => (r.value as number) > 0)).toBe(true);
    expect(db.storage().freePages).toBe(0);
    expect(statSync(dbPath).size).toBeLessThan(sizeBefore / 20);
    expect(statSync(`${dbPath}-wal`).size).toBe(0);
    expect(onDisk("OLD-449:end")).toBe(false);

    lines.length = 0;
    db.enqueue("conv_one", msgs("ONE"), null);
    db.markSent(idsOf("conv_one"));
    await pruner(db, lines, { offset: DUE }).pass();
    expect(lines).toEqual([
      "removed 1 message sent over 30 days ago from the local queue (the server keeps them)",
    ]);

    lines.length = 0;
    await pruner(db, lines).pass(); // nothing due
    expect(lines).toEqual([]);
    expect(queued().map((r) => r.content)).toEqual(["NEW-1"]);
  });

  it("a message the server didn't take stays queued and is sent later; one it took leaves once due", async () => {
    const server = {
      stored: [] as string[],
      failing: true,
      seq: 0,
      async createConversation() {
        return { conversationId: `conv_${++this.seq}` };
      },
      async store(p: { conversationId: string; messages: Array<{ content: string }> }) {
        if (this.failing && p.messages.some((m) => m.content.startsWith("HELD"))) {
          throw new Error("fetch failed");
        }
        this.stored.push(...p.messages.map((m) => m.content));
        return { stored: p.messages.length };
      },
      async deleteConversation() {},
    };
    const meta = (sessionId: string): SessionMeta => ({
      sessionId,
      projectDir: "proj",
      cwd: "/work/proj",
      host: "claude-code",
    });
    const db = openDb();
    const syncer = new Syncer(db, server as unknown as Engram);
    await syncer.onMessages("s-taken", meta("s-taken"), msgs("TAKEN-1", "TAKEN-2"));
    await syncer.onMessages("s-held", meta("s-held"), msgs("HELD-1"));
    await syncer.flush();
    expect(server.stored).toEqual(["TAKEN-1", "TAKEN-2"]);
    expect(db.getPendingCount()).toBe(1);

    const lines: string[] = [];
    await pruner(db, lines, { offset: DUE }).pass();
    await pruner(db, lines, { offset: 10 * 365 * DAY }).pass();
    expect(queued().map((r) => [r.content, r.sent_at])).toEqual([["HELD-1", null]]);
    expect(lines).toEqual([
      "removed 2 messages sent over 30 days ago from the local queue (the server keeps them)",
    ]);

    server.failing = false;
    await syncer.flush();
    expect(server.stored).toEqual(["TAKEN-1", "TAKEN-2", "HELD-1"]);
    expect(db.getPendingCount()).toBe(0);
  });

  it("rewrites a daemon.db from before this once: every row stays as it was, and what older versions deleted leaves the file", async () => {
    makeOldDb();
    leaveDeletedText("OPTED-OUT-5d1e");
    const db = openDb(); // migrates to version 2; auto_vacuum stays off
    db.enqueue("conv_a", msgs("kept-1", "kept-2", long("KEPT-LONG")), null);
    db.markSent(idsOf("conv_a").slice(0, 1));
    db.setFileOffset("/t/one.jsonl", 42);
    db.setSessionMap("s1", "conv_a", { projectDir: "p", cwd: "/w" }, "fp1");
    db.markSessionExcluded("s-opted-out", "user");
    db.checkpoint();
    expect(db.storage().incremental).toBe(false);
    expect(onDisk("OPTED-OUT-5d1e:start")).toBe(true);
    expect(onDisk("OPTED-OUT-5d1e:end")).toBe(true);
    const before = everything();
    const sizeBefore = statSync(dbPath).size;
    const compact = vi.spyOn(db, "compact");
    const lines: string[] = [];
    const p = pruner(db, lines);

    await p.pass();

    expect(compact).toHaveBeenCalledTimes(1);
    expect(db.storage()).toMatchObject({ incremental: true, freePages: 0 });
    expect(everything()).toEqual(before);
    expect(onDisk("OPTED-OUT-5d1e:start")).toBe(false);
    expect(onDisk("OPTED-OUT-5d1e:end")).toBe(false);
    expect(onDisk("KEPT-LONG:end")).toBe(true);
    expect(statSync(dbPath).size).toBeLessThan(sizeBefore);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^compacted daemon\.db from \d+\.\d MB to \d+\.\d MB; space it frees goes back to the disk from now on$/,
    );

    // Once: from now on, freed space is given back as it goes.
    await p.pass();
    await pruner(db, lines, { offset: 3 * DAY }).pass();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    // The daemon carries on as before.
    db.enqueue("conv_a", msgs("after"), null);
    expect(db.getPendingCount()).toBe(3);
  });

  it("rewrites only when both disks it writes to have room, and asks again a day later", async () => {
    makeOldDb();
    const db = openDb();
    db.enqueue("conv_a", msgs("a", "b"), null);
    const { pages, freePages, pageSize } = db.storage();
    const needed = 3 * (pages - freePages) * pageSize + 64 * 1024 * 1024;
    const tempDir = join(dir, "sqlite-temp");
    const free = new Map<string, number | null>([
      [dir, needed - 1],
      [tempDir, needed],
    ]);
    const asked: string[] = [];
    let clock = Date.parse("2026-11-09T12:00:00Z");
    const lines: string[] = [];
    const p = new Pruner(db, dbPath, {
      log: (msg) => lines.push(msg),
      now: () => clock,
      pause: async () => {},
      freeBytes: (path) => {
        asked.push(path);
        return free.get(path) ?? null;
      },
      tempDir: () => tempDir,
    });
    const compact = vi.spyOn(db, "compact");

    await p.pass(); // the database's disk is a byte short
    expect(compact).not.toHaveBeenCalled();
    expect(lines).toEqual([
      expect.stringMatching(
        new RegExp(`^not compacting daemon\\.db yet: it needs [\\d.]+ MB free in ${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, which has [\\d.]+ MB$`),
      ),
    ]);
    expect(asked).toEqual([dir]);

    clock += DAY - 1; // not asked again within the day
    await p.pass();
    expect(asked).toEqual([dir]);

    clock += 1;
    free.set(dir, needed);
    free.set(tempDir, needed - 1); // now the temporary file's disk is short
    await p.pass();
    expect(compact).not.toHaveBeenCalled();
    expect(asked).toEqual([dir, dir, tempDir]);
    expect(lines[1]).toContain(`free in ${tempDir}, which has`);

    clock += DAY;
    free.set(dir, null); // can't tell
    await p.pass();
    expect(compact).not.toHaveBeenCalled();
    expect(lines[2]).toBe(`not compacting daemon.db yet: couldn't tell how much space is free in ${dir}`);

    clock += DAY;
    free.set(dir, needed);
    free.set(tempDir, needed);
    await p.pass();
    expect(compact).toHaveBeenCalledTimes(1);
    expect(db.storage().incremental).toBe(true);
  });

  it("doesn't rewrite when SQLite has nowhere to put its temporary copy", async () => {
    makeOldDb();
    const db = openDb();
    const lines: string[] = [];
    await pruner(db, lines, { tempDir: () => null }).pass();
    expect(db.storage().incremental).toBe(false);
    expect(lines).toEqual([
      "not compacting daemon.db yet: couldn't tell how much space is free for SQLite's temporary files",
    ]);
  });

  it("a rewrite that fails is logged, leaves the daemon working, and is tried again a day later", async () => {
    makeOldDb();
    const db = openDb();
    db.enqueue("conv_a", msgs("a"), null);
    const compact = vi.spyOn(db, "compact").mockImplementation(() => {
      throw new Error("database or disk is full");
    });
    const checkpoint = vi.spyOn(db, "checkpoint");
    let clock = Date.now();
    const lines: string[] = [];
    const p = pruner(db, lines, { now: () => clock });

    await expect(p.pass()).resolves.toBeUndefined();
    expect(lines).toEqual(["compacting daemon.db failed (it is as it was): database or disk is full"]);
    expect(checkpoint).toHaveBeenCalledTimes(1);
    db.enqueue("conv_a", msgs("b"), null);
    expect(db.getPendingCount()).toBe(2);

    clock += HOUR;
    await p.pass();
    expect(compact).toHaveBeenCalledTimes(1);

    clock += DAY;
    await p.pass();
    expect(compact).toHaveBeenCalledTimes(2);
  });

  it("logs a problem once while it lasts, and again if it comes back", async () => {
    const db = openDb();
    const prune = vi.spyOn(db, "pruneSent").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    const checkpoint = vi.spyOn(db, "checkpoint");
    const lines: string[] = [];
    const p = pruner(db, lines);
    await p.pass();
    await p.pass();
    await p.pass();
    expect(lines).toEqual(["removing sent messages from daemon.db failed: database disk image is malformed"]);
    expect(prune).toHaveBeenCalledTimes(3); // once a pass, not again straight away
    expect(checkpoint).toHaveBeenCalledTimes(3); // the rest of each pass still ran

    prune.mockRestore();
    await p.pass(); // a clean pass
    vi.spyOn(db, "pruneSent").mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    await p.pass();
    expect(lines).toHaveLength(2);
  });

  it("stops between batches without touching the database again", async () => {
    const db = openDb();
    db.enqueue("conv_a", msgs(...Array.from({ length: 450 }, (_, i) => `m${i}`)), null);
    db.markSent(idsOf("conv_a"));
    const lines: string[] = [];
    let p!: Pruner;
    p = pruner(db, lines, {
      offset: DUE,
      pause: async () => {
        // Shutdown, as worker-main does it: stop, then close.
        p.stop();
        db.close();
      },
    });
    await p.pass();
    expect(lines).toEqual([
      "removed 200 messages sent over 30 days ago from the local queue (the server keeps them)",
    ]);
    expect(queued()).toHaveLength(250);
  });

  it("runs two minutes after it starts, then every hour, and not after it stops", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = openDb();
    const p = pruner(db, []);
    const pass = vi.spyOn(p, "pass");
    p.start();
    p.start(); // a second start changes nothing

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 - 1);
    expect(pass).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(pass).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(pass).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(pass).toHaveBeenCalledTimes(3);

    p.stop();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(pass).toHaveBeenCalledTimes(3);
    p.start(); // stopped for good
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(pass).toHaveBeenCalledTimes(3);
    await expect(p.idle()).resolves.toBeUndefined();
  });
});

describe("Pruner, when things go wrong (engram#598)", () => {
  it("stops between steps of giving space back, without touching the database again", async () => {
    const db = openDb();
    // One batch to delete (no pause there), then more space to give back
    // than one step gives.
    db.enqueue("conv_a", msgs(...Array.from({ length: 150 }, (_, i) => `${i}:${"z".repeat(60_000)}`)), null);
    db.markSent(idsOf("conv_a"));
    const lines: string[] = [];
    let pauses = 0;
    let p!: Pruner;
    p = pruner(db, lines, {
      offset: DUE,
      pause: async () => {
        pauses++;
        p.stop();
        db.close();
      },
    });
    await p.pass();
    expect(pauses).toBe(1);
    expect(lines).toEqual([
      "removed 150 messages sent over 30 days ago from the local queue (the server keeps them)",
    ]);
  });

  it("a step that gives nothing back ends the pass instead of trying forever", async () => {
    const db = openDb();
    vi.spyOn(db, "storage").mockReturnValue({ pageSize: 4096, pages: 6000, freePages: 5000, incremental: true });
    const release = vi.spyOn(db, "releaseFreePages").mockReturnValue(0);
    await pruner(db, []).pass();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("a step that fails is logged, and the pass goes on to the next", async () => {
    const db = openDb();
    const checkpoint = vi.spyOn(db, "checkpoint");
    const storage = vi.spyOn(db, "storage").mockImplementationOnce(() => {
      throw new Error("disk I/O error");
    });
    const lines: string[] = [];
    await expect(pruner(db, lines).pass()).resolves.toBeUndefined();
    expect(lines).toEqual(["reading daemon.db's size failed: disk I/O error"]);
    expect(checkpoint).toHaveBeenCalledTimes(1);

    lines.length = 0;
    storage.mockReturnValue({ pageSize: 4096, pages: 10, freePages: 5, incremental: true });
    const release = vi.spyOn(db, "releaseFreePages").mockImplementation(() => {
      throw new Error("database is locked");
    });
    await expect(pruner(db, lines).pass()).resolves.toBeUndefined();
    expect(lines).toEqual(["giving daemon.db's free space back to the disk failed: database is locked"]);
    expect(release).toHaveBeenCalledTimes(1); // not tried again until the next pass
    expect(checkpoint).toHaveBeenCalledTimes(2);

    lines.length = 0;
    storage.mockRestore();
    release.mockRestore();
    checkpoint.mockImplementation(() => {
      throw new Error("database is locked");
    });
    await expect(pruner(db, lines).pass()).resolves.toBeUndefined();
    expect(lines).toEqual(["emptying daemon.db's write-ahead log failed: database is locked"]);
  });

  it("a pass that fails in a way it didn't expect is logged, and the next one still runs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const lines: string[] = [];
    const p = pruner(openDb(), lines);
    const pass = vi.spyOn(p, "pass").mockRejectedValueOnce(new Error("write EIO"));
    p.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(lines).toEqual(["clearing sent messages failed: write EIO"]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(pass).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("even when the log can't be written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = pruner(openDb(), [], {
      log: () => {
        throw new Error("ENOSPC: no space left on device, write");
      },
    });
    const pass = vi.spyOn(p, "pass").mockRejectedValueOnce(new Error("ENOSPC: no space left on device, write"));
    p.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + HOUR);
    expect(pass).toHaveBeenCalledTimes(2);
    p.stop();
  });

  it("a pass that is running when it stops is the last", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = openDb();
    db.enqueue("conv_a", msgs(...Array.from({ length: 450 }, (_, i) => `m${i}`)), null);
    db.markSent(idsOf("conv_a"));
    let p!: Pruner;
    p = pruner(db, [], { offset: DUE, pause: async () => p.stop() });
    const pass = vi.spyOn(p, "pass");
    p.start();
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await p.idle();
    await vi.advanceTimersByTimeAsync(10 * HOUR);
    expect(pass).toHaveBeenCalledTimes(1);
    expect(queued()).toHaveLength(250);
  });

  it("its timer doesn't keep the daemon running by itself", () => {
    const p = pruner(openDb(), []);
    p.start();
    const timer = (p as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    p.stop();
  });
});

describe("the write-ahead log (engram#598)", () => {
  it("is cut back when it starts over, so old copies of pages don't stay at its end", () => {
    const db = openDb();
    db.enqueue("conv_fill", msgs(...Array.from({ length: 20 }, () => "y".repeat(20_000))), null);
    db.enqueue("conv_a", msgs(long("WAL-TAIL-6e0")), null); // the log's last pages
    const inner = (db as unknown as { db: Database.Database }).db;
    inner.pragma("wal_checkpoint(PASSIVE)"); // what SQLite does by itself every 1,000 pages
    expect(walHas("WAL-TAIL-6e0:end")).toBe(true);
    db.enqueue("conv_b", msgs("small"), null); // the next write starts the log over
    expect(walHas("WAL-TAIL-6e0:end")).toBe(false);
    expect(statSync(`${dbPath}-wal`).size).toBeLessThan(64 * 1024);
  });
});

describe("where compacting writes (engram#598)", () => {
  it("picks SQLite's temporary directory as SQLite does", () => {
    const other = mkdtempSync(join(dir, "other-"));
    const missing = join(dir, "missing");
    const file = join(dir, "not-a-dir");
    writeFileSync(file, "");
    chmodSync(file, 0o700); // usable, but for not being a directory
    expect(sqliteTempDir({ SQLITE_TMPDIR: dir, TMPDIR: other }, "darwin")).toBe(dir);
    expect(sqliteTempDir({ SQLITE_TMPDIR: missing, TMPDIR: other }, "darwin")).toBe(other);
    expect(sqliteTempDir({ SQLITE_TMPDIR: file, TMPDIR: other }, "linux")).toBe(other);
    expect(sqliteTempDir({ TMPDIR: file }, "linux")).not.toBe(file);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const readOnly = join(dir, "read-only");
      mkdirSync(readOnly, { mode: 0o500 });
      expect(sqliteTempDir({ SQLITE_TMPDIR: readOnly, TMPDIR: other }, "linux")).toBe(other);
    }
    expect(sqliteTempDir({ TMP: "C:\\t1", TEMP: "C:\\t2", USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\t1");
    expect(sqliteTempDir({ TEMP: "C:\\t2", USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\t2");
    expect(sqliteTempDir({ USERPROFILE: "C:\\u" }, "win32")).toBe("C:\\u");
  });

  it("reads free space, and says so when it can't", () => {
    expect(freeBytesAt(dir)).toBeGreaterThan(0);
    expect(freeBytesAt(join(dir, "missing", "deeper"))).toBeNull();
  });

  it("counts the space this user may write to, not what the disk keeps for root", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => ({
      ...(await importOriginal<typeof import("node:fs")>()),
      statfsSync: () => ({ type: 0, bsize: 4096, blocks: 1000, bfree: 300, bavail: 200, files: 10, ffree: 5 }),
    }));
    try {
      const fresh = await import("../daemon/prune.js");
      expect(fresh.freeBytesAt("/anywhere")).toBe(200 * 4096);
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});
