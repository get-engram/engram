import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Starting the worker, shared by `engram start` (commands.ts) and the Windows
// sign-in entry (login-start.ts).
//
// IMPORTANT: Node built-ins only. At sign-in, login-start.ts runs this module
// before the worker's ABI preflight, so nothing here may load better-sqlite3,
// directly or through another module: an addon built for a different Node
// would crash the start before the preflight could rebuild it (engram#496).

export const ENGRAM_DIR = join(homedir(), ".engram");
export const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
export const LOG_FILE = join(ENGRAM_DIR, "daemon.log");

/**
 * The worker script beside this module: dist/daemon/launch.js →
 * dist/daemon/worker.js. Exported for tests, which pass a Windows URL.
 *
 * fileURLToPath, never URL#pathname (engram#602). The pathname of
 * file:///C:/Users/… is "/C:/Users/…", which path.resolve on Windows turns
 * into "C:\C:\Users\…", so every background start there failed with
 * MODULE_NOT_FOUND. And the pathname is percent-encoded on every platform: an
 * install path with a space or a non-ASCII letter in it ("C:\Users\Ana
 * María\…") named a file that doesn't exist.
 */
export function workerPathFor(moduleUrl: string, windows?: boolean): string {
  return fileURLToPath(new URL("./worker.js", moduleUrl), { windows });
}

/** The Windows sign-in entry beside this module, resolved the same way. */
export function loginStartPathFor(moduleUrl: string, windows?: boolean): string {
  return fileURLToPath(new URL("./login-start.js", moduleUrl), { windows });
}

export function workerPath(): string {
  return workerPathFor(import.meta.url);
}

export function loginStartPath(): string {
  return loginStartPathFor(import.meta.url);
}

/**
 * Start the worker detached, logging to LOG_FILE. windowsHide: on Windows a
 * detached child otherwise gets a console window of its own, and closing
 * that window ends the daemon.
 */
export function spawnWorker(): ChildProcess {
  mkdirSync(ENGRAM_DIR, { recursive: true });
  const logFd = openSync(LOG_FILE, "a");
  try {
    const child = spawn(process.execPath, [workerPath()], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    return child;
  } finally {
    // The worker has its own handle on the log from here on.
    closeSync(logFd);
  }
}

/** The PID in the PID file when that process is alive; a stale file is removed. */
export function readPidFile(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      }
    }
  } catch {
    // no PID file
  }
  return null;
}
