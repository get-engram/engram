/**
 * Clears sent messages out of the local queue (engram#598).
 *
 * daemon.db holds what the watcher reads until the server has it. When the
 * server confirms it has stored a batch, the batch's rows are marked sent,
 * and until now they stayed: the file kept a copy of every message ever
 * captured, growing without end. Nothing reads a sent row again. The
 * transcript it was read from is still where it was, and the server has it.
 *
 * Once an hour (the first time a couple of minutes after the daemon
 * starts), rows sent more than SENT_RETENTION_DAYS days ago are deleted, a
 * few hundred at a time with pauses in between, so capture and sending
 * carry on as usual. A row that hasn't been sent is never deleted, however
 * old it is. The days in between leave time to look into a problem with
 * the local queue while its rows are still there.
 *
 * What is deleted leaves the file as well. secure_delete (see db.ts)
 * writes zeros over it, the space it took goes back to the disk, and each
 * pass ends by emptying the write-ahead log. A daemon.db made before this
 * is rewritten once (DaemonDb.compact), when the disks it writes to have
 * room for that, which also clears what earlier deletes left in its free
 * pages.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import type { DaemonDb, DbStorage } from "./db.js";
import { plural } from "../output.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long a sent message stays in the local queue. */
export const SENT_RETENTION_DAYS = 30;
export const SENT_RETENTION_MS = SENT_RETENTION_DAYS * DAY_MS;

/** The first pass waits this long after the daemon starts, past the busy
 *  first reads of the transcripts. */
export const FIRST_PASS_MS = 2 * 60 * 1000;
/** Then a pass every hour. */
export const PASS_INTERVAL_MS = 60 * 60 * 1000;

/** Rows deleted in one transaction. */
export const PRUNE_BATCH = 200;
/** Free pages given back to the disk in one step (8 MB of 4 KB pages). */
export const RELEASE_STEP_PAGES = 2048;
/** The pause between batches and steps, so the queue isn't held for long. */
export const STEP_PAUSE_MS = 50;

/** Compacting that was skipped or failed is tried again a day later. */
export const COMPACT_RETRY_MS = DAY_MS;
/** Compacting writes a copy of the live data to a temporary file and
 *  again to the write-ahead log. It starts only when each disk it writes
 *  to has three times that free, and this much more. */
export const COMPACT_SPARE_BYTES = 64 * 1024 * 1024;

/**
 * The directory SQLite writes the temporary copy a VACUUM makes to: the
 * first of these it can use, picked as SQLite itself picks it (os_unix.c,
 * unixTempFileDir; on Windows, GetTempPathW's order). Null when none is.
 */
export function sqliteTempDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "win32") {
    return env.TMP || env.TEMP || env.USERPROFILE || tmpdir();
  }
  for (const dir of [env.SQLITE_TMPDIR, env.TMPDIR, "/var/tmp", "/usr/tmp", "/tmp", "."]) {
    if (!dir) continue;
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
      return dir;
    } catch {
      // Not usable: SQLite goes on to the next one.
    }
  }
  return null;
}

/** Bytes free to this user on the disk that holds `path`; null when that
 *  can't be told (fs.statfsSync came in Node 18.15). */
