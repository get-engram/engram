import { watch, type FSWatcher } from "chokidar";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { DaemonDb } from "./db.js";
import type { OnMessages, LineParser, HostAdapter } from "./types.js";

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
 */
export class Watcher {
  private db: DaemonDb;
  private parser: LineParser;
  private fsWatcher: FSWatcher | null = null;
  private watchDir: string;
  private cursors = new Map<string, FileCursor>();
  private stopped = false;
  readonly host: string;

  constructor(db: DaemonDb, onMessages: OnMessages, adapter: HostAdapter) {
    this.db = db;
    this.parser = adapter.createParser(onMessages);
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
   * lines again.
   */
  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    for (const [filePath, cursor] of this.cursors) {
      if (this.parser.bufferedFrom(filePath) === null) continue;
      this.parser.flush(filePath);
      this.save(filePath, cursor, cursor.read);
    }
    this.parser.flush();
  }

  private processFile(filePath: string): void {
    if (this.stopped || !filePath.endsWith(".jsonl")) return;

    try {
      const size = statSync(filePath).size;
      let cursor = this.cursors.get(filePath);
      const resuming = !cursor;
      if (!cursor) {
        const saved = this.db.getFileOffset(filePath);
        cursor = { read: saved, saved };
      }

      // Nothing new
      if (size <= cursor.read) return;

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
        for (const line of lines) {
          if (!line.text.trim()) continue;
          this.guard(filePath, () => this.parser.processLine(line.text, filePath, line.offset));
        }
        cursor.read = end;
        this.cursors.set(filePath, cursor);

        const buffered = this.parser.bufferedFrom(filePath);
        this.save(filePath, cursor, buffered === null ? end : Math.min(end, buffered));
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] error reading ${filePath}: ${msg}`);
    }
  }

  /** Saves the resume offset — forward only: back would re-queue lines. */
  private save(filePath: string, cursor: FileCursor, offset: number): void {
    if (offset <= cursor.saved) return;
    this.db.setFileOffset(filePath, offset);
    cursor.saved = offset;
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

  /** One line the parser can't handle must not wedge the file: every line
   *  after it would never be read. */
  private guard(filePath: string, fn: () => void): void {
    try {
      fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] skipped a line of ${filePath}: ${msg}`);
    }
  }
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
