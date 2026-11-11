import { createHash } from "node:crypto";
import type { Engram } from "@getengram/sdk";
import { DaemonDb } from "./db.js";
import {
  recordSuccess,
  recordFailure,
  recordNextRetry,
  recordSignedIn,
  recordSignedOut,
  recordDeletesRefused,
  classifyError,
  isConversationGone,
  isNotFound,
  isScopeRefusal,
} from "./status.js";
import { retryDelay, formatWait } from "./backoff.js";
import { parseStorageFullError } from "../storage-error.js";
import { isPathExcluded, detectOptOut } from "./exclusions.js";
import { queueing } from "./queue-error.js";
import { engramCommand } from "./package-runner.js";
import { plural } from "../output.js";
import { isDefaultServer, normalizeServer, sameServer } from "../server-url.js";
import { boundContent, stripBinaryPayloads } from "../message-bounds.js";
import type { SecretScrubber } from "./scrubber.js";
import { VaultKeyMismatch, VaultKeyUnreadable } from "../vault-key.js";
import type { ParsedMessage, SessionMeta, PendingRow } from "./types.js";

// Claude Code transcript messages can be enormous (tool output dumps), and
// the server does per-message work on append (R2 write, chunk, embed, index).
// 200-message batches reliably exceeded the request timeout and wedged the
// queue in a retry loop — same batch, same timeout, forever. Small batches
// with a byte budget keep every request comfortably inside the timeout; the
// halve-on-failure fallback (see flushConversation) resolves any batch that
// still can't make it through, down to one message at a time.
const BATCH_SIZE = 25;
const BATCH_BYTE_BUDGET = 256 * 1024;
const FLUSH_INTERVAL_MS = 2_000;
const CONCURRENCY = 5;

/** Backoff schedule for billing/limit errors: 5min → 15min → 1hr → 1hr ... */
const BILLING_BACKOFF_MS = [
  5 * 60_000,    // 5 minutes
  15 * 60_000,   // 15 minutes
  60 * 60_000,   // 1 hour (cap)
];

/**
 * Backoff schedule for a full memory: 1min → 2min → 5min → 5min ... The user
 * clears it, by upgrading or deleting conversations, and capture should
 * resume within minutes of that, not an hour. Retrying is cheap: the server
 * refuses the send before it writes anything.
 */
const STORAGE_FULL_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000];

/**
 * Pause schedule while the API key is rejected: 10min → 30min → 1hr → 1hr …
 * (engram#587). A rejected key used to stop syncing until the daemon
 * restarted, and nothing restarts it: `engram auth login` saves the new key
 * and leaves this process running with the old one. Now the daemon reads
 * the configured key every KEY_POLL_MS and switches to a new one at once;
 * this schedule only paces retries of the same key, for a key that was
 * refused for a while and accepted again.
 */
const AUTH_RETRY_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];

/**
 * How often the daemon reads the configured key (engram#594). A logout must
 * stop sending within seconds, and a new key must be used without a
 * restart. The read is of one small local file.
 */
const KEY_POLL_MS = 2_000;

/**
 * Retry schedule for asking the server which earlier keys are the current
 * key's account's, when it can't answer (network, 5xx, rate limit).
 */
const OWNERSHIP_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000];

/**
 * How long a session that already has a conversation under an earlier key
 * waits for that answer before it gets a conversation of its own under the
 * current key. Without the wait, a rotated key would give every session it
 * continues a second conversation in the same account. Past it, a server
 * that can't answer mustn't hold captures back for good: the worst case is
 * a session split across two conversations, never a lost message.
 */
const OWNERSHIP_GATE_MS = 15 * 60_000;

/**
 * The key fingerprint of a Syncer built with a fixed client and no
 * KeySource (tests, and callers that manage the key themselves). Not a
 * SHA-256, so the server is never asked about it.
 */
export const FIXED_KEY_FP = "fixed";

/** What a real key's fingerprint looks like (keyFingerprint). */
const KEY_HASH = /^[0-9a-f]{64}$/;

/** An account on a server other than the default (accountFingerprint):
 *  its key's hash, then its server's tag. */
const SERVER_ACCOUNT = /^([0-9a-f]{64})@([0-9a-f]{32})$/;

/**
 * The key's SHA-256 as lowercase hex (engram#594). It is the hash the server
 * keeps of the key, so the server can say which earlier keys are the same
 * account's. The key itself is never written to daemon.db.
 */
export function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * An account the daemon captures and sends for: an API key, and the server
 * it is a key of (engram#685). The two are read from config.json together,
 * and a change to either is a change of account.
 */
export interface Account {
  key: string;
  /** The server's base URL (resolveBaseUrl). */
  server: string;
}

/**
 * What daemon.db records about the account a message was captured for
 * (engram#594, engram#685). On the default server, the key's fingerprint
 * (keyFingerprint), as before servers were recorded, so nothing recorded
 * then changes. On any other server, the key's fingerprint followed by
 * "@" and a tag of the server's address, so what is queued for one server
 * is never sent to another. Neither the key nor the address is written.
 */
export function accountFingerprint(account: Account): string {
  const keyHash = keyFingerprint(account.key);
  if (isDefaultServer(account.server)) return keyHash;
  const tag = createHash("sha256").update(normalizeServer(account.server)).digest("hex").slice(0, 32);
  return `${keyHash}@${tag}`;
}

/** Whether `a` and `b` are the same account: the same key, for the same
 *  server. */
export function sameAccount(a: Account | undefined, b: Account | undefined): boolean {
  if (!a || !b) return a === b;
  return a.key === b.key && sameServer(a.server, b.server);
}

/** What a server may be asked about in checkOwnership (ownershipCandidates). */
export interface OwnershipCandidate {
  /** The account fingerprint the rows are under. */
  fp: string;
  /** The key hash the server is asked about. */
  keyHash: string;
  /** Only the rows without a record of their server may move (adoptKeys). */
  unknownServerOnly: boolean;
}

/**
 * Which of `others` (other account fingerprints in daemon.db) the server of
 * the account `runFp` may be asked about, each with the key hash to ask
 * with (checkOwnership). What it confirms is its account's is sent with
 * that account (engram#685):
 *
 * - The default server: what was queued under another key for it, or
 *   before servers were recorded, as before. Never what was queued for
 *   another server.
 * - Any other server: what was queued for that same server under another
 *   key. And, under any key in `unknownServer` (its own included), what
 *   was queued before servers were recorded (daemon.db version 4): then a
 *   key's fingerprint alone stood for whatever server was configured, so
 *   it may be this server's, and the server confirms the key is its
 *   account's before it moves. Never what was recorded for the default
 *   server: an answer from another server doesn't make it that server's.
 */
export function ownershipCandidates(
  runFp: string,
  others: readonly string[],
  unknownServer: ReadonlySet<string>,
): OwnershipCandidate[] {
  const run = SERVER_ACCOUNT.exec(runFp);
  const candidates: OwnershipCandidate[] = [];
  for (const fp of others) {
    if (!run) {
      if (KEY_HASH.test(fp)) candidates.push({ fp, keyHash: fp, unknownServerOnly: false });
      continue;
    }
    const other = SERVER_ACCOUNT.exec(fp);
    if (other) {
      if (other[2] === run[2]) candidates.push({ fp, keyHash: other[1], unknownServerOnly: false });
    } else if (KEY_HASH.test(fp) && unknownServer.has(fp)) {
      candidates.push({ fp, keyHash: fp, unknownServerOnly: true });
    }
  }
  return candidates;
}

/** A settled promise, for the paths of onMessages that have nothing left to do. */
const DONE: Promise<void> = Promise.resolve();

/**
 * Where the daemon's account, its API key and server, comes from
 * (engram#587, engram#594, engram#685). It is read again every
 * KEY_POLL_MS: a new key or server is used without a restart, and no key
 * stops capture and sending.
 */
export interface KeySource {
  /** The account configured at start, if any. */
  current?: Account;
  /**
   * config.json couldn't be read at start, so which account is configured
   * isn't known: nothing is captured or sent until it has been read.
   */
  unread?: boolean;
  /**
   * The account configured now: its key from ENGRAM_API_KEY, else
   * ~/.engram/config.json, and its server from ENGRAM_BASE_URL, else
   * config.json, else the default, read together. Throws when config.json
   * is needed and can't be read or parsed. That is not a logout: the
   * account in use stays until the file can be read.
   */
  read(): Promise<Account | undefined>;
  /** A client for an account. */
  connect(account: Account): Engram;
  /** No key is configured any more: let go of what was built for the last
   *  one (the vault read through it). Called after capture has stopped. */
  disconnect?(): void;
  /**
   * Which of `keyHashes` (key fingerprints) are keys of `account`, asked
   * of its server. Throws when the server doesn't answer; an Error with a
   * numeric `status` when it refused.
   */
  ownedKeys?(account: Account, keyHashes: string[]): Promise<string[]>;
}

/**
 * Starts and stops reading transcripts (engram#594). Capture runs only
 * while a key is configured, so whatever is read is queued for the account
 * signed in at the time. `stop(true)` first reads what was written but not
 * read yet: when the account changes, those lines are queued for the
 * account they were written under.
 */
export interface CaptureControl {
  start(): void;
  stop(drain: boolean): void;
}

/**
 * One account in use: its fingerprint and client. A flush works with one
 * Run from start to end, and once the account changes a Run that is no
 * longer `active` starts no new request.
 */
interface Run {
  fp: string;
  client: Engram;
  /** The key and server, in memory only (absent for a fixed client). */
  account?: Account;
}

/** What the server has said about which earlier keys are the current key's
 *  account's (checkOwnership). */
interface Ownership {
  answered: boolean;
  /** When the current key first asked (0: not yet). */
  firstAskedAt: number;
  retryAt: number;
  step: number;
}

function freshOwnership(): Ownership {
  return { answered: false, firstAskedAt: 0, retryAt: 0, step: 0 };
}

/**
 * How one conversation's turn in a flush ended (engram#580). Only "sent"
 * means its queue is empty, and only a flush in which every conversation
 * sent is a successful sync.
 */
type SendOutcome =
  | "sent" // everything queued for it went out
  | "retry" // a send failed, or the key changed; its rows stay queued for a later flush
  | "backoff" // the account hit a billing or storage limit
  | "auth" // the API key was rejected; sending pauses (AUTH_RETRY_MS)
  | "wait" // a rate limit or a maintenance pause holds the account (engram#596)
  | "gone"; // Engram doesn't have the conversation; its rows stay here, not sent (engram#593)

/** When one thing that failed is tried again, and how many times in a row
 *  it has failed. */
interface Wait {
  until: number;
  step: number;
}

/** Retry schedule for one session whose conversation create failed with an
 *  ordinary error (network, 5xx, rejected input). Its messages stay queued
 *  in daemon.db throughout — this only paces the retries. */
const CREATE_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000];

