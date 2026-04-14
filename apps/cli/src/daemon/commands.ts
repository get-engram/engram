import { spawn } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bold, dim } from "../output.js";
import { DaemonDb } from "./db.js";

const ENGRAM_DIR = join(homedir(), ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");

// Resolve the worker script path relative to this file's compiled location
function getWorkerPath(): string {
  // In dist: dist/daemon/commands.js → dist/daemon/worker.js
  const dir = new URL(".", import.meta.url).pathname;
  return resolve(dir, "worker.js");
}

function readPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    // Check if process is alive
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      // Process is dead, clean up stale PID file
      try { unlinkSync(PID_FILE); } catch { /* ignore */ }
      return null;
    }
  } catch {
    return null;
  }
}

export async function daemonStart(
  _args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const existing = readPid();
  if (existing) {
    console.log(`Daemon already running (pid ${existing})`);
    return;
  }

  const foreground = "foreground" in flags || "f" in flags;

  if (foreground) {
    console.log("Starting daemon in foreground...");
    // Import and run worker directly
    await import("./worker.js");
    return;
  }

  // Spawn detached worker process
  mkdirSync(ENGRAM_DIR, { recursive: true });

  const workerPath = getWorkerPath();
  const logFd = openSync(LOG_FILE, "a");

  const child = spawn(process.execPath, [workerPath], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  child.unref();

  // Give it a moment to start and write PID
  await new Promise((r) => setTimeout(r, 500));

  const pid = readPid();
  if (pid) {
    console.log(`${bold("Engram daemon started")} (pid ${pid})`);
    console.log(`${dim("Log:")} ${LOG_FILE}`);
    console.log(`${dim("DB:")}  ${DB_FILE}`);
  } else {
    console.error("Daemon may have failed to start. Check logs:");
    console.error(`  cat ${LOG_FILE}`);
    process.exit(1);
  }
}

export async function daemonStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log("Daemon is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (pid ${pid})`);
  } catch {
    console.error(`Failed to stop daemon (pid ${pid})`);
  }

  // Clean up PID file
  try { unlinkSync(PID_FILE); } catch { /* ignore */ }
}

export async function daemonStatus(): Promise<void> {
  const pid = readPid();

  if (!pid) {
    console.log(`${bold("Status:")} stopped`);

    // Still show DB stats if available
    if (existsSync(DB_FILE)) {
      const db = new DaemonDb(DB_FILE);
      const stats = db.getStats();
      db.close();
      console.log(`${dim("Sessions captured:")} ${stats.sessionsMapped}`);
      console.log(`${dim("Pending sync:")}      ${stats.pendingMessages} messages`);
      console.log(`${dim("Files tracked:")}     ${stats.trackedFiles}`);
    }
    return;
  }

  console.log(`${bold("Status:")} running (pid ${pid})`);

  if (existsSync(DB_FILE)) {
    const db = new DaemonDb(DB_FILE);
    const stats = db.getStats();
    db.close();
    console.log(`${dim("Sessions captured:")} ${stats.sessionsMapped}`);
    console.log(`${dim("Pending sync:")}      ${stats.pendingMessages} messages`);
    console.log(`${dim("Files tracked:")}     ${stats.trackedFiles}`);
  }

  console.log(`${dim("Log:")} ${LOG_FILE}`);
}
