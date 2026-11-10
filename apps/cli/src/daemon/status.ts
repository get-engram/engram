import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFileSync } from "../private-files.js";
import { plural } from "../output.js";
import { powerShellArgs, windowsPowerShellPath } from "./powershell.js";

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
  | "server"
  /** Engram paused saving for scheduled maintenance (`writes_paused`). It
   *  passes on its own, and nothing queued here is lost meanwhile. */
  | "paused"
  /** ~/.engram/vault-key is there but can't be read (engram#677): sends
   *  wait for it rather than go out without the vault's values scrubbed.
   *  The user must fix the file; nothing queued is lost meanwhile. */
  | "vault_key";

/**
 * Transcripts that can't be queued in daemon.db (engram#584): a full disk,
 * a daemon.db that is locked, read-only or damaged. Or, with `kind`
 * "config", transcripts held because ~/.engram/config.json can't say which
 * folders are excluded from capture (engram#673). Each such file is held
 * at the line that failed and retried with backoff, so its lines are read
 * again rather than skipped, but nothing new is captured from it meanwhile.
 */
export interface CaptureError {
  /** What daemon.db said, e.g. "database or disk is full"; with `kind`
   *  "config", what is wrong with config.json. Never the file's text. */
  message: string;
  /** When capture first stalled. Kept until every file is queued again. */
  since: string;
  /** How many transcripts are waiting. */
  files: number;
  /** "config": config.json can't be read. Absent: daemon.db can't queue. */
  kind?: "config";
}

/**
 * Opt-out deletes the key in use may not make (engram#597): the server
 * refused one for want of the 'delete' permission. A key's permissions
 * don't change, so they are kept on this machine and not tried again with
 * that key; a different key gets its own try.
 */
export interface DeleteRefused {
  /** When the server refused, under this key. */
  since: string;
  /** How many opt-out deletes wait for a key that can delete. */
  deletes: number;
}

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
  /**
   * Set while transcripts can't be queued locally. Separate from `health`,
   * which is about sending what was queued: a successful send says nothing
   * about whether new lines can be queued.
   */
  capture_error: CaptureError | null;
  /**
   * Set while no API key is saved on this machine (engram#594): after
   * `engram auth logout`, or a daemon started before any login. Nothing is
   * sent and nothing new is captured; what is already queued stays on this
   * machine. Not an error: `health` stays healthy.
   */
  signed_out_at: string | null;
  /**
   * When the daemon next tries what failed (engram#596): sending, or
   * creating a conversation. Failures that pass on their own (an error on
   * the server's side, the server out of reach, a rate limit, a pause) are
   * retried after a wait that doubles each time, up to a few minutes. Null
   * when nothing waits for a set time.
   */
  next_retry_at: string | null;
  /**
   * Set while the key in use can't delete conversations and opt-outs wait
   * for one that can (engram#597). Separate from `health`, which is about
   * sending: such a key still saves.
   */
  delete_refused: DeleteRefused | null;
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
  capture_error: null,
  signed_out_at: null,
  next_retry_at: null,
  delete_refused: null,
  updated_at: new Date().toISOString(),
};

let currentStatus: SyncStatus = { ...DEFAULT_STATUS };
let lastNotifiedError: string | null = null;

/** Transcripts this process can't queue right now (engram#584). */
const stalledFiles = new Set<string>();
/** At most one capture notification per hour: a daemon.db that is locked
 *  now and then would otherwise raise one per episode. */
const CAPTURE_NOTIFY_INTERVAL_MS = 60 * 60_000;
let lastCaptureNotifyAt = -Infinity;

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
    // 0600, and replaced in one step (engram#627): a reader never sees
    // half of it. Not flushed to disk: it is rewritten every few seconds.
    writePrivateFileSync(STATUS_FILE, JSON.stringify(currentStatus, null, 2), { durable: false });
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
  currentStatus.next_retry_at = null;
  lastNotifiedError = null;
  writeStatus();
}

/** What a failure carries besides its message and kind. */
export interface FailureDetails {
  /** A full memory's numbers, from the server's refusal. */
  storage?: { used?: number; limit?: number } | null;
  /** When the daemon tries again, in ms since the epoch; null or absent
   *  when that isn't set by a timer. */
  retryAt?: number | null;
}

/**
 * Record a sync failure. Logs once per error type and, for the states the
 * user must act on (auth, storage_full, vault_key), raises a desktop
 * notification on first occurrence — the daemon is headless, so a line in
 * daemon.log is not "telling" anyone.
 */