/**
 * After Engram answers that it doesn't have a conversation (engram#593),
 * when it is asked again: the n-th such answer in a row is followed by a
 * check after the n-th wait here, and the answer after the last of them is
 * final (about four days after the first). A check sends one message. If
 * that goes through, Engram has the conversation after all (a restore, or
 * an answer that was wrong) and the rest follows as usual.
 *
 * Until then the conversation's messages, and any captured for its session
 * later, stay in daemon.db and aren't sent. The conversation is never
 * created again: the user may have deleted it, and a deleted conversation
 * must not come back. Kept in daemon.db, so a restart doesn't start the
 * schedule over.
 */
export const GONE_RECHECK_MS = [
  10 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  72 * 60 * 60_000,
];

/** When a conversation Engram said `checks` times it doesn't have, last at
 *  `checkedAt`, is checked again; null: never. */
function goneRecheckAt(checkedAt: number, checks: number): number | null {
  const wait = GONE_RECHECK_MS[checks - 1];
  return wait === undefined ? null : checkedAt + wait;
}

/**
 * Batches parsed messages and sends them to the Engram API.
 * If offline, messages sit in the SQLite queue and are retried
 * on the next flush cycle.
 *
 * Every queued message records the key it was captured under (engram#594),
 * as a fingerprint, and is sent only with that key or with a key the server
 * confirmed is the same account's (a rotated or re-issued key). The
 * configured key is read every KEY_POLL_MS. A new key is used from the next
 * request on; no key, after `engram auth logout`, stops capture and sending
 * at once. Nothing queued is deleted either way: it waits on this machine
 * until its account signs in again.
 *
 * While signed out, capture stops and each transcript's read offset stays
 * where it was, so what is written meanwhile is read, and queued, for the
 * next account that signs in.
 */
export class Syncer {
  private db: DaemonDb;
  /** The key in use; null while signed out. */
  private active: Run | null;
  /** The key captures are queued under (null: signed out). */
  private captureFp: string | null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private keyTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  /** A read of the configured key in progress, shared by its callers. */
  private keyCheck: Promise<void> | null = null;
  /** stop() was called: capture doesn't start again, and a key change only
   *  stops sending. */
  private stopped = false;
  private capture: CaptureControl | null = null;
  private capturing = false;

  /** Paused because the API key was rejected: until when, and how many
   *  pauses in a row without a request going through. */
  private authHeldUntil = 0;
  private authHoldStep = 0;
  /** The account configured when it was last read (undefined: none). */
  private currentAccount: Account | undefined;
  /** config.json hasn't been read since start (KeySource.unread): which
   *  account is configured isn't known yet. */
  private unread = false;
  /** The fingerprint rows that belonged to no key were last handed to. */
  private claimedFor: string | null = null;
  private ownership: Ownership = freshOwnership();
  /** The sessions the ownership gate holds were logged, under this key. */
  private gateLogged = false;
  /** The last message logged for each lasting problem, so a problem that
   *  lasts is logged once, not on every poll. */
  private problems = new Map<string, string>();

  /** Billing backoff state */
  private billingBackoffUntil: number = 0;
  private billingBackoffStep: number = 0;

  /** Sessions whose conversation create failed: when to try again. The
   *  sessions themselves live in daemon.db (engram#370) — losing this map
   *  on a restart only means an earlier retry. */
  private createRetry = new Map<string, Wait>();

  /**
   * Nothing is sent from this account until this time, after the server
   * refused a request for when it came rather than for what it carried: a
   * rate limit, or a pause for maintenance (engram#596). `throttleStep`
   * counts such pauses in a row without a request going through.
   */
  private throttledUntil = 0;
  private throttleStep = 0;
  /** A maintenance pause is among those pauses. It holds only sends, so a
   *  create or a delete going through doesn't show it's over. */
  private throttlePaused = false;

  /**
   * Conversations whose last send failed in a way that passes on its own
   * (the server out of reach, a timeout, an error on the server's side):
   * when each is tried again (engram#596). Like createRetry, a restart only
   * means an earlier retry; the rows themselves stay queued in daemon.db.
   */
  private sendRetry = new Map<string, Wait>();

  /** Opt-out deletes that failed the same way: when each is tried again. */
  private deleteRetry = new Map<string, Wait>();

  /**
   * The key in use may not delete conversations: the server refused an
   * opt-out's delete for want of the 'delete' permission (engram#597). A
   * key's permissions don't change, so its deletes are kept and not tried
   * again with it: they used to be retried, and logged, for as long as the
   * key was in use. A different key tries again, and so does a restart.
   */
  private deletesRefused = false;

  /** Rows orphaned by a pre-#370 daemon are adopted once per process. */
  private orphansAdopted = false;

  /**
   * Sends are waiting for the vault (engram#588), and why, as last said: the
   * key can't be read (engram#677), it decrypts none of the vault's secrets
   * (engram#694), or the vault isn't read yet. A new why is said too.
   */
  private vaultHeld: "key" | "mismatch" | "read" | null = null;

  /** Per-conversation reduced batch size after a failed send (halves down to
   *  1 so even a single pathological message eventually goes alone; restored
   *  to the full batch on the next success). */
  private batchOverride = new Map<string, number>();

  /**
   * With `keys`, `client` is the client for `keys.current` (built from it
   * when null), and no `keys.current` starts the Syncer signed out, or
   * waiting for config.json (`keys.unread`). Without `keys`, `client`
   * sends everything, under FIXED_KEY_FP.
   */
  constructor(
    db: DaemonDb,
    client: Engram | null,
    private readonly scrubber: SecretScrubber | null = null,
    private readonly keys: KeySource | null = null,
  ) {
    this.db = db;
    if (!keys) {
      if (!client) throw new Error("Syncer needs a client or a KeySource");
      this.active = { fp: FIXED_KEY_FP, client };
    } else if (keys.current) {
      const account = keys.current;
      this.active = {
        fp: accountFingerprint(account),
        client: client ?? keys.connect(account),
        account,
      };
      this.currentAccount = account;
    } else {
      this.active = null;
      this.unread = keys.unread === true;
    }
    this.captureFp = this.active?.fp ?? null;
    if (this.active) this.claim(this.active);
  }

