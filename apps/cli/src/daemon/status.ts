import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_FILE = join(homedir(), ".engram", "status.json");

export type SyncHealth = "healthy" | "warning" | "error";

export interface SyncStatus {
  health: SyncHealth;
  last_sync_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  error_type: "auth" | "billing" | "rate_limit" | "network" | "server" | null;
  pending_messages: number;
  consecutive_failures: number;
  updated_at: string;
}

const DEFAULT_STATUS: SyncStatus = {
  health: "healthy",
  last_sync_at: null,
  last_error_at: null,
  last_error: null,
  error_type: null,
  pending_messages: 0,
  consecutive_failures: 0,
  updated_at: new Date().toISOString(),
};

let currentStatus: SyncStatus = { ...DEFAULT_STATUS };
let lastNotifiedError: string | null = null;

export function readStatus(): SyncStatus {
  try {
    if (existsSync(STATUS_FILE)) {
      return JSON.parse(readFileSync(STATUS_FILE, "utf-8"));
    }
  } catch {
    // corrupt or missing
  }
  return { ...DEFAULT_STATUS };
}

function writeStatus(): void {
  currentStatus.updated_at = new Date().toISOString();
  try {
    writeFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2));
  } catch {
    // best effort
  }
}

/** Record a successful sync. */
export function recordSuccess(pendingMessages: number): void {
  currentStatus.health = "healthy";
  currentStatus.last_sync_at = new Date().toISOString();
  currentStatus.last_error = null;
  currentStatus.last_error_at = null;
  currentStatus.error_type = null;
  currentStatus.pending_messages = pendingMessages;
  currentStatus.consecutive_failures = 0;
  lastNotifiedError = null;
  writeStatus();
}

/** Record a sync failure. Sends a desktop notification on first occurrence. */
export function recordFailure(
  error: string,
  errorType: SyncStatus["error_type"],
  pendingMessages: number,
): void {
  currentStatus.consecutive_failures++;
  currentStatus.last_error = error;
  currentStatus.last_error_at = new Date().toISOString();
  currentStatus.error_type = errorType;
  currentStatus.pending_messages = pendingMessages;

  // Escalate health based on severity and consecutive failures
  if (errorType === "auth" || errorType === "billing") {
    currentStatus.health = "error";
  } else if (currentStatus.consecutive_failures >= 5) {
    currentStatus.health = "error";
  } else {
    currentStatus.health = "warning";
  }

  writeStatus();

  // Notify on first occurrence of each error type (don't spam)
  const notifyKey = `${errorType}:${error}`;
  if (notifyKey !== lastNotifiedError) {
    lastNotifiedError = notifyKey;
    notify(errorType, error);
  }
}

/** Update pending count without changing health. */
export function updatePending(count: number): void {
  currentStatus.pending_messages = count;
  writeStatus();
}

function classifyError(message: string): SyncStatus["error_type"] {
  if (message.includes("401") || message.includes("403") || message.includes("Authentication")) {
    return "auth";
  }
  if (message.includes("402") || message.includes("limit_exceeded") || message.includes("billing")) {
    return "billing";
  }
  if (message.includes("429") || message.includes("rate")) {
    return "rate_limit";
  }
  if (message.includes("5") && /\b5\d{2}\b/.test(message)) {
    return "server";
  }
  return "network";
}

export { classifyError };

// macOS desktop notification via osascript
function notify(errorType: SyncStatus["error_type"], detail: string): void {
  if (process.platform !== "darwin") return;

  const titles: Record<string, string> = {
    auth: "Engram: Authentication Failed",
    billing: "Engram: Billing Issue",
    rate_limit: "Engram: Rate Limited",
    network: "Engram: Connection Lost",
    server: "Engram: Server Error",
  };

  const messages: Record<string, string> = {
    auth: "Your API key is invalid or expired. Run 'engram auth login' to fix.",
    billing: "Your plan limit has been reached. Upgrade at getengram.app/pricing",
    rate_limit: "Too many requests. Messages are queued and will retry.",
    network: "Can't reach Engram servers. Messages are safely queued locally.",
    server: "Engram servers are having issues. Messages are safely queued.",
  };

  const title = titles[errorType ?? "network"] ?? "Engram: Sync Warning";
  const message = messages[errorType ?? "network"] ?? detail;

  try {
    execSync(
      `osascript -e 'display notification "${message}" with title "${title}"'`,
      { stdio: "pipe", timeout: 3000 },
    );
  } catch {
    // notification failed, not critical
  }
}