export function recordFailure(
  error: string,
  errorType: SyncStatus["error_type"],
  pendingMessages: number,
  details: FailureDetails = {},
): void {
  const { storage, retryAt } = details;
  currentStatus.consecutive_failures++;
  currentStatus.last_error = error;
  currentStatus.last_error_at = new Date().toISOString();
  currentStatus.error_type = errorType;
  currentStatus.pending_messages = pendingMessages;
  currentStatus.next_retry_at = retryAt == null ? null : new Date(retryAt).toISOString();
  if (
    errorType === "storage_full" &&
    typeof storage?.used === "number" &&
    typeof storage?.limit === "number"
  ) {
    currentStatus.storage = { used: storage.used, limit: storage.limit };
  }

  // Escalate health based on severity and consecutive failures
  if (
    errorType === "auth" ||
    errorType === "billing" ||
    errorType === "storage_full" ||
    errorType === "vault_key"
  ) {
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
    if (errorType === "auth" || errorType === "storage_full" || errorType === "vault_key") {
      const storage = currentStatus.storage;
      notifyDesktop(
        errorType === "storage_full" ? "Engram memory is full" : "Engram needs attention",
        errorType === "storage_full" && storage
          ? `${n(storage.used)}/${n(storage.limit)} messages used. New captures are paused.`
          : syncErrorSummary(errorType, storage).slice(0, 180),
      );
    }
  }
}

/**
 * When the daemon next tries what failed, between failures (engram#596):
 * one conversation's wait can end, and another's go on, with no failure
 * recorded in between. Written only when it changes.
 */
export function recordNextRetry(retryAt: number | null): void {
  const next = retryAt === null ? null : new Date(retryAt).toISOString();
  if (next === currentStatus.next_retry_at) return;
  currentStatus.next_retry_at = next;
  writeStatus();
}

/**
 * The key in use can't delete conversations, and `deletes` opt-out deletes
 * wait for one that can (engram#597). Written only when it changes; none
 * waiting clears it.
 */
export function recordDeletesRefused(deletes: number): void {
  const prev = currentStatus.delete_refused;
  if (deletes <= 0) {
    if (!prev) return;
    currentStatus.delete_refused = null;
  } else {
    if (prev?.deletes === deletes) return;
    currentStatus.delete_refused = { since: prev?.since ?? new Date().toISOString(), deletes };
  }
  writeStatus();
}

/**
 * A transcript's new lines couldn't be queued in daemon.db (engram#584),
 * or config.json couldn't say whether its folder is excluded (`kind`
 * "config", engram#673); the watcher holds the file at the failing line
 * and retries it. The first stall of an episode is logged as a warning and
 * raised as a desktop notification: when the disk is full, daemon.log and
 * status.json may not be writable either, and the notification still gets
 * through.
 */
export function recordCaptureStall(
  filePath: string,
  message: string,
  kind: "queue" | "config" = "queue",
): void {
  const first = stalledFiles.size === 0;
  stalledFiles.add(filePath);
  currentStatus.capture_error = {
    message,
    since: currentStatus.capture_error?.since ?? new Date().toISOString(),
    files: stalledFiles.size,
    ...(kind === "config" ? { kind } : {}),
  };
  writeStatus();
  if (!first) return;

  const summary = captureErrorSummary(currentStatus.capture_error);
  console.error(`[engram] WARNING: ${summary}`);
  console.error(`[engram] Run 'engram status' for details.`);
  if (Date.now() - lastCaptureNotifyAt >= CAPTURE_NOTIFY_INTERVAL_MS) {
    lastCaptureNotifyAt = Date.now();
    if (kind === "config") {
      // The message is short and names the file; it isn't cut.
      notifyDesktop(
        "Engram paused capture",
        `${message}, so Engram can't tell which folders you excluded. Fix it, and ` +
          `capture resumes where it stopped.`,
      );
      return;
    }
    // The reason is cut short, not the advice after it. The advice covers
    // a locked or read-only daemon.db as well as a full disk.
    const reason = message.length > 60 ? `${message.slice(0, 59)}…` : message;
    notifyDesktop(
      "Engram can't capture",
      `New messages can't be queued (${reason}). Free up disk space, or check ` +
        `~/.engram/daemon.db. Capture resumes where it stopped.`,
    );
  }
}

/** A stalled transcript was queued again, or there is nothing left to
 *  retry (the file is gone). The error clears once no file is waiting.
 *
 *  `quiet`: the watcher holding the file stopped (a sign-out or a switch of
 *  account, engram#594), so the hold is dropped without claiming capture
 *  resumed. The lines were never queued; the next watcher reads them again
 *  from the saved offset, and a failure there is a new stall. */
export function recordCaptureResumed(
  filePath: string,
  options: { quiet?: boolean } = {},
): void {
  if (!stalledFiles.delete(filePath)) return;
  if (stalledFiles.size > 0 && currentStatus.capture_error) {
    currentStatus.capture_error = { ...currentStatus.capture_error, files: stalledFiles.size };
  } else {
    currentStatus.capture_error = null;
    if (!options.quiet) {
      console.error("[engram] capture resumed: new messages are being queued again");
    }
  }
  writeStatus();
}

