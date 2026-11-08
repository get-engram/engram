import { execFile } from "node:child_process";
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

/**
 * What an error says about itself. The SDK throws typed errors: an
 * AuthenticationError for an HTTP 401/403, an EngramError carrying the HTTP
 * status for an error response, and, for a tool's own refusal, an
 * EngramError whose message IS the server's JSON body
 * (`{"error":"storage_full",…}`).
 */
interface ErrorParts {
  name: string;
  code: string;
  status: number | undefined;
  message: string;
}

function errorParts(err: unknown): ErrorParts {
  if (err !== null && typeof err === "object") {
    const e = err as Record<string, unknown>;
    return {
      name: typeof e.name === "string" ? e.name : "",
      code: typeof e.code === "string" ? e.code : "",
      status: typeof e.status === "number" ? e.status : undefined,
      message: typeof e.message === "string" ? e.message : "",
    };
  }
  return { name: "", code: "", status: undefined, message: String(err ?? "") };
}

/**
 * The server's error code when the message carries its JSON body: "" for a
 * body without one, null when there is no JSON body at all.
 */
function bodyCode(message: string): string | null {
  const start = message.indexOf("{");
  if (start === -1) return null;
  try {
    const body: unknown = JSON.parse(message.slice(start));
    if (!body || typeof body !== "object") return null;
    const code = (body as { error?: unknown }).error;
    return typeof code === "string" ? code : "";
  } catch {
    return null;
  }
}

function classifyCode(code: string): SyncErrorType | null {
  switch (code) {
    case "storage_full":
      return "storage_full";
    // The key works but may not write: only a different key can fix it.
    case "insufficient_scope":
      return "auth";
    case "rate_limit_exceeded":
      return "rate_limit";
    case "writes_paused":
      return "server";
  }
  // message_limit_exceeded, indexing_quota_exceeded,
  // conversation_limit_exceeded, …: a plan limit.
  if (code.endsWith("limit_exceeded") || code.endsWith("quota_exceeded")) return "billing";
  return null;
}

const AUTH_PHRASE =
  /\bunauthori[sz]ed\b|\bforbidden\b|\bauthentication (?:failed|error|required)\b|\binvalid (?:or missing )?api key\b/i;

/**
 * Which kind of failure an error is, and so how the daemon treats it.
 *
 * Read from the error's structure first (engram#587): the SDK's error type
 * and code, then the server's JSON error code, then the HTTP status. The
 * message text comes last. It used to be all there was, searched for "401",
 * "403", "429", "rate" … and every one of those went wrong somewhere:
 *  - the SDK's AuthenticationError reads "Invalid or missing API key", so a
 *    rejected key passed as a network error and was retried every 2 s;
 *  - a 429 arrives with an empty message, so it passed as a network error;
 *  - indexing_quota_exceeded and insufficient_scope matched nothing;
 *  - a usage count in a refusal body containing 401 or 403 read as a
 *    rejected key, which stopped syncing until the daemon restarted;
 *  - "rate" matched "generate" and "separate".
 *
 * Plain strings are still accepted (tests, and any error that isn't the
 * SDK's). A status number in the text counts only outside a JSON body:
 * inside one it is data.
 */
export function classifyError(err: unknown): SyncErrorType {
  const { name, code, status, message } = errorParts(err);

  if (name === "AuthenticationError" || code === "auth_error" || status === 401 || status === 403) {
    return "auth";
  }

  const body = bodyCode(message);
  const byCode = body ? classifyCode(body) : null;
  if (byCode) return byCode;

  if (status === 429) return "rate_limit";
  if (status === 402) return "billing";
  if (status !== undefined && status >= 500) return "server";

  const head = body === null ? message : message.slice(0, message.indexOf("{"));
  // Must precede the generic billing check: a storage_full body also carries
  // a 402, but it is a different situation — backing off and retrying can
  // never clear it, so it gets its own state and its own copy.
  if (message.includes("storage_full")) return "storage_full";
  if (/\b429\b/.test(head) || /rate[ _-]?limit|too many requests/i.test(message)) return "rate_limit";
  if (/\b402\b/.test(head) || /(?:limit|quota)_exceeded|\bbilling\b/i.test(message)) return "billing";
  if (/\b40[13]\b/.test(head) || AUTH_PHRASE.test(message)) return "auth";
  if (/\b5\d\d\b/.test(head)) return "server";
  return "network";
}

const NOT_FOUND = /^\s*(?:conversation[ _])?not[ _]found\s*\.?\s*$/i;

/**
 * True only when Engram itself answered that the conversation isn't there:
 * the delete tool's `{"error":"Conversation not found"}`, which the SDK
 * passes on as the message of an error with no HTTP status.
 *
 * Deliberately narrow (engram#587). The opt-out delete treats "not found"
 * as done, so a false match keeps a conversation the user said not to save,
 * and nothing retries it. "getaddrinfo ENOTFOUND" is a DNS failure. An
 * error that carries a status (an SDK NotFoundError included) came from
 * whatever answered at that URL, which need not be Engram: a proxy or the
 * wrong host saying 404 says nothing about the conversation.
 */
export function isNotFound(err: unknown): boolean {
  const { status, message } = errorParts(err);
  if (status !== undefined) return false;
  return NOT_FOUND.test(bodyCode(message) ?? message);
}

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
      return (
        "Your API key was rejected — run 'engram auth login'. New captures are " +
        "queued locally and sync as soon as a working key is saved."
      );
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
    // A static import (engram#581): this used to be a lazy `require`, which
    // does not exist in this ES-module build. It threw, the catch below
    // swallowed it, and no notification was ever shown.
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
