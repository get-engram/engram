import { watch, type FSWatcher } from "chokidar";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { DaemonDb } from "./db.js";
import { QueueWriteError } from "./queue-error.js";
import { recordCaptureStall, recordCaptureResumed } from "./status.js";
import type { OnMessages, LineParser, HostAdapter } from "./types.js";

/**
 * How long a file waits to be read again after daemon.db couldn't queue its
 * messages (engram#584): 5 s, 30 s, 2 min, then every 5 min. A locked
 * daemon.db has usually cleared by the first; a full disk waits for a
 * person.
 */
export const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 5 * 60_000];

/** Where this process stands in a file it has started reading. */
interface FileCursor {
  /** Next byte to read. In memory only. */
  read: number;
  /** Offset last saved to daemon.db — where a restart resumes. */
  saved: number;
}

/** A complete line and the byte offset it starts at. */
export interface FileLine {
  text: string;
  offset: number;
}

/** A file held at a line whose messages couldn't be queued (engram#584). */
interface Hold {
  /** Failed attempts so far. */
  attempts: number;
  /** When the file is due to be read again, in ms since the epoch. */
  retryAt: number;
  timer: ReturnType<typeof setTimeout>;
}

/** The line being fed to the parser. */
interface Reading {
  /** Byte offset where the line starts. */
  offset: number;
  /**
   * Where to read again from if the line's messages can't be queued;
   * everything before it is queued. The first line of a message the parser
   * still holds, or this line once that message is queued.
   */
  safe: number;
}

/**
 * Watches one host's session directory for JSONL files and feeds new
 * lines to that host's parser (engram#261). One Watcher per host adapter.
 *
 * Two positions per file (engram#579). The read position is kept in
 * memory, so a running process never reads a line twice. The offset saved
 * in daemon.db, where a restart resumes, never passes a line whose content
 * the parser still holds unemitted: a hard crash re-reads that line rather
 * than skipping it. Everything before the saved offset has been handed to
 * the syncer, which queues it in daemon.db before returning.
 *
 * Neither position passes a line whose messages daemon.db couldn't queue
 * (engram#584). The file is held there and read again from that line after
 * a backoff. (A line the parser can't make sense of is skipped instead:
 * reading it again would fail the same way.)
 */
export class Watcher {
  private db: DaemonDb;
  private parser: LineParser;
  private fsWatcher: FSWatcher | null = null;
  private watchDir: string;
  private cursors = new Map<string, FileCursor>();
  private held = new Map<string, Hold>();
  private reading: Reading | null = null;
  private stopped = false;
  readonly host: string;

  constructor(db: DaemonDb, onMessages: OnMessages, adapter: HostAdapter) {
    this.db = db;
    this.parser = adapter.createParser((sessionId, meta, messages) => {
      onMessages(sessionId, meta, messages);
      // Queued. A line emits what the parser held before it, then its own
      // content: from here on, a failure reads again from this line.
      if (this.reading) this.reading.safe = this.reading.offset;
    });
    this.watchDir = adapter.watchDir;
    this.host = adapter.id;
  }

