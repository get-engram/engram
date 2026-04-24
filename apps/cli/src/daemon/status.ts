import { writeFileSync, readFileSync, existsSync } from "node:fs";
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

  // Log once per error type (not per unique message) to avoid spam
  if (errorType !== lastNotifiedError) {
    lastNotifiedError = errorType;
    logWarning(errorType);
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

/** Log a warning to stderr (goes to daemon.log). One line per error type. */
function logWarning(errorType: SyncStatus["error_type"]): void {
  const warnings: Record<string, string> = {
    auth: "Authentication failed — run 'engram auth login'",
    billing: "Plan limit reached — upgrade at https://getengram.app/pricing. Messages are queued locally and will retry with backoff.",
    rate_limit: "Rate limited — messages queued, will retry",
    network: "Can't reach servers — messages queued locally",
    server: "Server error — messages queued, will retry",
  };

  const msg = warnings[errorType ?? "network"] ?? "Unknown sync error";
  console.error(`[engram] WARNING: ${msg}`);
  console.error(`[engram] Run 'engram status' for details.`);
}
