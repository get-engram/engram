import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
 * Run `script` with this Node, detached, logging to LOG_FILE. windowsHide:
 * on Windows a detached child otherwise gets a console window of its own,
 * and closing that window ends the daemon.
 */
function spawnDetached(script: string, args: string[] = []): ChildProcess {
  prepareLogSync();
  const logFd = openSync(LOG_FILE, "a", PRIVATE_FILE_MODE);
  try {
    const child = spawn(process.execPath, [script, ...args], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    return child;
  } finally {
    // The child has its own handle on the log from here on.
    closeSync(logFd);
  }
}
