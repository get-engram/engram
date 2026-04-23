import { spawn, execSync } from "node:child_process";
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
import { bold, dim, red } from "../output.js";
import { DaemonDb } from "./db.js";
import { readStatus, type SyncStatus } from "./status.js";

const ENGRAM_DIR = join(homedir(), ".engram");
const PID_FILE = join(ENGRAM_DIR, "daemon.pid");
const DB_FILE = join(ENGRAM_DIR, "daemon.db");
const LOG_FILE = join(ENGRAM_DIR, "daemon.log");
const PLIST_NAME = "app.getengram.daemon";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${PLIST_NAME}.plist`);

// Resolve the worker script path relative to this file's compiled location
function getWorkerPath(): string {
  // In dist: dist/daemon/commands.js → dist/daemon/worker.js
  const dir = new URL(".", import.meta.url).pathname;
  return resolve(dir, "worker.js");
}

function readPid(): number | null {
  // First check PID file
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

  // Fall back to launchctl (launchd-managed process may not have PID file)
  return readLaunchdPid();
}

function readLaunchdPid(): number | null {
  if (!isLaunchdInstalled()) return null;
  try {
    const output = execSync(`launchctl list ${PLIST_NAME} 2>/dev/null`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const match = output.match(/"PID"\s*=\s*(\d+)/);
    if (match) return parseInt(match[1], 10);
    // Also check the tabular format: PID\tStatus\tLabel
    const lines = output.trim().split("\n");
    for (const line of lines) {
      const parts = line.split("\t");
      if (parts.length >= 1) {
        const pid = parseInt(parts[0], 10);
        if (!isNaN(pid) && pid > 0) return pid;
      }
    }
  } catch {
    // not loaded
  }
  return null;
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

    // Auto-install launchd if --install flag
    if ("install" in flags) {
      installLaunchd();
    }
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

  // Show sync health warnings
  const syncStatus = readStatus();
  printSyncWarnings(syncStatus);

  console.log(`${dim("Log:")} ${LOG_FILE}`);

  if (isLaunchdInstalled()) {
    console.log(`${dim("Auto-start:")} enabled (launchd)`);
  }
}

function printSyncWarnings(status: SyncStatus): void {
  if (status.health === "healthy") {
    if (status.last_sync_at) {
      console.log(`${dim("Last sync:")}        ${status.last_sync_at}`);
    }
    return;
  }

  const warnings: Record<string, string> = {
    auth: "Authentication failed — run 'engram auth login'",
    billing: "Plan limit reached — upgrade at getengram.app/pricing\n           Messages are queued locally and will retry with backoff.",
    rate_limit: "Rate limited — messages queued, will retry",
    network: "Can't reach servers — messages queued locally",
    server: "Server error — messages queued, will retry",
  };

  const msg = warnings[status.error_type ?? "network"] ?? status.last_error ?? "Unknown error";

  console.log("");
  console.log(red(`  WARNING: ${msg}`));
  if (status.pending_messages > 0) {
    console.log(red(`  ${status.pending_messages} messages waiting to sync`));
  }
  if (status.last_error_at) {
    console.log(dim(`  Since: ${status.last_error_at}`));
  }
  console.log("");
}

// ── Launchd integration ──

function generatePlist(): string {
  const workerPath = getWorkerPath();
  const nodePath = process.execPath;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${workerPath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_FILE}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_FILE}</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
  </dict>
</dict>
</plist>`;
}

function isLaunchdInstalled(): boolean {
  return existsSync(PLIST_PATH);
}

function installLaunchd(): void {
  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, generatePlist());

  try {
    execSync(`launchctl load -w "${PLIST_PATH}"`, { stdio: "pipe" });
    console.log(`${bold("Auto-start enabled")} — daemon will start on login`);
    console.log(`${dim("Plist:")} ${PLIST_PATH}`);
  } catch {
    console.log(`Plist written to ${PLIST_PATH}`);
    console.log("Run manually: launchctl load -w " + PLIST_PATH);
  }
}

function uninstallLaunchd(): void {
  if (!isLaunchdInstalled()) {
    console.log("Launchd agent not installed.");
    return;
  }

  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: "pipe" });
  } catch {
    // may already be unloaded
  }

  try {
    unlinkSync(PLIST_PATH);
  } catch {
    // ignore
  }

  console.log(`${bold("Auto-start disabled")} — launchd agent removed`);
}

export async function daemonInstall(): Promise<void> {
  installLaunchd();
}

export async function daemonUninstall(): Promise<void> {
  uninstallLaunchd();
}