  /** Hand capture to the Syncer (engram#594), which runs it while a key is
   *  configured. Set before start(). */
  setCaptureControl(control: CaptureControl): void {
    this.capture = control;
  }

  /** Start syncing, and capturing while a key is configured. */
  start(): void {
    this.stopped = false;
    if (this.active) {
      if (this.keys) recordSignedIn();
      this.startCapture();
    } else {
      recordSignedOut();
      // Waiting for config.json was said when it couldn't be read.
      if (!this.unread) this.logSignedOut();
    }
    // flush() and checkKey() handle their own errors; the catch only keeps
    // a failure in that handling from becoming an unhandled rejection.
    this.timer ??= setInterval(() => {
      this.flush().catch(() => {});
    }, FLUSH_INTERVAL_MS);
    if (this.keys) {
      this.keyTimer ??= setInterval(() => {
        this.checkKey().catch(() => {});
      }, KEY_POLL_MS);
    }
  }

  /**
   * Stop capturing and syncing. Queued messages stay in daemon.db. A final
   * flush() may follow; it sends only with the key still configured.
   */
  stop(): void {
    this.stopped = true;
    this.stopCapture(false);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.keyTimer) {
      clearInterval(this.keyTimer);
      this.keyTimer = null;
    }
  }

  private startCapture(): void {
    if (this.capturing || this.stopped || !this.capture) return;
    this.capturing = true;
    try {
      this.capture.start();
    } catch (err: unknown) {
      console.error(`[engram] starting capture failed: ${errorText(err)}`);
    }
  }

  private stopCapture(drain: boolean): void {
    if (!this.capturing || !this.capture) return;
    this.capturing = false;
    try {
      this.capture.stop(drain);
    } catch (err: unknown) {
      console.error(`[engram] stopping capture failed: ${errorText(err)}`);
    }
  }

  /**
   * Read the configured account and act on a change (engram#594,
   * engram#685): no key stops capture and sending at once, and a new key or
   * server is used from the next request on. Calls made while a read is in
   * progress share it.
   */
  checkKey(): Promise<void> {
    const keys = this.keys;
    if (!keys) return DONE;
    this.keyCheck ??= this.readKey(keys).finally(() => {
      this.keyCheck = null;
    });
    return this.keyCheck;
  }

  private async readKey(keys: KeySource): Promise<void> {
    let account: Account | undefined;
    try {
      account = (await keys.read()) ?? undefined;
    } catch (err: unknown) {
      this.logProblem("key", `[engram] reading the API key failed (will retry): ${errorText(err)}`);
      return;
    }
    if (account && !account.key) account = undefined;
    // config.json has been read: from now on no key is a signed-out daemon.
    const firstRead = this.unread;
    this.unread = false;
    if (sameAccount(account, this.currentAccount)) {
      this.problems.delete("key");
      if (firstRead && !this.stopped) this.logSignedOut();
      return;
    }
    if (this.stopped) {
      // Shutting down, and the account changed since it was last read:
      // nothing more is sent for an account that is no longer configured,
      // and capture doesn't start again.
      this.active = null;
      this.captureFp = null;
      this.currentAccount = undefined;
      return;
    }
    if (account === undefined) this.signOut();
    else this.signIn(keys, account);
  }

  /** An account is configured that isn't the one in use: a sign-in, or a
   *  change of key, server or account. */
  private signIn(keys: KeySource, account: Account): void {
    const previous = this.active ? this.currentAccount : undefined;
    // What was written for the account in use is read and queued for it
    // first, scrubbed against the vault read through it.
    this.stopCapture(true);
    let run: Run;
    try {
      run = { fp: accountFingerprint(account), client: keys.connect(account), account };
    } catch (err: unknown) {
      // Another account is configured: nothing more is captured or sent
      // for the one in use.
      if (this.active) this.deactivate();
      this.logProblem("key", `[engram] the new API key can't be used yet (will retry): ${errorText(err)}`);
      return;
    }
    this.active = run;
    this.captureFp = run.fp;
    this.currentAccount = account;
    this.resetForNewKey();
    this.problems.delete("key");
    this.claim(run);
    recordSignedIn();
    this.startCapture();
    // Never the server's address, which can carry credentials. What was
    // queued for the previous account is said once the server has been
    // asked about it (checkOwnership, logHeld).
    console.log(
      !previous
        ? "[engram] signed in — capture and sync resumed"
        : previous.key === account.key
          ? "[engram] the server in ~/.engram/config.json changed — capturing and sending to the new one from now on"
          : sameServer(previous.server, account.server)
            ? "[engram] new API key found — capturing and sending with it (messages queued under the previous key are sent only if it's the same account's)"
            : "[engram] new API key and server found — capturing and sending with them from now on",
    );
  }

  /** Stop capturing and sending under the key in use. Nothing queued is
   *  touched. */
  private deactivate(): void {
    // What was written under the key is read and queued under it first,
    // scrubbed against the vault read through it — so the vault is let go
    // of only after.
    this.stopCapture(true);
    this.active = null;
    this.captureFp = null;
    this.currentAccount = undefined;
    this.resetForNewKey();
    try {
      this.keys?.disconnect?.();
    } catch (err: unknown) {
      console.error(`[engram] letting go of the previous API key failed: ${errorText(err)}`);
    }
    recordSignedOut();
  }

  /** No key is configured any more (`engram auth logout`). */
  private signOut(): void {
    this.deactivate();
    this.problems.delete("key");
    this.logSignedOut();
  }

  private logSignedOut(): void {
    let queued = 0;
    try {
      queued = this.db.getHeldCount(null);
    } catch {
      // The count only informs the line below.
    }
    console.log(
      `[engram] signed out — capture paused and nothing is sent; ${queued} queued message(s) ` +
        `stay on this machine, to be sent only with their account's key. ` +
        `Capture resumes when '${engramCommand("auth login")}' saves a key.`,
    );
  }

  /** Forget what was learned under the previous key: its pauses, retry
   *  timers and batch sizes say nothing about the next one. */
  private resetForNewKey(): void {
    this.authHeldUntil = 0;
    this.authHoldStep = 0;
    // The new key may belong to an account with room, and a held billing
    // backoff would only delay finding out.
    this.billingBackoffUntil = 0;
    this.billingBackoffStep = 0;
    // A rate limit is the account's, and the next key may be another's.
    this.throttledUntil = 0;
    this.throttleStep = 0;
    this.throttlePaused = false;
    this.createRetry.clear();
    this.sendRetry.clear();
    this.deleteRetry.clear();
    // Another key's permissions are its own.
    this.deletesRefused = false;
    this.batchOverride.clear();
    this.vaultHeld = null;
    this.ownership = freshOwnership();
    this.gateLogged = false;
    // What was queued while no key was in use goes to the next key.
    this.claimedFor = null;
  }

  /**
   * Hand what belongs to no key to the key in use: rows queued before
   * daemon.db recorded keys, or while no key was in use. Once per key; a
   * failure is retried on the next flush.
   */
  private claim(run: Run): boolean {
    if (this.claimedFor === run.fp) return true;
    try {
      this.db.claimLegacy(run.fp);
      this.claimedFor = run.fp;
      this.problems.delete("claim");
      return true;
    } catch (err: unknown) {
      this.logProblem(
        "claim",
        `[engram] couldn't assign queued messages to this API key (will retry): ${errorText(err)}`,
      );
      return false;
    }
  }

  private logProblem(kind: string, msg: string): void {
    if (this.problems.get(kind) === msg) return;
    this.problems.set(kind, msg);
    console.error(msg);
  }

  /**
   * Called by the parser when new messages are ready for a session.
   * Queues them in daemon.db before it returns; creating the conversation
   * is deferred to flush time, so the parser never waits on the network.
   *
   * A failure to queue throws a QueueWriteError, synchronously (engram#584):
   * the watcher stops at the line and reads it again later, instead of
   * saving its resume offset past a message that was never queued. The
   * returned promise covers only the server-side delete an in-chat opt-out
   * starts, which retries on its own.
   */
  onMessages(
    sessionId: string,
    meta: SessionMeta,
    messages: ParsedMessage[],
  ): Promise<void> {
    // Capture exclusions (engram#462) — checked here, the single funnel, so
    // an excluded session never touches the queue or the network.

    // A session the user already opted out of stays out.
    if (queueing(() => this.db.isSessionExcluded(sessionId))) return DONE;

    // Repo/directory exclusions: `engram exclude add <path>` or a
    // .engramignore marker at the repo root. Checked per batch (cheap,
    // cached) so a freshly added exclusion applies without a restart.
    if (isPathExcluded(meta.cwd)) return DONE;

    // In-chat opt-out: a USER message saying "don't save this to engram"
    // (or `engram:ignore`) excludes the whole session — including what was
    // already captured.
    if (messages.some((m) => m.role === "user" && detectOptOut(m.content))) {
      return this.excludeSession(sessionId, "in-chat opt-out");
    }

    // Queued under the key signed in now (engram#594), so only that key's
    // account receives them; onto the session's conversation in that
    // account, if it has one there.
    const keyFp = this.captureFp;
    const conversationId =
      keyFp === null ? null : queueing(() => this.db.getConversationId(sessionId, keyFp));

    // Value-exact scrubbing of known vault secrets, applied to every role
    // (tool output is where `engram vault get` lands), before the messages
    // are queued. A message queued before the vault has been read isn't
    // covered (its text is in the source transcript on this same disk
    // anyway), so each batch is scrubbed again just before it's sent, and
    // nothing is sent until the vault has been read (engram#588).
    if (this.scrubber?.active) {
      let hits = 0;
      for (const m of messages) {
        const r = this.scrubber.scrub(m.content);
        if (r.replaced.length > 0) {
          m.content = r.text;
          hits += r.replaced.reduce((n, x) => n + x.count, 0);
        }
      }
      if (hits > 0) {
        // Names would be fine to log; counts are enough and give nothing away.
        console.error(`[engram] scrubbed ${hits} vault value occurrence(s) from captured transcript`);
      }
    }

    // File payloads (a screenshot in a tool result, a PDF) become a short
    // note before they are queued (engram#750): Engram never stores them
    // (engram#386), and queued as base64 they filled daemon.db and every
    // upload. Only that here: the clip waits for the send, after the scrub
    // there, so daemon.db keeps the whole text for a vault value saved
    // later to be found in.
    for (const m of messages) m.content = stripBinaryPayloads(m.content);

    if (conversationId) {
      queueing(() => this.db.enqueue(conversationId, messages, keyFp));
    } else {
      // No conversation yet. Creating it is deferred to the flush loop so
      // the parser never waits on the network; until then the messages wait
      // under pending:<sessionId>, recorded together with the session in
      // daemon.db (engram#370) so a restart or a failed create can't strand
      // them.
      queueing(() => this.db.enqueuePendingSession(sessionId, meta, messages, keyFp));
    }
    return DONE;
  }

  /**
   * The user said not to save this session. Semantics are "this session was
   * never captured": stop future capture, wipe the local queue, and delete
   * whatever already reached the server. The remote delete is persisted in
   * remote_deletes and retried from the flush loop until it succeeds —
   * offline opt-out must still stick. A copy synced under another key is
   * deleted with that key's account's key (engram#594), once it signs in
   * again.
   *
   * The local part happens before this returns, in one transaction; if it
   * fails, the QueueWriteError stops the watcher at the opt-out line, so
   * nothing after it is read until the opt-out has taken (engram#584).
   */
  private excludeSession(sessionId: string, reason: string): Promise<void> {
    const { conversations, dropped } = queueing(() =>
      this.db.excludeSession(sessionId, reason),
    );
    this.createRetry.delete(sessionId);

    const run = this.active;
    const here = run ? conversations.filter((c) => c.keyFp === run.fp).length : 0;
    const elsewhere = conversations.length - here;
    console.log(
      `[engram] session ${sessionId} excluded (${reason}) — ` +
        `${plural(dropped, "queued message")} dropped` +
        (here > 0
          ? this.deletesRefused
            ? "; the synced copy waits to be deleted: this API key can't delete conversations"
            : ", deleting synced copy"
          : "") +
        (elsewhere > 0
          ? `; ${plural(elsewhere, "copy", "copies")} synced under another account ` +
            `(another API key, or another server) will be deleted when it signs in again`
          : ""),
    );

    return run && here > 0 ? this.retryRemoteDeletes(run) : DONE;
  }

  /** Delete server-side conversations for opted-out sessions, each with the
   *  key of the account it is in; a delete is kept until the server
   *  confirms. */
  private async retryRemoteDeletes(run: Run): Promise<void> {
    // A rejected key can't delete either, and a rate limit or a maintenance
    // pause holds deletes like any other request; they keep until then.
    if (this.authHeld() || this.throttled()) return;
    const rows = this.db.getPendingRemoteDeletes(run.fp);
    forgetDone(this.deleteRetry, rows.map((r) => r.conversation_id));
    // This key may not delete (engram#597): they wait for one that can.
    // The status counts them, an opt-out made since included.
    if (this.deletesRefused) {
      recordDeletesRefused(rows.length);
      return;
    }
    const now = Date.now();
    for (const row of rows) {
      // The key changed: the rest wait for their account to sign in again.
      if (this.active !== run) return;
      // Refused meanwhile, in another pass over these deletes (engram#597).
      if (this.deletesRefused) return;
      // A delete that failed waits its turn (engram#596).
      if ((this.deleteRetry.get(row.conversation_id)?.until ?? 0) > now) continue;
      try {
        await run.client.deleteConversation(row.conversation_id);
        this.requestWentThrough(run, false);
        this.deleteRetry.delete(row.conversation_id);
        this.db.clearPendingRemoteDelete(row.conversation_id);
        console.log(
          `[engram] deleted synced conversation ${row.conversation_id} for opted-out session`,
        );
      } catch (err: unknown) {
        const msg = errorText(err);
        // Engram saying "not found" means it's already gone (or was never
        // fully created) — the promise is kept either way. Only Engram's
        // own answer counts (engram#587): this used to accept any text
        // matching /not.?found/ or "404", and a DNS failure (ENOTFOUND)
        // matches that. The delete was dropped while the copy stayed.
        if (isNotFound(err)) {
          this.requestWentThrough(run, false);
          this.deleteRetry.delete(row.conversation_id);
          this.db.clearPendingRemoteDelete(row.conversation_id);
          continue;
        }
        // Refused under a key no longer in use: that says nothing about the
        // key in use now, and the delete waits for its account.
        if (this.active !== run) return;
        // The key works but may not delete (engram#597). It can still save,
        // so nothing else pauses; every delete waits for a key that can.
        if (isScopeRefusal(err)) {
          this.requestWentThrough(run, false);
          // Counted from daemon.db: an opt-out made since is waiting too.
          const waiting = this.db.getPendingRemoteDeletes(run.fp).length;
          // Said once, though two passes over the deletes may both be refused.
          if (!this.deletesRefused) {
            this.deletesRefused = true;
            console.error(
              `[engram] opt-out delete refused for ${row.conversation_id}: this API key can't ` +
                `delete conversations. ${plural(waiting, "opt-out delete")} kept on this ` +
                `machine, waiting for a key that can; not retried with this one. ` +
                `Run '${engramCommand("status")}' for details.`,
            );
          }
          recordDeletesRefused(waiting);
          return;
        }
        const errType = classifyError(err);
        // Only a key refused outright pauses everything.
        if (errType === "auth") {
          console.error(
            `[engram] opt-out delete failed for ${row.conversation_id} (will retry): ${msg}`,
          );
          this.enterAuthHold(msg);
          return;
        }
        if (errType === "rate_limit" || errType === "paused") {
          console.error(
            `[engram] opt-out delete failed for ${row.conversation_id} (will retry): ${msg}`,
          );
          this.enterThrottle(msg, errType);
          return;
        }
        const wait = waitAgain(this.deleteRetry, row.conversation_id);
        console.error(
          `[engram] opt-out delete failed for ${row.conversation_id} ` +
            `(will retry in ${formatWait(wait)}): ${msg}`,
        );
      }
    }
  }

  /**
   * Flush all pending messages to the API, with the key configured now. A
   * call while a flush is in progress returns at once.
   */
  flush(): Promise<void> {
    if (this.running) return DONE;
    const flushing = this.runFlush().finally(() => {
      this.running = null;
    });
    this.running = flushing;
    return flushing;
  }

  /** Settles once no flush is in progress: shutdown waits for it before
   *  closing daemon.db, so a send that went through is recorded as sent. */
  idle(): Promise<void> {
    return this.running ?? DONE;
  }

  private async runFlush(): Promise<void> {
    let run: Run | null = null;
    try {
      // A logout or a new key takes effect before anything is sent
      // (engram#594).
      await this.checkKey();
      run = this.active;
      if (!run) return; // signed out: nothing is sent
      await this.flushWith(run);
    } catch (err: unknown) {
      const msg = errorText(err);
      console.error(`[engram] flush error: ${msg}`);
      // After a logout or a new key, the error belongs to a key no longer
      // in use; the status speaks for the one configured now.
      if (this.active !== null && (run === null || this.active === run)) {
        recordFailure(msg, classifyError(err), this.pendingCount());
      }
    }
  }

  private async flushWith(run: Run): Promise<void> {
    // What was queued before daemon.db recorded keys is this key's (see
    // claim). Nothing is sent until that is recorded: a session mapped
    // before then would otherwise get a second conversation.
    if (!this.claim(run)) return;

    // Nothing can send while the key is rejected, a billing backoff holds,
    // or the account waits out a rate limit or a maintenance pause.
    if (this.halted(run)) return;

    // What an earlier key of this account queued is sent with this one.
    await this.checkOwnership(run);
    if (this.halted(run)) return; // the key was rejected, or changed, there

    // Step 0: Honor opt-outs whose server-side delete hasn't landed yet
    // (e.g. the machine was offline when the user said "don't save this").
    await this.retryRemoteDeletes(run);
    if (this.halted(run)) return; // the key was rejected, or changed, there

    // Step 1: Create any pending conversations. A create carries no
    // message content, so it doesn't wait for the vault.
    const createsOk = await this.createPendingConversations(run);
    if (this.halted(run)) return; // the key was rejected, or a limit hit, there

    // Step 2: Flush messages for all conversations (with concurrency).
    // Not those Engram said it doesn't have (engram#593), but for the ones
    // due to be checked again.
    const rechecks = this.dueRechecks(run);
    const convIds = [
      ...this.db.getPendingConversationIds(run.fp).filter((id) => !id.startsWith("pending:")),
      ...rechecks,
    ];

    // A conversation whose last send failed waits its turn (engram#596).
    // It used to be tried again at every flush, every 2 s, for as long as
    // the failure lasted, and by every daemon at once.
    forgetDone(this.sendRetry, convIds);
    const now = Date.now();
    const due = convIds.filter((id) => (this.sendRetry.get(id)?.until ?? 0) <= now);

    // Nothing is sent before the vault has been read: a message queued
    // before then wasn't scrubbed against it (engram#588).
    if (due.length > 0 && !(await this.vaultReady(run))) return;

    // Process conversations in parallel, up to CONCURRENCY at a time
    const chunks = [];
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      chunks.push(due.slice(i, i + CONCURRENCY));
    }

    // A conversation waiting its turn hasn't synced. One that Engram
    // doesn't have is done: nothing more can be sent to it.
    let allSent = due.length === convIds.length;
    for (const chunk of chunks) {
      const results = await Promise.allSettled(
        chunk.map((id) => this.flushConversation(run, id, rechecks.has(id))),
      );
      if (
        results.some(
          (r) => r.status === "rejected" || (r.value !== "sent" && r.value !== "gone"),
        )
      ) {
        allSent = false;
      }
    }

    // The key changed during the flush: what this flush did says nothing
    // about the key in use now.
    if (this.active !== run) return;

    // Report sync health. Only a flush in which every create and every
    // send went through is a successful sync: a session still waiting on
    // its create, or a conversation whose send failed, is not synced.
    // A failed send used to count as a success (engram#580): status read
    // "healthy" while nothing synced, and the billing backoff a full
    // memory had just entered was cleared again, so the account was
    // retried every 2 s instead of backing off.
    //
    // After a pause for a rejected key, a flush with nothing to send
    // proves nothing about the key: status keeps saying it was rejected
    // until a request goes through (requestWentThrough) or a new key is
    // saved.
    const pending = this.db.getPendingCount(run.fp);
    if (createsOk && allSent && this.authHoldStep === 0) {
      this.resetBillingBackoff();
      recordSuccess(pending);
    } else {
      // A wait can end, and another go on, with no failure in between.
      recordNextRetry(this.nextRetryAt());
    }
  }

  /**
   * Ask the server, once per account, which of the other keys something
   * here is queued or mapped under are keys of this account (engram#594): a
   * rotated or re-issued key. Theirs is handed to this account, so it is
   * sent with this key, and a session continues in the conversation it
   * already has. The rest keep waiting for their own account. Only what was
   * queued for this account's server is asked about (ownershipCandidates,
   * engram#685), and only key fingerprints go to the server, never a key.
   * When the server can't answer, it is asked again on OWNERSHIP_RETRY_MS.
   */
  private async checkOwnership(run: Run): Promise<void> {
    const own = this.ownership;
    if (own.answered || Date.now() < own.retryAt) return;
    const others = this.db.otherKeyFps(run.fp);
    // Only a server other than the default is asked about what doesn't
    // record its server; the default server's own key hashes cover it.
    const unknownServer = SERVER_ACCOUNT.test(run.fp)
      ? new Set(this.db.unknownServerFps())
      : new Set<string>();
    const candidates = ownershipCandidates(run.fp, others, unknownServer);
    if (candidates.length === 0) {
      own.answered = true;
      // What another server's account queued waits for it.
      if (others.length > 0) this.logHeld(run);
      return;
    }
    const keys = this.keys;
    if (!keys?.ownedKeys || !run.account) {
      own.answered = true;
      this.logHeld(run);
      return;
    }
    if (own.firstAskedAt === 0) own.firstAskedAt = Date.now();

    let owned: string[];
    try {
      owned = await keys.ownedKeys(run.account, [...new Set(candidates.map((c) => c.keyHash))]);
    } catch (err: unknown) {
      // The key changed while the server was asked: the answer is about a
      // key no longer in use.
      if (this.active !== run || this.ownership !== own) return;
      const msg = errorText(err);
      const status = (err as { status?: unknown } | null)?.status;
      if (status === 401) {
        this.enterAuthHold(msg);
        return;
      }
      if (status === 400 || status === 403 || status === 404) {
        // Asking again would get the same answer. What another key queued
        // keeps waiting for that key's account.
        own.answered = true;
        console.error(`[engram] couldn't check which earlier API keys are this account's: ${msg}`);
        this.logHeld(run);
        return;
      }
      this.retryOwnership(own, msg);
      return;
    }
    if (this.active !== run || this.ownership !== own) return;

    const mine = new Set(owned);
    const adopted = candidates.filter((c) => mine.has(c.keyHash));
    // The key in use, queued before servers were recorded (see
    // ownershipCandidates), apart from the earlier keys.
    const runKeyHash = run.fp.split("@")[0];
    const earlier = adopted.filter((c) => c.keyHash !== runKeyHash);
    const sameKey = adopted.filter((c) => c.keyHash === runKeyHash);
    try {
      // Each its own transaction: one that moved stays moved, and the
      // next check no longer finds it.
      if (earlier.length > 0) {
        const moved = this.db.adoptKeys(earlier, run.fp);
        console.log(
          `[engram] ${new Set(earlier.map((c) => c.keyHash)).size} earlier API key(s) are this ` +
            `account's — sending their ${moved.messages} queued message(s) with this key`,
        );
      }
      if (sameKey.length > 0) {
        const moved = this.db.adoptKeys(sameKey, run.fp);
        if (moved.messages > 0) {
          console.log(
            `[engram] the server confirmed this API key — sending it the ${moved.messages} ` +
              `message(s) an earlier version of Engram queued with the key`,
          );
        }
      }
    } catch (err: unknown) {
      this.retryOwnership(own, errorText(err));
      return;
    }
    own.answered = true;
    this.logHeld(run);
  }

  private retryOwnership(own: Ownership, msg: string): void {
    const delay = OWNERSHIP_RETRY_MS[Math.min(own.step, OWNERSHIP_RETRY_MS.length - 1)];
    own.step++;
    own.retryAt = Date.now() + delay;
    console.error(
      `[engram] couldn't check which earlier API keys are this account's ` +
        `(will retry in ${Math.round(delay / 1000)}s): ${msg}`,
    );
  }

  /** While a session with a conversation under an earlier key waits for the
   *  server to say whether that key is this account's (OWNERSHIP_GATE_MS). */
  private awaitingOwnership(now: number): boolean {
    const own = this.ownership;
    return !own.answered && (own.firstAskedAt === 0 || now - own.firstAskedAt < OWNERSHIP_GATE_MS);
  }

  /** Say how many queued messages wait for another account: another API
   *  key's, or the same key's on another server (engram#685). */
  private logHeld(run: Run): void {
    let held = 0;
    try {
      held = this.db.getHeldCount(run.fp);
    } catch {
      return; // the count only informs the line below
    }
    if (held > 0) {
      console.log(
        `[engram] ${held} queued message(s) wait for another account (another API key, or ` +
          `another server) — they stay on this machine and are sent only to that account`,
      );
    }
  }

  /**
   * Create conversations for sessions that were deferred during parsing.
   * Every session stays in daemon.db until its conversation exists and its
   * messages have moved onto it — a failure here only means "try again".
   * Returns false while any session is still waiting on a failed create.
   */
  private async createPendingConversations(run: Run): Promise<boolean> {
    let ok = true;
    if (!this.orphansAdopted) {
      try {
        const adopted = this.db.adoptOrphanedPendingRows();
        this.orphansAdopted = true;
        if (adopted.length > 0) {
          console.log(
            `[engram] recovered ${adopted.length} session(s) queued by an earlier daemon — creating their conversations`,
          );
        }
      } catch (err: unknown) {
        // Not fatal: the orphans keep, and this runs again next flush.
        const msg = errorText(err);
        console.error(`[engram] orphaned-queue check failed (will retry): ${msg}`);
        ok = false;
      }
    }

    const now = Date.now();
    const pending = this.db.getPendingSessions(run.fp);
    forgetDone(this.createRetry, pending.map((s) => s.sessionId));
    let sessions = pending.filter(
      (s) => (this.createRetry.get(s.sessionId)?.until ?? 0) <= now,
    );
    // A session sitting out a retry delay hasn't synced.
    if (sessions.length < pending.length) ok = false;

    // A session with a conversation under an earlier key waits to learn
    // whether that key is this account's: if it is, the session continues
    // in that conversation instead of starting a second one
    // (checkOwnership).
    if (this.awaitingOwnership(now)) {
      const waiting = new Set(
        sessions
          .filter((s) => this.db.mappedUnderOtherKey(s.sessionId, run.fp))
          .map((s) => s.sessionId),
      );
      if (waiting.size > 0) {
        ok = false;
        sessions = sessions.filter((s) => !waiting.has(s.sessionId));
        if (!this.gateLogged) {
          this.gateLogged = true;
          console.log(
            `[engram] ${waiting.size} session(s) synced under an earlier API key wait to learn ` +
              `whether it is this account's before they continue`,
          );
        }
      }
    }

    // Create conversations in parallel batches
    for (let i = 0; i < sessions.length; i += CONCURRENCY) {
      // The key changed: the rest wait for the next flush.
      if (this.active !== run) return false;
      const batch = sessions.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((s) => this.createPendingConversation(run, s.sessionId, s.meta)),
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const sessionId = batch[j].sessionId;
        if (r.status === "fulfilled") {
          this.createRetry.delete(sessionId);
          continue;
        }
        ok = false;
        // Refused under a key no longer in use: that says nothing about the
        // key in use now.
        if (this.active !== run) continue;
        const msg = errorText(r.reason);
        const errType = classifyError(r.reason);
        if (errType === "auth") {
          this.enterAuthHold(msg);
          return false;
        }
        if (errType === "billing" || errType === "storage_full") {
          this.enterBillingBackoff(msg);
          return false;
        }
        if (errType === "rate_limit" || errType === "paused") {
          this.enterThrottle(msg, errType);
          return false;
        }
        const wait = this.deferCreate(sessionId);
        console.error(`[engram] create error (will retry in ${formatWait(wait)}): ${msg}`);
        recordFailure(msg, errType, this.pendingCount(), { retryAt: this.nextRetryAt() });
      }
    }
    return ok;
  }

  private async createPendingConversation(
    run: Run,
    sessionId: string,
    meta: SessionMeta,
  ): Promise<void> {
    // Opted out while it waited: nothing of this session may sync.
    if (this.db.isSessionExcluded(sessionId)) {
      this.db.dropPendingSession(sessionId);
      return;
    }

    // Already mapped in this key's account (rows an older daemon left under
    // the temporary id after the conversation was created, or rows queued
    // before the server said an earlier key is this account's) — move them;
    // never create a second conversation for the session.
    const existing = this.db.getConversationId(sessionId, run.fp);
    if (existing) {
      this.db.completePendingSession(sessionId, existing, run.fp);
      return;
    }

    // The key changed: the session waits for the next flush.
    if (this.active !== run) return;

    const conversationId = await this.createConversation(run, sessionId, meta);
    this.requestWentThrough(run, false);

    // Opt-out race (engram#462): the user may have said "don't save
    // this" while the create was in flight — excludeSession saw no
    // conversation id yet, so it couldn't schedule the remote delete.
    // Schedule it now, for the key that created it; the flush loop's
    // retryRemoteDeletes handles it.
    if (this.db.isSessionExcluded(sessionId)) {
      this.db.excludeCreatedConversation(sessionId, conversationId, run.fp);
      return;
    }

    // Map the session and move its messages onto the conversation (one
    // transaction — see DaemonDb.completePendingSession). Done even if the
    // key changed meanwhile: the conversation exists in this key's account,
    // and only what was queued under this key moves onto it.
    this.db.completePendingSession(sessionId, conversationId, run.fp, {
      projectDir: meta.projectDir,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
    });
  }

  /** Pace retries for a session whose create failed: 30s → 2m → 10m …
   *  Returns the wait. */
  private deferCreate(sessionId: string): number {
    const prev = this.createRetry.get(sessionId);
    const step = prev ? prev.step + 1 : 0;
    const delay = CREATE_RETRY_MS[Math.min(step, CREATE_RETRY_MS.length - 1)];
    this.createRetry.set(sessionId, { until: Date.now() + delay, step });
    return delay;
  }

  /**
   * Send what is queued for one conversation, batch by batch. `recheck`:
   * Engram said it doesn't have the conversation (engram#593), and this
   * checks again with one message before anything more is sent.
   */
  private async flushConversation(
    run: Run,
    conversationId: string,
    recheck = false,
  ): Promise<SendOutcome> {
    let checking = recheck;
    while (true) {
      // Each batch waits for the vault to be read, not only the flush
      // (engram#701): `engram vault set` may save a secret while a long
      // flush is under way, and the batch after it may hold a row captured
      // since. ready() reads the vault again first. It answers at once
      // when nothing changed.
      if (!(await this.vaultReady(run))) return "retry";
      // The key changed or was removed (engram#594): no new batch goes out
      // with this one. What is left stays queued for its account.
      if (this.active !== run) return "retry";
      // An auth failure or a billing limit applies to the whole account.
      // Once any conversation in this flush has hit one, no new batch is
      // started: it could only fail the same way.
      if (this.authHeld()) return "auth";
      if (Date.now() < this.billingBackoffUntil) return "backoff";
      if (this.throttled()) return "wait";

      const limit = checking ? 1 : (this.batchOverride.get(conversationId) ?? BATCH_SIZE);
      let rows = this.db.dequeue(conversationId, limit, run.fp);
      if (rows.length === 0) return "sent";

      // Scrubbed again against the set held now (engram#588): a row queued
      // before the vault was read wasn't scrubbed against it.
      rows = this.rescrub(rows);

      // Bounded the way Engram bounds them on arrival (engram#750): file
      // payloads become a note, then the text is clipped with a visible
      // marker. Engram stores the same text, or in one case less (see
      // message-bounds.ts), and no single message can outgrow its request
      // limit. Clipped only after the scrub above, so a vault value at the
      // cut is replaced whole, never half sent; daemon.db keeps the whole
      // text.
      rows = rows.map((r) => {
        const content = boundContent(r.content);
        return content === r.content ? r : { ...r, content };
      });

      // Byte budget: transcript messages vary wildly in size — trim the batch
      // so its total content stays inside the budget. Always send at least
      // one row (bounded above, it is far inside the server's limit).
      let bytes = 0;
      let take = 0;
      for (const r of rows) {
        bytes += r.content.length;
        take++;
        if (bytes > BATCH_BYTE_BUDGET && take > 1) {
          take--;
          break;
        }
      }
      rows = rows.slice(0, take);

      const messages = rows.map(rowToMessage);

      try {
        await run.client.store({ conversationId, messages });
        this.requestWentThrough(run, true);
        this.db.markSent(rows.map((r) => r.id));
        if (checking) {
          // Engram has the conversation after all: the rest follows.
          this.db.clearGone(conversationId);
          checking = false;
          console.log(
            `[engram] conversation ${conversationId} is on Engram again — sending its queued messages`,
          );
        }
        if (this.active === run) {
          this.batchOverride.delete(conversationId);
          this.sendRetry.delete(conversationId);
        }
      } catch (err: unknown) {
        // Failed under a key no longer in use: that says nothing about the
        // key in use now. The rows stay queued for their account.
        if (this.active !== run) return "retry";

        // Engram doesn't have the conversation (engram#593): deleted there,
        // or not this account's. Sending again can't change that, so its
        // messages stay here instead of being retried forever, and the
        // conversation isn't created again. Engram answered, after checking
        // that writes aren't paused: the key works and the account can
        // write, so this is no failure of the account's.
        if (isConversationGone(err)) {
          this.requestWentThrough(run, true);
          this.setAside(conversationId);
          return "gone";
        }

        const msg = errorText(err);
        const errType = classifyError(err);

        // The key was rejected: pause, and recover without a restart. This
        // used to stop the flush loop for good (engram#587).
        if (errType === "auth") {
          this.enterAuthHold(msg);
          return "auth";
        }

        // Billing / limit errors — exponential backoff
        if (errType === "billing" || errType === "storage_full") {
          this.enterBillingBackoff(msg);
          return "backoff";
        }

        // A rate limit or a maintenance pause: nothing is sent from this
        // account for a while (engram#596). It refuses the request for when
        // it came, not for its size, so the batch keeps its size: halving
        // it would only multiply the requests.
        if (errType === "rate_limit" || errType === "paused") {
          this.enterThrottle(msg, errType);
          return "wait";
        }

        // Refused as too large (engram#750). Every message is bounded far
        // inside Engram's limit, so this is a batch that still adds up to
        // more than something on the way accepts (a proxy with a smaller
        // limit): send half of it at once. Waiting would change nothing,
        // and the same batch would only be refused again. A single message
        // that is still refused stays queued, in its place, and is tried
        // again after a wait like any other failure: sending the ones after
        // it first would store the conversation out of order.
        if (errType === "too_large" && rows.length > 1) {
          const next = Math.max(1, Math.floor(rows.length / 2));
          this.batchOverride.set(conversationId, next);
          console.error(`[engram] send refused as too large — sending it again in batches of ${next}`);
          continue;
        }

        // Network/timeout/server — leave in queue, and try this conversation
        // again after a wait that doubles with each failure in a row
        // (engram#596). Halve its batch too, so an oversized batch
        // self-resolves instead of retrying the identical payload forever.
        // One conversation's failure doesn't hold the others: what fails for
        // one batch (a payload a proxy refuses) may not fail for the rest.
        const wait = waitAgain(this.sendRetry, conversationId);
        if (rows.length > 1) {
          const next = Math.max(1, Math.floor(rows.length / 2));
          this.batchOverride.set(conversationId, next);
          console.error(
            `[engram] send failed (will retry in ${formatWait(wait)} with batch ${next}): ${msg}`,
          );
        } else {
          console.error(`[engram] send failed (will retry in ${formatWait(wait)}): ${msg}`);
        }
        recordFailure(msg, errType, this.pendingCount(), { retryAt: this.nextRetryAt() });
        return "retry";
      }
    }
  }

  /**
   * Stop sending a conversation Engram said it doesn't have (engram#593).
   * Its messages stay in daemon.db; the flush loop leaves it out until it
   * is due to be checked again (GONE_RECHECK_MS).
   */
  private setAside(conversationId: string): void {
    this.sendRetry.delete(conversationId);
    this.batchOverride.delete(conversationId);
    const now = Date.now();
    const checks = this.db.markGone(conversationId, now);
    const next = goneRecheckAt(now, checks);
    const kept = plural(this.db.getUnsentCount(conversationId), "queued message");
    console.log(
      `[engram] conversation ${conversationId} ${checks === 1 ? "isn't" : "still isn't"} on Engram ` +
        `(deleted there, or not this account's) — keeping its ${kept} on this machine, not sent; ` +
        (next === null ? "not checking again" : `checking again in ${waitInWords(next - now)}`),
    );
  }

  /** The conversations Engram said it doesn't have that are due to be
   *  checked again, with messages queued under `run`'s key (engram#593). */
  private dueRechecks(run: Run): Set<string> {
    const now = Date.now();
    const due = new Set<string>();
    for (const g of this.db.getGoneConversations(run.fp)) {
      const at = goneRecheckAt(g.checkedAt, g.checks);
      if (at !== null && at <= now) due.add(g.conversationId);
    }
    return due;
  }

  /**
   * Whether queued messages may be sent: the vault has been read through the
   * current key, so the scrub before each send covers it (engram#588). Until
   * then nothing is sent — captures keep queueing in daemon.db — and the
   * status says why.
   */
  private async vaultReady(run: Run): Promise<boolean> {
    if (!this.scrubber) return true;
    const ready = await this.scrubber.ready();
    // The key changed while the vault was read: the next flush starts over.
    if (this.active !== run) return false;
    if (ready) {
      if (this.vaultHeld) {
        this.vaultHeld = null;
        console.log("[engram] vault read — sending the messages held for it");
      }
      return true;
    }
    this.holdForVault(this.scrubber.failure);
    return false;
  }

  private holdForVault(err: unknown): void {
    // The vault key can't be read (engram#677): there is nothing to scrub
    // the vault's secrets with, for as long as it lasts. Something for the
    // user to fix, unlike the waits below: an error, in status.json and on
    // the desktop.
    if (err instanceof VaultKeyUnreadable) {
      if (this.vaultHeld !== "key") {
        this.vaultHeld = "key";
        console.error(
          `[engram] holding queued messages until the vault key can be read, so a vault ` +
            `secret in them can't be sent unredacted: ${err.message}`,
        );
      }
      recordFailure(
        `holding messages until the vault key can be read: ${err.message}`,
        "vault_key",
        this.pendingCount(),
      );
      return;
    }

    // The key reads, but the vault holds secrets it doesn't decrypt
    // (engram#694): they can't be scrubbed, and they would go out as they
    // are. As above, the user's to fix, and nothing passes meanwhile.
    if (err instanceof VaultKeyMismatch) {
      if (this.vaultHeld !== "mismatch") {
        this.vaultHeld = "mismatch";
        console.error(
          `[engram] holding queued messages until each of the vault's secrets decrypts, or is ` +
            `deleted, so none of them is sent unredacted: ${err.message}`,
        );
      }
      recordFailure(
        `holding messages until the vault's secrets can be scrubbed: ${err.message}`,
        "vault_mismatch",
        this.pendingCount(),
      );
      return;
    }

    const reason =
      err === undefined
        ? "the vault hasn't been read yet"
        : err instanceof Error
          ? err.message
          : String(err);
    const errType = err === undefined ? "network" : classifyError(err);

    // The key was rejected: the pause a rejected send enters, which picks up
    // a new key without a restart (engram#587). The vault is read through
    // the new key, and sends wait for that read.
    if (errType === "auth") {
      this.enterAuthHold(reason);
      return;
    }

    if (this.vaultHeld !== "read") {
      this.vaultHeld = "read";
      console.error(
        `[engram] holding queued messages until the vault is read, so a secret in them ` +
          `can't be sent unredacted: ${reason}`,
      );
    }
    // A plan or storage refusal of the read doesn't hold sends (the
    // scrubber treats it as final), so what holds is the server or the
    // network.
    const kind = errType === "billing" || errType === "storage_full" ? "server" : errType;
    recordFailure(`holding messages until the vault is read: ${reason}`, kind, this.pendingCount());
  }

  /**
   * Scrub queued rows against the set held now, and write the scrubbed text
   * back so the queue stops holding the value too. A failed write-back
   * doesn't stop the send: what's sent is scrubbed either way.
   */
  private rescrub(rows: PendingRow[]): PendingRow[] {
    const scrubber = this.scrubber;
    if (!scrubber?.active) return rows;

    let hits = 0;
    const changed: Array<{ id: number; content: string }> = [];
    const out = rows.map((row) => {
      const r = scrubber.scrub(row.content);
      if (r.replaced.length === 0) return row;
      hits += r.replaced.reduce((n, x) => n + x.count, 0);
      changed.push({ id: row.id, content: r.text });
      return { ...row, content: r.text };
    });
    if (changed.length === 0) return rows;

    try {
      this.db.updateContents(changed);
    } catch (err: unknown) {
      const msg = errorText(err);
      console.error(`[engram] rewriting scrubbed queued messages failed (sending them scrubbed): ${msg}`);
    }
    console.error(`[engram] scrubbed ${hits} vault value occurrence(s) from queued messages before sending`);
    return out;
  }

  /**
   * Enter billing backoff — escalates each time it is entered:
   * 5min → 15min → 1hr for a plan limit, 1min → 2min → 5min for a full
   * memory (see STORAGE_FULL_BACKOFF_MS).
   *
   * A full memory is separated out here. It arrives as a 402 like any other
   * billing error, but retrying can never clear it on its own: it needs an
   * upgrade or deleted conversations. It gets its own status state (so the
   * CLI can say "memory is full" rather than "plan limit reached") and its
   * used/limit numbers are carried through, so the banner can name them
   * even when the machine is offline.
   */
  private enterBillingBackoff(msg: string): void {
    const storageFull = parseStorageFullError(msg);

    // Sends running in parallel hit the limit together. Only the first in a
    // flush escalates (engram#580): five at once would otherwise go
    // straight to the cap. No flush starts inside the window, so the next
    // flush that hits the limit escalates again.
    if (Date.now() >= this.billingBackoffUntil) {
      const schedule = storageFull ? STORAGE_FULL_BACKOFF_MS : BILLING_BACKOFF_MS;
      const delay = schedule[Math.min(this.billingBackoffStep, schedule.length - 1)];
      this.billingBackoffUntil = Date.now() + delay;
      this.billingBackoffStep++;

      const mins = Math.round(delay / 60_000);
      console.error(
        storageFull
          ? `[engram] memory full (${storageFull.used ?? "?"}/${storageFull.limit ?? "?"}), ` +
              `pausing sync ${mins}m — new captures stay queued until space is freed`
          : `[engram] billing limit hit, backing off ${mins}m (attempt ${this.billingBackoffStep}): ${msg}`,
      );
    }

    if (storageFull) {
      recordFailure(msg, "storage_full", this.pendingCount(), {
        storage: { used: storageFull.used, limit: storageFull.limit },
        retryAt: this.nextRetryAt(),
      });
    } else {
      recordFailure(msg, "billing", this.pendingCount(), { retryAt: this.nextRetryAt() });
    }
  }

  /**
   * The API key was rejected: pause sending on AUTH_RETRY_MS. Escalates once
   * per pause, like the billing backoff: sends rejected together are one
   * rejection. Captures keep queueing in daemon.db meanwhile.
   */
  private enterAuthHold(msg: string): void {
    if (!this.authHeld()) {
      const delay = AUTH_RETRY_MS[Math.min(this.authHoldStep, AUTH_RETRY_MS.length - 1)];
      this.authHeldUntil = Date.now() + delay;
      this.authHoldStep++;
      console.error(
        `[engram] API key rejected — sync paused. Retrying in ${Math.round(delay / 60_000)}m, ` +
          `or as soon as a new key is saved ('${engramCommand("auth login")}'): ${msg}`,
      );
    }
    recordFailure(msg, "auth", this.pendingCount(), { retryAt: this.nextRetryAt() });
  }

  private authHeld(): boolean {
    return Date.now() < this.authHeldUntil;
  }

  /**
   * The server refused a request for when it came, not for what it carried:
   * a rate limit, or a pause for maintenance (engram#596). Nothing is sent
   * from this account until the wait is over, and each pause in a row
   * without a request going through waits longer (retryDelay), up to a few
   * minutes. Escalates once per pause, like the other holds: requests
   * refused together are one refusal. The wait is drawn at random within
   * its range, so daemons refused together don't all come back together.
   */
  private enterThrottle(msg: string, errType: "rate_limit" | "paused"): void {
    if (errType === "paused") this.throttlePaused = true;
    if (!this.throttled()) {
      this.throttleStep++;
      const delay = retryDelay(this.throttleStep);
      this.throttledUntil = Date.now() + delay;
      console.error(
        `[engram] ${errType === "paused" ? "Engram is paused for maintenance" : "rate limited"} — ` +
          `sending nothing for ${formatWait(delay)}, messages stay queued: ${msg}`,
      );
    }
    recordFailure(msg, errType, this.pendingCount(), { retryAt: this.nextRetryAt() });
  }

  private throttled(): boolean {
    return Date.now() < this.throttledUntil;
  }

  /**
   * A request with `run`'s key went through: the key works, and the server
   * takes requests again. A maintenance pause holds only sends, so only a
   * send (`sent`) shows one is over. Lifts no pause early; the next one
   * only starts over at the shortest wait.
   */
  private requestWentThrough(run: Run, sent: boolean): void {
    if (this.active !== run) return;
    this.authHoldStep = 0;
    if (sent || !this.throttlePaused) {
      this.throttleStep = 0;
      this.throttlePaused = false;
    }
  }

  /** True while sending with `run` must not or can only fail: its key is
   *  no longer the one configured, the key was rejected, the account is
   *  inside a billing backoff, or it waits out a rate limit or a pause. */
  private halted(run: Run): boolean {
    return (
      this.active !== run ||
      this.authHeld() ||
      Date.now() < this.billingBackoffUntil ||
      this.throttled()
    );
  }

  /**
   * When the daemon next tries what failed, for the status (engram#596):
   * the end of a pause that holds every send, else the earliest turn of a
   * conversation or a session waiting after a failure of its own. Null when
   * nothing waits for a set time.
   */
  private nextRetryAt(): number | null {
    const now = Date.now();
    const hold = Math.max(this.authHeldUntil, this.billingBackoffUntil, this.throttledUntil);
    if (hold > now) return hold;
    let next: number | null = null;
    for (const waits of [this.sendRetry, this.createRetry]) {
      for (const { until } of waits.values()) {
        if (until > now && (next === null || until < next)) next = until;
      }
    }
    return next;
  }

  /** Unsent messages the key in use will send, for the status: 0 while
   *  signed out, and when daemon.db can't be read. */
  private pendingCount(): number {
    const run = this.active;
    if (!run) return 0;
    try {
      return this.db.getPendingCount(run.fp);
    } catch {
      return 0;
    }
  }

  /** Reset billing backoff after a successful sync. */
  private resetBillingBackoff(): void {
    if (this.billingBackoffStep > 0) {
      console.log("[engram] billing backoff cleared, resuming normal sync");
    }
    this.billingBackoffUntil = 0;
    this.billingBackoffStep = 0;
  }

  private async createConversation(
    run: Run,
    sessionId: string,
    meta: SessionMeta,
  ): Promise<string> {
    const host = meta.host ?? "claude-code";
    const title = `${meta.projectDir || host} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;

    const { conversationId } = await run.client.createConversation({
      title,
      // Per-host tagging (engram#261) so captures are attributable and
      // filterable by source tool.
      agentId: host,
      tags: [host, "auto-capture"],
      metadata: {
        sessionId,
        host,
        projectDir: meta.projectDir,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        capturedBy: "engram-daemon",
        // Metadata rebuilt after the session's own was lost (engram#370).
        ...(meta.recovered ? { recovered: true } : {}),
      },
    });

    return conversationId;
  }
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (text) return text;
  // The SDK gives no text for an error body it doesn't read (a 429 says why
  // in a field it doesn't look at); the status at least names it.
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? `HTTP ${status}` : "unknown error";
}

/** A wait of whole minutes, hours or days, in words: "10 minutes", "1 hour",
 *  "3 days". */
function waitInWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  return plural(Math.round(hours / 24), "day");
}

/** Wait before trying one thing again that failed again: the wait doubles
 *  with each failure in a row (retryDelay). Returns it. */
function waitAgain(waits: Map<string, Wait>, id: string): number {
  const step = (waits.get(id)?.step ?? 0) + 1;
  const delay = retryDelay(step);
  waits.set(id, { until: Date.now() + delay, step });
  return delay;
}

/** Forget the waits of what no longer waits to go out. */
function forgetDone(waits: Map<string, Wait>, still: readonly string[]): void {
  if (waits.size === 0) return;
  const keep = new Set(still);
  for (const id of waits.keys()) {
    if (!keep.has(id)) waits.delete(id);
  }
}

function rowToMessage(row: PendingRow) {
  const msg: {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    toolCallId?: string;
    toolName?: string;
    metadata?: Record<string, unknown>;
  } = {
    role: row.role as "user" | "assistant" | "system" | "tool",
    content: row.content,
  };
  if (row.tool_call_id) msg.toolCallId = row.tool_call_id;
  if (row.tool_name) msg.toolName = row.tool_name;
  if (row.metadata) msg.metadata = JSON.parse(row.metadata);
  return msg;
}