/**
 * No API key is saved: capture is paused and nothing is sent (engram#594).
 * Clears any sync error, since a rejected key's warning no longer applies
 * once the key is gone, and the pending count, since nothing is due to go.
 */
export function recordSignedOut(): void {
  clearSyncError();
  currentStatus.delete_refused = null;
  currentStatus.pending_messages = 0;
  currentStatus.signed_out_at = currentStatus.signed_out_at ?? new Date().toISOString();
  writeStatus();
}

/** A key is saved: capture and sync run. An error recorded under another
 *  key (or none) says nothing about this one, so it is cleared too, and so
 *  is another key's refusal to delete (engram#597). */
export function recordSignedIn(): void {
  clearSyncError();
  currentStatus.delete_refused = null;
  currentStatus.signed_out_at = null;
  writeStatus();
}

function clearSyncError(): void {
  currentStatus.health = "healthy";
  currentStatus.last_error = null;
  currentStatus.last_error_at = null;
  currentStatus.error_type = null;
  currentStatus.consecutive_failures = 0;
  currentStatus.storage = null;
  currentStatus.next_retry_at = null;
  lastNotifiedError = null;
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
      return "paused";
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

/**
 * A refusal the server would repeat however long the client waited
 * (engram#588): its own error code for a request it won't serve —
 * insufficient_scope (a key without the read scope can never read the
 * vault), a plan limit, a full memory. Not a rejected key: a new key fixes
 * that, and the daemon picks one up without a restart (engram#587). Not a
 * rate limit, a pause, a 5xx, or a code this doesn't know: those can pass.
 */
export function isRefusal(err: unknown): boolean {
  const { status, message } = errorParts(err);
  if (status === 429 || (status !== undefined && status >= 500)) return false;
  const code = bodyCode(message);
  if (!code) return false;
  const kind = classifyCode(code);
  return kind === "auth" || kind === "billing" || kind === "storage_full";
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

/**
 * True only when Engram's append tool answered that the conversation can't
 * be written to (engram#593): absent, deleted, or not this account's, which
 * the server doesn't tell apart. Its refusal carries the code
 * `conversation_not_found` (engram#592), and the SDK passes that body on as
 * the message of an error with no HTTP status.
 *
 * Narrower than isNotFound on purpose: the daemon stops sending the
 * conversation's messages on this answer, so anything else must stay an
 * ordinary failure that is retried. The bare phrase "Conversation not
 * found" is the delete tool's, not an answer to a send. An error that
 * carries a status, an HTTP 404 included, came from whatever answered at
 * that URL, which need not be Engram (a proxy, the wrong host).
 */
export function isConversationGone(err: unknown): boolean {
  const { status, message } = errorParts(err);
  if (status !== undefined) return false;
  return bodyCode(message) === "conversation_not_found";
}

/**
 * True when the server accepted the key but refused it a permission it
 * doesn't have: its `insufficient_scope` code. Only a different key can
 * fix that (engram#597). Read from the code, not the text: a message that
 * merely mentions the phrase is not the server's refusal.
 */
export function isScopeRefusal(err: unknown): boolean {
  return bodyCode(errorParts(err).message) === "insufficient_scope";
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
    case "paused":
      return "Engram is paused for scheduled maintenance — messages queued, will retry.";
    case "vault_key":
      return (
        "Your vault key (~/.engram/vault-key) can't be read, so messages wait here " +
        "rather than be sent with your vault's secrets in them. Nothing is lost."
      );
    default:
      return "Can't reach Engram — messages queued, will retry.";
  }
}

/**
 * One-line summary of a capture error, in the second person: the daemon
 * log, the desktop notification, `engram status` and the CLI banner.
 */
export function captureErrorSummary(c: CaptureError): string {
  const files = c.files === 1 ? "1 transcript is" : `${n(c.files)} transcripts are`;
  if (c.kind === "config") {
    return (
      `Engram can't read the folders you excluded from capture (${c.message}), so ${files} ` +
      `waiting. Fix the file, and capture picks up where it stopped: nothing is skipped, ` +
      `and nothing from an excluded folder is captured.`
    );
  }
  return (
    `Engram can't queue new messages on this machine (${c.message}), so ${files} ` +
    `waiting. Free up disk space, or check that ~/.engram/daemon.db can be ` +
    `written. Capture picks up where it stopped, so nothing is skipped.`
  );
}

/**
 * One-line summary of a config.json that can't be read (engram#673), from
 * the file itself, in the second person: the CLI banner and `engram
 * status`. The daemon records it only once a new message waits, and not at
 * all while it isn't running.
 */
export function configProblemSummary(message: string): string {
  return (
    `${message}, so Engram can't tell which folders you excluded from capture. ` +
    `New messages wait until it's fixed; nothing is skipped.`
  );
}

/**
 * One-line summary of opt-out deletes the key in use may not make
 * (engram#597), in the second person: `engram status`.
 */
export function deleteRefusedSummary(r: DeleteRefused): string {
  const which = `${plural(r.deletes, "conversation")} you opted out of ${r.deletes === 1 ? "is" : "are"}`;
  return (
    `This API key can't delete conversations, so ${which} waiting to be deleted from ` +
    `Engram. Create a key with the 'delete' permission at getengram.app/dashboard, then ` +
    `run 'engram auth login <key>'.`
  );
}

/** Log a warning to stderr (goes to daemon.log). One line per error type. */
function logWarning(
  errorType: SyncStatus["error_type"],
  storage?: { used: number; limit: number } | null,
): void {
  console.error(`[engram] WARNING: ${syncErrorSummary(errorType, storage)}`);
  console.error(`[engram] Run 'engram status' for details.`);
}

/** A notifier that hangs (a PowerShell that never finishes loading, a stuck
 *  notification service) is ended, not left running beside the daemon. */
const NOTIFY_TIMEOUT_MS = 30_000;

/**
 * The Windows toast (engram#614), one PowerShell statement each. The title
 * and body never become script: they arrive in environment variables and go
 * into the toast as XML text nodes, so quotes, `$(...)`, backticks, `<b>` or
 * `%PATH%` in them are shown as written, never run or parsed. There are no
 * double quotes, which the Windows command line would have to escape.
 *
 * The toast goes out under Windows PowerShell's app ID, which every Windows
 * 10 and 11 has registered, so Windows shows it as from Windows PowerShell.
 */
export const TOAST_STATEMENTS: readonly string[] = [
  "$ErrorActionPreference = 'Stop'",
  "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "$text = $template.GetElementsByTagName('text')",
  "$null = $text.Item(0).AppendChild($template.CreateTextNode($env:ENGRAM_NOTIFY_TITLE))",
  "$null = $text.Item(1).AppendChild($template.CreateTextNode($env:ENGRAM_NOTIFY_BODY))",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($template)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)",
];

