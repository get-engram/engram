import type { Engram } from "@getengram/sdk";
import { DaemonDb } from "./db.js";
import { recordSuccess, recordFailure, classifyError, isNotFound } from "./status.js";
import { parseStorageFullError } from "../storage-error.js";
import { isPathExcluded, detectOptOut } from "./exclusions.js";
import type { SecretScrubber } from "./scrubber.js";
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
 * and leaves this process running with the old one. Now a paused daemon
 * looks for a new key every KEY_CHECK_MS and switches to it at once; this
 * schedule only paces retries of the same key, for a key that was refused
 * for a while and accepted again.
 */
const AUTH_RETRY_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];

/** How often a paused daemon reads the configured key. */
const KEY_CHECK_MS = 10_000;

/**
 * Where the daemon's API key comes from, so a rejected key can be replaced
 * without a restart.
 */
export interface KeySource {
  /** The key the client was built with. */
  current: string;
  /** The key configured now: ENGRAM_API_KEY, else ~/.engram/config.json. */
  read(): Promise<string | undefined>;
  /** A client for a new key. */
  connect(key: string): Engram;
}

/**
 * How one conversation's turn in a flush ended (engram#580). Only "sent"
 * means its queue is empty, and only a flush in which every conversation
 * sent is a successful sync.
 */
type SendOutcome =
  | "sent" // everything queued for it went out
  | "retry" // a send failed; its rows stay queued for a later flush
  | "backoff" // the account hit a billing or storage limit
  | "auth"; // the API key was rejected; sending pauses (AUTH_RETRY_MS)

/** Retry schedule for one session whose conversation create failed with an
 *  ordinary error (network, 5xx, rejected input). Its messages stay queued
 *  in daemon.db throughout — this only paces the retries. */
const CREATE_RETRY_MS = [30_000, 2 * 60_000, 10 * 60_000];

/**
 * Batches parsed messages and sends them to the Engram API.
 * If offline, messages sit in the SQLite queue and are retried
 * on the next flush cycle.
 */
export class Syncer {
  private db: DaemonDb;
  private client: Engram;
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  /** Paused because the API key was rejected: until when, and how many
   *  pauses in a row without a request going through. */
  private authHeldUntil = 0;
  private authHoldStep = 0;
  /** The key the client was built with, and when the configured key was
   *  last read for a new one. */
  private currentKey: string | undefined;
  private lastKeyCheck = 0;

  /** Billing backoff state */
  private billingBackoffUntil: number = 0;
  private billingBackoffStep: number = 0;

  /** Sessions whose conversation create failed: when to try again. The
   *  sessions themselves live in daemon.db (engram#370) — losing this map
   *  on a restart only means an earlier retry. */
  private createRetry = new Map<string, { until: number; step: number }>();

  /** Rows orphaned by a pre-#370 daemon are adopted once per process. */
  private orphansAdopted = false;

  constructor(
    db: DaemonDb,
    client: Engram,
    private readonly scrubber: SecretScrubber | null = null,
    private readonly keys: KeySource | null = null,
  ) {
    this.db = db;
    this.client = client;
    this.currentKey = keys?.current;
  }

  /**
   * Called by the parser when new messages are ready for a session.
   * Queues messages locally; conversation creation is deferred to flush time
   * to avoid blocking the parser on network calls.
   */
  async onMessages(
    sessionId: string,
    meta: SessionMeta,
    messages: ParsedMessage[],
  ): Promise<void> {
    // Capture exclusions (engram#462) — checked here, the single funnel, so
    // an excluded session never touches the queue or the network.

    // A session the user already opted out of stays out.
    if (this.db.isSessionExcluded(sessionId)) return;

    // Repo/directory exclusions: `engram exclude add <path>` or a
    // .engramignore marker at the repo root. Checked per batch (cheap,
    // cached) so a freshly added exclusion applies without a restart.
    if (isPathExcluded(meta.cwd)) return;

    // In-chat opt-out: a USER message saying "don't save this to engram"
    // (or `engram:ignore`) excludes the whole session — including what was
    // already captured.
    if (messages.some((m) => m.role === "user" && detectOptOut(m.content))) {
      await this.excludeSession(sessionId, "in-chat opt-out");
      return;
    }

    // Check if we already have a mapping
    const conversationId = this.db.getConversationId(sessionId);

    // Value-exact scrubbing of known vault secrets, applied to every role
    // (tool output is where `engram vault get` lands). This is the last
    // point before content touches disk, so even the local queue never
    // holds a plaintext vault value.
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

    if (conversationId) {
      this.db.enqueue(conversationId, messages);
    } else {
      // No conversation yet. Creating it is deferred to the flush loop so
      // the parser never waits on the network; until then the messages wait
      // under pending:<sessionId>, recorded together with the session in
      // daemon.db (engram#370) so a restart or a failed create can't strand
      // them.
      this.db.enqueuePendingSession(sessionId, meta, messages);
    }
  }