export function freeBytesAt(path: string): number | null {
  const statfs = (fs as { statfsSync?: typeof fs.statfsSync }).statfsSync;
  if (typeof statfs !== "function") return null;
  try {
    const s = statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface PrunerOptions {
  /** Writes a line to the daemon log. */
  log: (msg: string) => void;
  // The rest are for tests.
  now?: () => number;
  pause?: (ms: number) => Promise<void>;
  freeBytes?: (path: string) => number | null;
  tempDir?: () => string | null;
}

export class Pruner {
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private readonly pause: (ms: number) => Promise<void>;
  private readonly freeBytes: (path: string) => number | null;
  private readonly tempDir: () => string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  /** Compacting isn't tried again before this time. */
  private compactAfter = 0;
  /** The last problem logged: the same one again isn't logged every hour. */
  private lastProblem: string | null = null;
  private problemThisPass = false;

  constructor(
    private readonly db: DaemonDb,
    private readonly dbPath: string,
    opts: PrunerOptions,
  ) {
    this.log = opts.log;
    this.now = opts.now ?? Date.now;
    this.pause = opts.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.freeBytes = opts.freeBytes ?? freeBytesAt;
    this.tempDir = opts.tempDir ?? (() => sqliteTempDir());
  }

  start(): void {
    if (this.stopped || this.timer || this.running) return;
    this.schedule(FIRST_PASS_MS);
  }

  /** No pass starts after this, and a pass in progress stops at its next
   *  step without touching the database again: close it after this. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Settles when no pass is running. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timer = null;
      this.running = this.pass()
        .catch((err) => {
          // pass() handles its own errors. Anything else (a log line that
          // can't be written to a full disk) mustn't stop the daemon: an
          // unhandled rejection would.
          try {
            this.log(`clearing sent messages failed: ${errorText(err)}`);
          } catch {
            // Nowhere to say it.
          }
        })
        .finally(() => {
          this.running = null;
          this.schedule(PASS_INTERVAL_MS);
        });
    }, ms);
    // The daemon's watchers keep it running; this timer alone shouldn't.
    timer.unref?.();
    this.timer = timer;
  }

  /** One pass: delete the rows that are due, give the space they took
   *  back to the disk, and empty the write-ahead log. Never throws. */
  async pass(): Promise<void> {
    this.problemThisPass = false;
    const removed = await this.prune();
    if (removed > 0) {
      this.log(
        `removed ${plural(removed, "message")} sent over ${SENT_RETENTION_DAYS} days ago from the local queue (the server keeps them)`,
      );
    }
    if (!this.stopped) await this.reclaim();
    if (!this.stopped) {
      try {
        // Busy (another process reading daemon.db) is fine: the next one.
        this.db.checkpoint();
      } catch (err) {
        this.problem("emptying daemon.db's write-ahead log failed", err);
      }
    }
    if (!this.problemThisPass) this.lastProblem = null;
  }

  /** Deletes the sent rows that are due, PRUNE_BATCH at a time, and
   *  returns how many went. */
  private async prune(): Promise<number> {
    // Fixed for the pass: rows sent while it runs are never due, so it ends.
    const before = new Date(this.now() - SENT_RETENTION_MS);
    let removed = 0;
    for (;;) {
      if (this.stopped) break;
      let deleted: number;
      try {
        deleted = this.db.pruneSent(before, PRUNE_BATCH);
      } catch (err) {
        this.problem("removing sent messages from daemon.db failed", err);
        break;
      }
      removed += deleted;
      if (deleted < PRUNE_BATCH) break;
      await this.pause(STEP_PAUSE_MS);
    }
    return removed;
  }

  /** Gives the space that deleted rows took back to the disk. */
  private async reclaim(): Promise<void> {
    let storage: DbStorage;
    try {
      storage = this.db.storage();
    } catch (err) {
      this.problem("reading daemon.db's size failed", err);
      return;
    }
    if (storage.incremental) {
      await this.release(storage.freePages);
    } else if (this.now() >= this.compactAfter) {
      this.compact(storage);
    }
  }

  private async release(freePages: number): Promise<void> {
    let left = freePages;
    while (left > 0) {
      if (this.stopped) return;
      let released: number;
      try {
        released = this.db.releaseFreePages(RELEASE_STEP_PAGES);
      } catch (err) {
        this.problem("giving daemon.db's free space back to the disk failed", err);
        return;
      }
      if (released <= 0) return;
      left -= released;
      if (left > 0) await this.pause(STEP_PAUSE_MS);
    }
  }

  /** Rewrites a daemon.db made before engram#598, once, when the disks it
   *  writes to have room. Tried at most once a day. */
  private compact(storage: DbStorage): void {
    this.compactAfter = this.now() + COMPACT_RETRY_MS;
    const live = (storage.pages - storage.freePages) * storage.pageSize;
    const needed = 3 * live + COMPACT_SPARE_BYTES;
    for (const dir of [dirname(this.dbPath), this.tempDir()]) {
      const free = dir === null ? null : this.freeBytes(dir);
      if (free === null) {
        this.problem(
          `not compacting daemon.db yet: couldn't tell how much space is free ${dir === null ? "for SQLite's temporary files" : `in ${dir}`}`,
        );
        return;
      }
      if (free < needed) {
        this.problem(`not compacting daemon.db yet: it needs ${mb(needed)} free in ${dir}, which has ${mb(free)}`);
        return;
      }
    }
    const size = storage.pages * storage.pageSize;
    try {
      this.db.compact();
    } catch (err) {
      this.problem("compacting daemon.db failed (it is as it was)", err);
      return;
    }
    try {
      const after = this.db.storage();
      this.log(
        `compacted daemon.db from ${mb(size)} to ${mb(after.pages * after.pageSize)}; space it frees goes back to the disk from now on`,
      );
    } catch {
      this.log("compacted daemon.db; space it frees goes back to the disk from now on");
    }
  }

  /** Logs a problem, unless it's the one logged last. */
  private problem(what: string, err?: unknown): void {
    this.problemThisPass = true;
    const text = err === undefined ? what : `${what}: ${errorText(err)}`;
    if (text === this.lastProblem) return;
    this.lastProblem = text;
    this.log(text);
  }
}