/** How to show a desktop notification here, or null where there is no way. */
export function notifyCommand(
  title: string,
  body: string,
  platform: NodeJS.Platform = process.platform,
  systemRoot: string = process.env.SystemRoot || "C:\\Windows",
): { file: string; args: string[]; env?: Record<string, string> } | null {
  if (platform === "darwin") {
    const esc = (s: string) => s.replace(/["\\]/g, "\\$&");
    return {
      file: "osascript",
      args: ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`],
    };
  }
  if (platform === "linux") return { file: "notify-send", args: [title, body] };
  if (platform === "win32") {
    return {
      // Windows PowerShell by its full path, never a powershell.exe found on
      // PATH or in the working directory. It ships with Windows, and it can
      // load the Windows notification API, which PowerShell 7 cannot.
      file: windowsPowerShellPath(systemRoot),
      args: powerShellArgs(TOAST_STATEMENTS),
      env: { ENGRAM_NOTIFY_TITLE: title, ENGRAM_NOTIFY_BODY: body },
    };
  }
  return null;
}

/**
 * Best-effort desktop notification. The daemon runs headless (under launchd
 * on macOS, started at sign-in on Windows), so stderr goes to daemon.log
 * where nobody reads it — for states that need a human decision, this is
 * the only channel that actually reaches them.
 *
 * Deliberately fire-and-forget and fully swallowed: notification tooling is
 * absent on plenty of systems (headless Linux, minimal containers) and a
 * failure to notify must never disturb syncing. `done` is called once it
 * has been shown, or has failed, or there was no way to show it.
 */
function notifyDesktop(title: string, body: string, done: () => void = () => {}): void {
  try {
    // A static import (engram#581): this used to be a lazy `require`, which
    // does not exist in this ES-module build. It threw, the catch below
    // swallowed it, and no notification was ever shown.
    const command = notifyCommand(title, body);
    if (!command) {
      done();
      return;
    }
    execFile(
      command.file,
      command.args,
      {
        // The daemon's own environment, plus the title and body on Windows.
        env: command.env && { ...process.env, ...command.env },
        windowsHide: true,
        timeout: NOTIFY_TIMEOUT_MS,
      },
      () => done(),
    );
  } catch {
    // no notification tooling — the log line and the CLI banner still stand
    done();
  }
}

/**
 * A desktop notification from a daemon about to exit: settles once it has
 * been shown, or after `ms`. launchd and systemd end whatever a job leaves
 * running when its main process exits, so a notifier started just before
 * the exit, and not waited for, would never be shown.
 */
export function notifyDesktopBeforeExit(title: string, body: string, ms = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    notifyDesktop(title, body, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