  start(): void {
    this.fsWatcher = watch(this.watchDir, {
      ignored: (path) => {
        // Only watch .jsonl files, ignore everything else
        if (path === this.watchDir) return false;
        if (path.endsWith(".jsonl")) return false;
        // Allow directories so chokidar can recurse
        try {
          return !statSync(path).isDirectory();
        } catch {
          return true;
        }
      },
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      // Claude nests ~2 (projects/<proj>/file); Codex nests 4
      // (sessions/YYYY/MM/DD/file). Cover both (engram#261).
      depth: 6,
    });

    this.fsWatcher.on("add", (path) => this.processFile(path));
    this.fsWatcher.on("change", (path) => this.processFile(path));
    this.fsWatcher.on("error", (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] watcher error: ${msg}`);
    });
  }

  /**
   * Emits whatever the parser still holds, then saves each such file's
   * offset past it: after a graceful stop, a restart must not read those
   * lines again. What can't be queued now keeps its offset, and the next
   * start reads it again.
   */
  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    for (const hold of this.held.values()) clearTimeout(hold.timer);
    for (const [filePath, cursor] of this.cursors) {
      if (this.parser.bufferedFrom(filePath) === null) continue;
      try {
        this.parser.flush(filePath);
      } catch (err: unknown) {
        this.parser.discard(filePath);
        console.error(
          `[engram] couldn't queue the last message of ${filePath} (${reasonOf(err)}); ` +
            `the next start reads it again`,
        );
        continue;
      }
      this.save(filePath, cursor, cursor.read);
    }
    try {
      this.parser.flush();
    } catch (err: unknown) {
      console.error(`[engram] couldn't queue a buffered message at shutdown: ${reasonOf(err)}`);
    }
  }

  private processFile(filePath: string, retrying = false): void {
    if (this.stopped || !filePath.endsWith(".jsonl")) return;
    // A held file is read again when its wait is over, not on every write
    // to it: a full disk would be tried again for each line the host writes.
    const hold = this.held.get(filePath);
    if (hold && !retrying && Date.now() < hold.retryAt) return;

    try {
      const size = statSync(filePath).size;
      let cursor = this.cursors.get(filePath);
      const resuming = !cursor;
      if (!cursor) {
        const saved = this.db.getFileOffset(filePath);
        cursor = { read: saved, saved };
      }

      // Nothing new. A held file that shrank has nothing left to retry.
      if (size <= cursor.read) {
        this.release(filePath, `${filePath} was cut short; nothing left to queue from it`);
        return;
      }

      const fd = openSync(filePath, "r");
      try {
        // This process's first read of the file, part-way in: rebuild the
        // per-file state an earlier process had (engram#579).
        if (resuming && cursor.read > 0) {
          this.restoreContext(fd, filePath, cursor.read);
        }

        // Complete lines only. An unterminated last line is still being
        // written; the next change event reads it whole.
        const { lines, end } = readLines(fd, cursor.read, size);
        this.cursors.set(filePath, cursor);
        for (const line of lines) {
          if (!line.text.trim()) continue;
          const reading: Reading = {
            offset: line.offset,
            safe: this.parser.bufferedFrom(filePath) ?? line.offset,
          };
          this.reading = reading;
          try {
            this.guard(filePath, () => this.parser.processLine(line.text, filePath, line.offset));
          } catch (err: unknown) {
            // guard() lets only a failure to queue through.
            this.hold(filePath, cursor, reading.safe, err);
            return;
          } finally {
            this.reading = null;
          }
        }
        cursor.read = end;
        this.release(filePath);

        const buffered = this.parser.bufferedFrom(filePath);
        this.save(filePath, cursor, buffered === null ? end : Math.min(end, buffered));
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] error reading ${filePath}: ${msg}`);
      // A held file that is gone has nothing left to retry; one that can't
      // be read just now is tried again on schedule.
      if (this.held.has(filePath)) {
        if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          this.release(filePath, `${filePath} is gone; nothing left to queue from it`);
        } else {
          this.backoff(filePath, msg);
        }
      }
    }
  }

  /**
   * daemon.db couldn't queue a line's messages (engram#584). Holds the file
   * at `at`, where what wasn't queued begins, and reads it again from there
   * after a backoff, instead of moving on past messages that were never
   * queued.
   */
  private hold(filePath: string, cursor: FileCursor, at: number, err: unknown): void {
    // Whatever the parser buffered of the file starts at or after `at`, so
    // reading again from there parses it again.
    this.parser.discard(filePath);
    cursor.read = at;
    // Everything before `at` is queued: a restart needn't read it again.
    this.save(filePath, cursor, at);
    this.backoff(filePath, reasonOf(err));
  }

  /** Schedules the next attempt at a held file, each one later than the last. */
  private backoff(filePath: string, reason: string): void {
    const prev = this.held.get(filePath);
    if (prev) clearTimeout(prev.timer);
    const attempts = (prev?.attempts ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
    const timer = setTimeout(() => this.processFile(filePath, true), delay);
    timer.unref?.();
    this.held.set(filePath, { attempts, retryAt: Date.now() + delay, timer });

    const at = this.cursors.get(filePath)?.read ?? 0;
    console.error(
      `[engram] ${attempts === 1 ? "couldn't" : "still can't"} queue messages from ${filePath} ` +
        `(${reason}); holding at byte ${at}, trying again in ${delay / 1000}s`,
    );
    recordCaptureStall(filePath, reason);
  }

  /** Ends a file's hold: its lines were queued after all, or there is
   *  nothing left to retry. */
  private release(filePath: string, why?: string): void {
    const hold = this.held.get(filePath);
    if (!hold) return;
    clearTimeout(hold.timer);
    this.held.delete(filePath);
    console.error(
      `[engram] ${why ?? `queued messages from ${filePath} again, after ${hold.attempts} failed attempt(s)`}`,
    );
    recordCaptureResumed(filePath);
  }

  /** Saves the resume offset — forward only: back would re-queue lines. */
  private save(filePath: string, cursor: FileCursor, offset: number): void {
    if (offset <= cursor.saved) return;
    try {
      this.db.setFileOffset(filePath, offset);
      cursor.saved = offset;
    } catch (err: unknown) {
      // The lines are queued. A restart reads them again; the next save
      // tries again.
      console.error(`[engram] couldn't save the read position of ${filePath}: ${reasonOf(err)}`);
    }
  }

  /** Replays the parser's resume context: the file's head, and the bytes
   *  just before where this process starts reading. */
  private restoreContext(fd: number, filePath: string, resumeAt: number): void {
    const { headBytes, tailBytes } = this.parser.resumeContext;
    const head = readLines(fd, 0, Math.min(resumeAt, headBytes));
    const tailStart = Math.max(head.end, resumeAt - tailBytes);
    const tail = tailStart < resumeAt ? readLines(fd, tailStart, resumeAt).lines : [];
    for (const line of [...head.lines, ...tail]) {
      if (!line.text.trim()) continue;
      this.guard(filePath, () => this.parser.restoreLine(line.text, filePath));
    }
  }

  /**
   * One line the parser can't handle must not wedge the file: every line
   * after it would never be read. A failure to queue is different. It says
   * nothing about the line, and skipping the line would lose it, so it
   * passes through, and processFile holds the file there (engram#584).
   */
  private guard(filePath: string, fn: () => void): void {
    try {
      fn();
    } catch (err: unknown) {
      if (err instanceof QueueWriteError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] skipped a line of ${filePath}: ${msg}`);
    }
  }
}

/** What daemon.db said, without the wrapping. */
function reasonOf(err: unknown): string {
  if (err instanceof QueueWriteError) return err.reason;
  return err instanceof Error ? err.message : String(err);
}

/**
 * The complete lines lying wholly within [start, end) of an open file, each
 * with the byte offset it starts at, and the offset just past the last one
 * (`start` when there is none). A line that `start` falls inside is skipped.
 * Offsets come from the raw bytes, so text that doesn't decode cleanly
 * can't shift them.
 */
export function readLines(
  fd: number,
  start: number,
  end: number,
): { lines: FileLine[]; end: number } {
  if (end <= start) return { lines: [], end: start };
  // One byte back, to tell whether `start` begins a line.
  const from = start > 0 ? start - 1 : 0;
  const buf = Buffer.alloc(end - from);
  const bytes = buf.subarray(0, readSync(fd, buf, 0, buf.length, from));

  let i = 0;
  if (start > 0) {
    const nl = bytes.indexOf(0x0a);
    if (nl < 0) return { lines: [], end: start };
    i = nl + 1;
  }
  const lines: FileLine[] = [];
  for (let nl = bytes.indexOf(0x0a, i); nl >= 0; nl = bytes.indexOf(0x0a, i)) {
    lines.push({ text: bytes.toString("utf-8", i, nl), offset: from + i });
    i = nl + 1;
  }
  return { lines, end: lines.length > 0 ? from + i : start };
}
