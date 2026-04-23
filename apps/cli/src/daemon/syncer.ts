import type { Engram } from "@getengram/sdk";
import { DaemonDb } from "./db.js";
import { recordSuccess, recordFailure, classifyError } from "./status.js";
import type { ParsedMessage, SessionMeta, PendingRow } from "./types.js";

const BATCH_SIZE = 200;
const FLUSH_INTERVAL_MS = 2_000;
const CONCURRENCY = 5;

/** Backoff schedule for billing/limit errors: 5min → 15min → 1hr → 1hr ... */
const BILLING_BACKOFF_MS = [
  5 * 60_000,    // 5 minutes
  15 * 60_000,   // 15 minutes
  60 * 60_000,   // 1 hour (cap)
];

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
  private authFailed = false;

  /** Billing backoff state */
  private billingBackoffUntil: number = 0;
  private billingBackoffStep: number = 0;

  /** Sessions awaiting conversation creation (deferred from parse time). */
  private pendingSessions = new Map<
    string,
    SessionMeta
  >();

  constructor(db: DaemonDb, client: Engram) {
    this.db = db;
    this.client = client;
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
    // Check if we already have a mapping
    let conversationId = this.db.getConversationId(sessionId);

    if (!conversationId) {
      // Defer creation — store messages under the sessionId temporarily.
      // The flush loop will create the conversation and re-map them.
      this.pendingSessions.set(sessionId, meta);
      conversationId = `pending:${sessionId}`;
    }

    this.db.enqueue(conversationId, messages);
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
    if (this.flushing || this.authFailed) return;

    // Skip if in billing backoff window
    if (Date.now() < this.billingBackoffUntil) return;

    this.flushing = true;

    try {
      // Step 1: Create any pending conversations
      await this.createPendingConversations();

      // Step 2: Flush messages for all conversations (with concurrency)
      const convIds = this.db.getPendingConversationIds().filter(
        (id) => !id.startsWith("pending:"),
      );

      // Process conversations in parallel, up to CONCURRENCY at a time
      const chunks = [];
      for (let i = 0; i < convIds.length; i += CONCURRENCY) {
        chunks.push(convIds.slice(i, i + CONCURRENCY));
      }

      let hadError = false;
      for (const chunk of chunks) {
        const results = await Promise.allSettled(
          chunk.map((id) => this.flushConversation(id)),
        );
        if (results.some((r) => r.status === "rejected")) hadError = true;
      }

      // Report sync health
      const pending = this.db.getPendingCount();
      if (!hadError && !this.authFailed) {
        this.resetBillingBackoff();
        recordSuccess(pending);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] flush error: ${msg}`);
      recordFailure(msg, classifyError(msg), this.db.getPendingCount());
    } finally {
      this.flushing = false;
    }
  }

  /** Create conversations for sessions that were deferred during parsing. */
  private async createPendingConversations(): Promise<void> {
    if (this.pendingSessions.size === 0) return;

    const entries = [...this.pendingSessions.entries()];
    this.pendingSessions.clear();

    // Create conversations in parallel batches
    const batches = [];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      batches.push(entries.slice(i, i + CONCURRENCY));
    }

    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map(async ([sessionId, meta]) => {
          // Double-check (another flush may have created it)
          if (this.db.getConversationId(sessionId)) return;

          const conversationId = await this.createConversation(sessionId, meta);

          // Migrate pending messages from pending:sessionId → real conversationId
          this.db.remapPending(`pending:${sessionId}`, conversationId);
        }),
      );

      for (const r of results) {
        if (r.status === "rejected") {
          const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
          if (msg.includes("401") || msg.includes("403")) {
            this.authFailed = true;
            console.error(`[engram] auth error, stopping: ${msg}`);
            recordFailure(msg, "auth", this.db.getPendingCount());
            return;
          }
          const errType = classifyError(msg);
          if (errType === "billing") {
            this.enterBillingBackoff(msg);
            return;
          }
          console.error(`[engram] create error (will retry): ${msg}`);
          recordFailure(msg, errType, this.db.getPendingCount());
        }
      }
    }
  }

  private async flushConversation(conversationId: string): Promise<void> {
    while (true) {
      const rows = this.db.dequeue(conversationId, BATCH_SIZE);
      if (rows.length === 0) break;

      const messages = rows.map(rowToMessage);

      try {
        await this.client.store({ conversationId, messages });
        this.db.markSent(rows.map((r) => r.id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        if (msg.includes("401") || msg.includes("403") || msg.includes("Authentication")) {
          this.authFailed = true;
          console.error(`[engram] auth error, stopping flush: ${msg}`);
          recordFailure(msg, "auth", this.db.getPendingCount());
          this.stopFlushLoop();
          return;
        }

        // Billing / limit errors — exponential backoff
        const errType = classifyError(msg);
        if (errType === "billing") {
          this.enterBillingBackoff(msg);
          return;
        }

        // Rate limit or network — leave in queue for next cycle
        console.error(`[engram] send failed (will retry): ${msg}`);
        recordFailure(msg, errType, this.db.getPendingCount());
        return;
      }
    }
  }

  /** Enter billing backoff — escalates each time: 5min → 15min → 1hr */
  private enterBillingBackoff(msg: string): void {
    const delay = BILLING_BACKOFF_MS[
      Math.min(this.billingBackoffStep, BILLING_BACKOFF_MS.length - 1)
    ];
    this.billingBackoffUntil = Date.now() + delay;
    this.billingBackoffStep++;

    const mins = Math.round(delay / 60_000);
    console.error(
      `[engram] billing limit hit, backing off ${mins}m (attempt ${this.billingBackoffStep}): ${msg}`,
    );
    recordFailure(msg, "billing", this.db.getPendingCount());
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
    const title = `${meta.projectDir} (${new Date().toISOString().slice(0, 16).replace("T", " ")})`;

    const { conversationId } = await this.client.createConversation({
      title,
      agentId: "claude-code",
      tags: ["claude-code", "auto-capture"],
      metadata: {
        sessionId,
        projectDir: meta.projectDir,
        cwd: meta.cwd,
        gitBranch: meta.gitBranch,
        capturedBy: "engram-daemon",
      },
    });

    this.db.setSessionMap(sessionId, conversationId, {
      projectDir: meta.projectDir,
      cwd: meta.cwd,
      gitBranch: meta.gitBranch,
    });

    return conversationId;
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
