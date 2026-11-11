import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateFileSync, ensurePrivateDirSync, PRIVATE_FILE_MODE, restrictSync } from "../private-files.js";

// Starting the worker, shared by `engram start` (commands.ts), the Windows
// sign-in entry (login-start.ts) and the Windows supervisor (supervisor.ts).
//
// IMPORTANT: Node built-ins only. At sign-in, login-start.ts and the
// supervisor run this module before the worker's ABI preflight, so nothing
// here may load better-sqlite3, directly or through another module: an addon
// built for a different Node would crash the start before the preflight
// could rebuild it (engram#496).

export const ENGRAM_DIR = join(homedir(), ".engram");
/** Written by the daemon for CLIs from before engram#612; see instance.ts. */
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

/** The Windows supervisor beside this module (engram#613), resolved the same way. */
export function supervisorPathFor(moduleUrl: string, windows?: boolean): string {
  return fileURLToPath(new URL("./supervisor.js", moduleUrl), { windows });
}

export function workerPath(): string {
  return workerPathFor(import.meta.url);
}

export function loginStartPath(): string {
  return loginStartPathFor(import.meta.url);
}

export function supervisorPath(): string {
  return supervisorPathFor(import.meta.url);
}

/** How long `engram start` waits for the daemon it started to be ready. */
export const START_WAIT_MS = 10_000;

/**
 * ~/.engram made private, and the log in it created 0600 or set to it
 * (engram#627): the log repeats what the daemon does with the user's
 * transcripts. Before the worker starts, and before launchd opens the log
 * for it, which would create a missing one with the default 0644.
 */
export function prepareLogSync(): void {
  ensurePrivateDirSync(ENGRAM_DIR);
  createPrivateFileSync(LOG_FILE);
  restrictSync(LOG_FILE);
}

/**
 * Why the daemon's log can't be written, as an error code ("EACCES"), or
 * null when it can: it is there and opens for writing, or it isn't there
 * and the nearest folder there is lets it be made. Never makes anything.
 *
 * Without its log the daemon still captures (engram#679): `engram start`
 * runs it with its output dropped, the systemd unit with its output in the
 * journal, and the launchd job without a log. launchd won't start a job
 * whose log it can't open: it never runs it at all. Non-blocking, so a
 * FIFO left in its place is never waited on.
 */
export function logProblem(file = LOG_FILE): string | null {
  try {
    closeSync(openSync(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NONBLOCK ?? 0)));
    return null;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") return code ?? "EIO";
  }
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    try {
      accessSync(dir, constants.W_OK | constants.X_OK);
      return null;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" || dirname(dir) === dir) return code ?? "EIO";
    }
  }
}

/** Start the worker detached, logging to LOG_FILE. */
export function spawnWorker(): ChildProcess {
  return spawnDetached(workerPath());
}

/**
 * Start the Windows supervisor detached (engram#613): it starts the worker,
 * and starts it again after an error (see supervise.ts). `reportUntil` (ms
 * since the epoch): `engram start` waits on the first worker until then, and
 * the supervisor exits with START_FAILED_EXIT when that one can't start, for
 * `engram start` to report, rather than starting it again.
 */
export function spawnSupervisor(reportUntil?: number): ChildProcess {
  return spawnDetached(supervisorPath(), reportUntil ? [`--report-until=${Math.floor(reportUntil)}`] : []);
}

/**
 * Run `script` with this Node, detached, logging to LOG_FILE, or with its
 * output dropped when the log can't be opened (engram#679). windowsHide: on
 * Windows a detached child otherwise gets a console window of its own, and
 * closing that window ends the daemon.
 */
function spawnDetached(script: string, args: string[] = []): ChildProcess {
  const logFd = openLogSync();
  try {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      windowsHide: true,
      stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    return child;
  } finally {
    // The child has its own handle on the log from here on.
    if (logFd !== null) closeSync(logFd);
  }
}

/**
 * The log, opened to append the daemon's output to; null when it can't be:
 * another user's, as one a `sudo engram start` before 0.7.0 left, or one
 * made read-only (engram#679). The daemon doesn't need its log to capture,
 * and used to be refused a start without it. ~/.engram is made all the
 * same, and an error there still stops the start: nothing runs without it.
 * A log that is there is set to 0600 (engram#627); the open makes a missing
 * one 0600.
 */
function openLogSync(): number | null {
  ensurePrivateDirSync(ENGRAM_DIR);
  try {
    restrictSync(LOG_FILE);
    return openSync(LOG_FILE, "a", PRIVATE_FILE_MODE);
  } catch {
    return null;
  }
}
