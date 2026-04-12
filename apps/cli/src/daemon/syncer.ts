import type { Engram } from "@getengram/sdk";
import { DaemonDb } from "./db.js";
import type { ParsedMessage, SessionMeta, PendingRow } from "./types.js";

const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

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

  constructor(db: DaemonDb, client: Engram) {
    this.db = db;
    this.client = client;
  }

  /**
   * Called by the parser when new messages are ready for a session.
   * Creates the Engram conversation if needed, then queues messages.
   */
  async onMessages(
    sessionId: string,
    meta: SessionMeta,
    messages: ParsedMessage[],
  ): Promise<void> {
    try {
      let conversationId = this.db.getConversationId(sessionId);

      if (!conversationId) {
        conversationId = await this.createConversation(sessionId, meta);
      }

      this.db.enqueue(conversationId, messages);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] queue error: ${msg}`);
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

  /** Flush all pending messages to the API, batched per conversation. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      const convIds = this.db.getPendingConversationIds();

      for (const convId of convIds) {
        await this.flushConversation(convId);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[engram] flush error: ${msg}`);
    } finally {
      this.flushing = false;
    }
  }

  private async flushConversation(conversationId: string): Promise<void> {
    // Process in batches
    while (true) {
      const rows = this.db.dequeue(conversationId, BATCH_SIZE);
      if (rows.length === 0) break;

      const messages = rows.map(rowToMessage);

      try {
        await this.client.store({ conversationId, messages });
        this.db.markSent(rows.map((r) => r.id));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);

        // Auth errors — stop retrying, user needs to fix their key
        if (msg.includes("401") || msg.includes("403") || msg.includes("Authentication")) {
          console.error(`[engram] auth error, stopping flush: ${msg}`);
          this.stopFlushLoop();
          return;
        }

        // Rate limit or network — leave in queue for next cycle
        console.error(`[engram] send failed (will retry): ${msg}`);
        return;
      }
    }
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
