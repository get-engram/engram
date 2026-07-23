import { watch, type FSWatcher } from "chokidar";
import { openSync, readSync, closeSync, statSync } from "node:fs";
import { DaemonDb } from "./db.js";
import type { OnMessages, LineParser, HostAdapter } from "./types.js";

/**
 * Watches one host's session directory for JSONL files and feeds new
 * lines to that host's parser (engram#261). Uses byte-offset tracking so
 * it never re-reads already-processed content, even after daemon
 * restart. One Watcher per host adapter.
 */
export class Watcher {
  private db: DaemonDb;
  private parser: LineParser;
  private fsWatcher: FSWatcher | null = null;
  private watchDir: string;
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

  stop(): void {
    this.parser.flush();
    this.fsWatcher?.close();
    this.fsWatcher = null;
  }

  private processFile(filePath: string): void {
    if (!filePath.endsWith(".jsonl")) return;

    try {
      const stat = statSync(filePath);
      const savedOffset = this.db.getFileOffset(filePath);

      // Nothing new
      if (stat.size <= savedOffset) return;

      const fd = openSync(filePath, "r");
      try {
        const bytesToRead = stat.size - savedOffset;
        const buffer = Buffer.alloc(bytesToRead);
        readSync(fd, buffer, 0, bytesToRead, savedOffset);

        const text = buffer.toString("utf-8");
        const lines = text.split("\n");

        // If the last chunk doesn't end with newline, it's incomplete —
        // don't process it yet, we'll pick it up on the next change event
        const hasTrailingNewline = text.endsWith("\n");
        const completeLines = hasTrailingNewline ? lines.slice(0, -1) : lines.slice(0, -1);
        const incompleteTail = hasTrailingNewline ? "" : lines[lines.length - 1];

        let bytesProcessed = 0;
        for (const line of completeLines) {
          bytesProcessed += Buffer.byteLength(line, "utf-8") + 1; // +1 for \n
          if (line.trim()) {
            this.parser.processLine(line, filePath);
          }
        }

        // Only advance offset past complete lines
        if (bytesProcessed > 0) {
          this.db.setFileOffset(filePath, savedOffset + bytesProcessed);
        }

        // If there's an incomplete line, we intentionally don't advance
        // past it — next change event will re-read and complete it
        if (incompleteTail && incompleteTail.trim()) {
          // Will be picked up on next event
        }
      } finally {
        closeSync(fd);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] error reading ${filePath}: ${msg}`);
    }
  }
}