  /**
   * The user said not to save this session. Semantics are "this session was
   * never captured": stop future capture, wipe the local queue, and delete
   * whatever already reached the server. The remote delete is persisted in
   * excluded_sessions.delete_pending and retried from the flush loop until
   * it succeeds — offline opt-out must still stick.
   */
  private async excludeSession(sessionId: string, reason: string): Promise<void> {
    const conversationId = this.db.getConversationId(sessionId);

    this.db.markSessionExcluded(sessionId, reason, conversationId ?? undefined);
    this.createRetry.delete(sessionId);
    const dropped =
      this.db.dropPendingSession(sessionId) +
      (conversationId ? this.db.deleteAllForConversation(conversationId) : 0);

    console.log(
      `[engram] session ${sessionId} excluded (${reason}) — ` +
        `${dropped} queued message(s) dropped` +
        (conversationId ? ", deleting synced copy" : ""),
    );

    if (conversationId) {
      await this.retryRemoteDeletes();
    }
  }

  /** Delete server-side conversations for opted-out sessions; keeps
   *  delete_pending until the server confirms. */
  private async retryRemoteDeletes(): Promise<void> {
    // A rejected key can't delete either; the deletes keep until it's fixed.
    if (this.authHeld()) return;
    for (const row of this.db.getPendingRemoteDeletes()) {
      try {
        await this.client.deleteConversation(row.delete_pending);
        this.keyAccepted();
        this.db.clearPendingRemoteDelete(row.session_id);
        console.log(
          `[engram] deleted synced conversation ${row.delete_pending} for opted-out session`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // Engram saying "not found" means it's already gone (or was never
        // fully created) — the promise is kept either way. Only Engram's
        // own answer counts (engram#587): this used to accept any text
        // matching /not.?found/ or "404", and a DNS failure (ENOTFOUND)
        // matches that. The delete was dropped while the copy stayed.
        if (isNotFound(err)) {
          this.keyAccepted();
          this.db.clearPendingRemoteDelete(row.session_id);
          continue;
        }
        console.error(
          `[engram] opt-out delete failed for ${row.delete_pending} (will retry): ${msg}`,
        );
        // Only a key refused outright pauses everything. A key that works
        // but lacks the delete scope (insufficient_scope) can still save.
        if (classifyError(err) === "auth" && !isScopeRefusal(msg)) {
          this.enterAuthHold(msg);
          return;
        }
      }
    }
  }

  startFlushLoop(): void {
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  stopFlushLoop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Flush all pending messages to the API. */
  async flush(): Promise<void> {
    if (this.flushing) return;

    this.flushing = true;

    try {
      // A rejected key: `engram auth login` may have saved a new one.
      if (this.authHeld()) await this.pickUpNewKey();

      // Nothing can send while the key is rejected or a billing backoff holds.
      if (this.halted()) return;

      // Step 0: Honor opt-outs whose server-side delete hasn't landed yet
      // (e.g. the machine was offline when the user said "don't save this").
      await this.retryRemoteDeletes();
      if (this.halted()) return; // the key was rejected there

      // Step 1: Create any pending conversations
      const createsOk = await this.createPendingConversations();

      // Step 2: Flush messages for all conversations (with concurrency)
      const convIds = this.db.getPendingConversationIds().filter(
        (id) => !id.startsWith("pending:"),
      );

      // Process conversations in parallel, up to CONCURRENCY at a time
      const chunks = [];
      for (let i = 0; i < convIds.length; i += CONCURRENCY) {
        chunks.push(convIds.slice(i, i + CONCURRENCY));
      }

      let allSent = true;
      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map((id) => this.flushConversation(id)),
        );
        if (results.some((r) => r.status === "rejected" || r.value !== "sent")) {
          allSent = false;
        }
      }

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
      // until a request goes through (keyAccepted) or a new key is saved.
      const pending = this.db.getPendingCount();
      if (createsOk && allSent && this.authHoldStep === 0) {
        this.resetBillingBackoff();
        recordSuccess(pending);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] flush error: ${msg}`);
      recordFailure(msg, classifyError(err), this.db.getPendingCount());
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Create conversations for sessions that were deferred during parsing.
   * Every session stays in daemon.db until its conversation exists and its
   * messages have moved onto it — a failure here only means "try again".
   * Returns false while any session is still waiting on a failed create.
   */
  private async createPendingConversations(): Promise<boolean> {
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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[engram] orphaned-queue check failed (will retry): ${msg}`);
        ok = false;
      }
    }

    const now = Date.now();
    const pending = this.db.getPendingSessions();
    const sessions = pending.filter(
      (s) => (this.createRetry.get(s.sessionId)?.until ?? 0) <= now,
    );
    // A session sitting out a retry delay hasn't synced.
    if (sessions.length < pending.length) ok = false;

    // Create conversations in parallel batches
    for (let i = 0; i < sessions.length; i += CONCURRENCY) {
      const batch = sessions.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((s) => this.createPendingConversation(s.sessionId, s.meta)),
      );

      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        const sessionId = batch[j].sessionId;
        if (r.status === "fulfilled") {
          this.createRetry.delete(sessionId);
          continue;
        }
        ok = false;
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        const errType = classifyError(r.reason);
        if (errType === "auth") {
          this.enterAuthHold(msg);
          return false;
        }
        if (errType === "billing" || errType === "storage_full") {
          this.enterBillingBackoff(msg);
          return false;
        }
        this.deferCreate(sessionId);
        console.error(`[engram] create error (will retry): ${msg}`);
        recordFailure(msg, errType, this.db.getPendingCount());
      }
    }
    return ok;
  }

  private async createPendingConversation(
    sessionId: string,
    meta: SessionMeta,
  ): Promise<void> {
    // Opted out while it waited: nothing of this session may sync.
    if (this.db.isSessionExcluded(sessionId)) {
      this.db.dropPendingSession(sessionId);
      return;
    }

    // Already mapped (rows an older daemon left under the temporary id after
    // the conversation was created) — move them; never create a second
    // conversation for the session.
    const existing = this.db.getConversationId(sessionId);
    if (existing) {
      this.db.completePendingSession(sessionId, existing);
      return;
    }

    const conversationId = await this.createConversation(sessionId, meta);
    this.keyAccepted();

    // Opt-out race (engram#462): the user may have said "don't save
    // this" while the create was in flight — excludeSession saw no
    // conversation id yet, so it couldn't schedule the remote delete.
    // Schedule it now; the flush loop's retryRemoteDeletes handles it.
    if (this.db.isSessionExcluded(sessionId)) {
      this.db.markSessionExcluded(sessionId, "in-chat opt-out", conversationId);
      this.db.dropPendingSession(sessionId);
      this.db.deleteAllForConversation(conversationId);
      return;
    }

    // Map the session and move its messages onto the conversation (one
    // transaction — see DaemonDb.completePendingSession).
    this.db.completePendingSession(sessionId, conversationId, {
      projectDir: meta.projectDir,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
    });
  }

  /** Pace retries for a session whose create failed: 30s → 2m → 10m … */
  private deferCreate(sessionId: string): void {
    const prev = this.createRetry.get(sessionId);
    const step = prev ? prev.step + 1 : 0;
    const delay = CREATE_RETRY_MS[Math.min(step, CREATE_RETRY_MS.length - 1)];
    this.createRetry.set(sessionId, { until: Date.now() + delay, step });
  }

  /** Per-conversation reduced batch size after a failed send (halves down to
   *  1 so even a single pathological message eventually goes alone; restored
   *  to the full batch on the next success). */
  private batchOverride = new Map<string, number>();

  private async flushConversation(conversationId: string): Promise<SendOutcome> {
    while (true) {
      // An auth failure or a billing limit applies to the whole account.
      // Once any conversation in this flush has hit one, no new batch is
      // started: it could only fail the same way.
      if (this.authHeld()) return "auth";
      if (Date.now() < this.billingBackoffUntil) return "backoff";

      const limit = this.batchOverride.get(conversationId) ?? BATCH_SIZE;
      let rows = this.db.dequeue(conversationId, limit);
      if (rows.length === 0) return "sent";

      // Byte budget: transcript messages vary wildly in size — trim the batch
      // so its total content stays inside the budget. Always send at least
      // one row, however large (the server accepts it; it just needs time).
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
        await this.client.store({ conversationId, messages });
        this.keyAccepted();
        this.db.markSent(rows.map((r) => r.id));
        this.batchOverride.delete(conversationId);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
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

        // Network/timeout/server — leave in queue for next cycle, but halve
        // this conversation's batch so an oversized batch self-resolves
        // instead of retrying the identical payload forever. A rate limit
        // refuses the request, not its size: halving it would only multiply
        // the requests.
        if (rows.length > 1 && errType !== "rate_limit") {
          const next = Math.max(1, Math.floor(rows.length / 2));
          this.batchOverride.set(conversationId, next);
          console.error(
            `[engram] send failed (will retry with batch ${next}): ${msg}`,
          );
        } else {
          console.error(`[engram] send failed (will retry): ${msg}`);
        }
        recordFailure(msg, errType, this.db.getPendingCount());
        return "retry";
      }
    }
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
      recordFailure(msg, "storage_full", this.db.getPendingCount(), {
        used: storageFull.used,
        limit: storageFull.limit,
      });
    } else {
      recordFailure(msg, "billing", this.db.getPendingCount());
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
          `or as soon as a new key is saved ('engram auth login'): ${msg}`,
      );
    }
    recordFailure(msg, "auth", this.db.getPendingCount());
  }

  private authHeld(): boolean {
    return Date.now() < this.authHeldUntil;
  }

  /** A request went through: the key works. */
  private keyAccepted(): void {
    this.authHoldStep = 0;
  }

  /**
   * While the key is rejected, switch to a new one as soon as it's saved
   * (`engram auth login` writes config.json and leaves the daemon running).
   * Throttled to KEY_CHECK_MS. Never throws: a config.json read mid-write
   * has no key, and is read again on the next check.
   */
  private async pickUpNewKey(): Promise<void> {
    if (!this.keys) return;
    const now = Date.now();
    if (now - this.lastKeyCheck < KEY_CHECK_MS) return;
    this.lastKeyCheck = now;

    let client: Engram;
    let key: string | undefined;
    try {
      key = await this.keys.read();
      if (!key || key === this.currentKey) return;
      client = this.keys.connect(key);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] reading the API key failed (will retry): ${msg}`);
      return;
    }

    this.client = client;
    this.currentKey = key;
    this.authHeldUntil = 0;
    this.authHoldStep = 0;
    // The new key may belong to an account with room, and a held billing
    // backoff would only delay finding out.
    this.resetBillingBackoff();
    console.log("[engram] new API key found — resuming sync");
  }

  /** True while sending can only fail: the API key was rejected, or the
   *  account is inside a billing backoff. */
  private halted(): boolean {
    return this.authHeld() || Date.now() < this.billingBackoffUntil;
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
    sessionId: string,
    meta: SessionMeta,
  ): Promise<string> {
    const host = meta.host ?? "claude-code";
    const title = `${meta.projectDir || host} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;

    const { conversationId } = await this.client.createConversation({
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

/** The server's refusal of a key that works but lacks a scope. */
function isScopeRefusal(msg: string): boolean {
  return msg.includes('"insufficient_scope"');
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
