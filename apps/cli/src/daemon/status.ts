import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_FILE = join(homedir(), ".engram", "status.json");

export type SyncHealth = "healthy" | "warning" | "error";

export type SyncErrorType =
  | "auth"
  /** Lifetime memory is full. Distinct from `billing`: retrying will never
   *  succeed on its own — it needs an upgrade or deleted conversations. */
  | "storage_full"
  | "billing"
  | "rate_limit"
  | "network"
  | "server";

export interface SyncStatus {
  health: SyncHealth;
  last_sync_at: string | null;
  last_error_at: string | null;
  last_error: string | null;
  error_type: SyncErrorType | null;
  pending_messages: number;
  consecutive_failures: number;
  /** Populated on a storage_full error so the numbers can be shown without
   *  a network round trip (the CLI may be offline when it surfaces them). */
  storage: { used: number; limit: number } | null;
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
  storage: null,
  updated_at: new Date().toISOString(),
};

let currentStatus: SyncStatus = { ...DEFAULT_STATUS };
let lastNotifiedError: string | null = null;

export function readStatus(): SyncStatus {
  try {
    if (existsSync(STATUS_FILE)) {
      // Merged over the defaults: a status.json written by an older CLI
      // predates newer fields, and callers should get null rather than
      // undefined for them.
      return {
        ...DEFAULT_STATUS,
        ...(JSON.parse(readFileSync(STATUS_FILE, "utf-8")) as Partial<SyncStatus>),
      };
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
  currentStatus.storage = null;
  lastNotifiedError = null;
  writeStatus();
}

/**
 * Record a sync failure. Logs once per error type and, for the two states
 * the user must act on (auth, storage_full), raises a desktop notification
 * on first occurrence — the daemon is headless, so a line in daemon.log is
 * not "telling" anyone.
 */
export function recordFailure(
  error: string,
  errorType: SyncStatus["error_type"],
  pendingMessages: number,
  storage?: { used?: number; limit?: number } | null,
): void {
  currentStatus.consecutive_failures++;
  currentStatus.last_error = error;
  currentStatus.last_error_at = new Date().toISOString();
  currentStatus.error_type = errorType;
  currentStatus.pending_messages = pendingMessages;
  if (
    errorType === "storage_full" &&
    typeof storage?.used === "number" &&
    typeof storage?.limit === "number"
  ) {
    currentStatus.storage = { used: storage.used, limit: storage.limit };
  }

  // Escalate health based on severity and consecutive failures
  if (errorType === "auth" || errorType === "billing" || errorType === "storage_full") {
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
    logWarning(errorType, currentStatus.storage);
    if (errorType === "auth" || errorType === "storage_full") {
      notifyDesktop(errorType, currentStatus.storage);
    }
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
  // Must precede the generic billing check: a storage_full body also carries
  // a 402, but it is a different situation — backing off and retrying can
  // never clear it, so it gets its own state and its own copy.
  if (message.includes("storage_full")) {
    return "storage_full";
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

const n = (x: number) => x.toLocaleString("en-US");

/**
 * One-line summary of a sync error, in the second person. Shared by the
 * daemon log, the desktop notification, and the banner the CLI prints on
 * the next interactive command.
 */
export function syncErrorSummary(
  errorType: SyncStatus["error_type"],
  storage?: { used: number; limit: number } | null,
): string {
  switch (errorType) {
    case "auth":
      return "Authentication failed — run 'engram auth login'.";
    case "storage_full": {
      const size = storage ? `${n(storage.used)}/${n(storage.limit)} messages` : "its limit";
      return (
        `Engram's memory is full (${size}). Everything already saved is safe and ` +
        `searchable — but new captures are queued locally and will NOT be saved ` +
        `until you free space. Upgrade ($9/mo for 1,000,000 messages) or delete ` +
        `old conversations: https://getengram.app/pricing`
      );
    }
    case "billing":
      return "Plan limit reached — upgrade at https://getengram.app/pricing. Messages are queued locally and will retry with backoff.";
    case "rate_limit":
      return "Rate limited — messages queued, will retry.";
    case "server":
      return "Server error — messages queued, will retry.";
    default:
      return "Can't reach servers — messages queued locally.";
  }
}

/** Log a warning to stderr (goes to daemon.log). One line per error type. */
function logWarning(
  errorType: SyncStatus["error_type"],
  storage?: { used: number; limit: number } | null,
): void {
  console.error(`[engram] WARNING: ${syncErrorSummary(errorType, storage)}`);
  console.error(`[engram] Run 'engram status' for details.`);
}

/**
 * Best-effort desktop notification. The daemon runs headless under launchd,
 * so stderr goes to daemon.log where nobody reads it — for states that need
 * a human decision, this is the only channel that actually reaches them.
 *
 * Deliberately fire-and-forget and fully swallowed: notification tooling is
 * absent on plenty of systems (headless Linux, minimal containers) and a
 * failure to notify must never disturb syncing.
 */
function notifyDesktop(
  errorType: SyncStatus["error_type"],
  storage?: { used: number; limit: number } | null,
): void {
  const title = errorType === "storage_full" ? "Engram memory is full" : "Engram needs attention";
  const body =
    errorType === "storage_full" && storage
      ? `${n(storage.used)}/${n(storage.limit)} messages used. New captures are paused.`
      : syncErrorSummary(errorType, storage).slice(0, 180);
  try {
    // Lazy require: keeps the module import-light for the daemon bootstrap,
    // which deliberately avoids pulling in anything heavy at startup.
    const { execFile } = require("node:child_process") as typeof import("node:child_process");
    const done = () => {};
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
      execFile(
        "osascript",
        ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
        done,
      );
    } else if (process.platform === "linux") {
      execFile("notify-send", [title, body], done);
    }
  } catch {
    // no notification tooling — the log line and the CLI banner still stand
  }
}
