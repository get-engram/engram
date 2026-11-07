import { HTTPException } from "hono/http-exception";
import {
  generateId,
  chunkMessages,
  chunkId,
  summarizeChunk,
  redactMessages,
  MAX_MESSAGE_CONTENT_CHARS,
  type MessageInput,
  type Message,
  type Conversation,
  type ChunkResult,
} from "@getengram/shared";
import {
  insertConversation,
  getConversationById,
  getConversationByFingerprint,
  getDefaultConversationId,
  DEFAULT_CONVERSATION_TAG,
  listConversations as dbListConversations,
  deleteConversationById,
  insertMessagesWithCount,
  getMessagesByConversation,
  getMaxSequence,
  insertChunks,
  getVectorizeIdsByConversation,
  insertVaultEntries,
  getMessageById,
  deleteMessageWithCount,
  updateMessageContent,
  getMessagesBySequenceRange,
  getChunksOverlappingSequence,
  replaceChunks,
  getR2MessageIdsByConversation,

  insertMessageRevision,
  nextRevisionNumber,
  getR2RevisionIdsByMessage,
  getR2RevisionIdsByConversation,
} from "@getengram/db";
import { generateEmbeddings } from "./embedding.js";
import {
  releaseStorage,
  checkAndTrackIndexing,
  boundContent,
  IndexingQuotaError,
  type TierCheckResult,
} from "./tier.js";
import { storeContent, deleteContent, loadContent } from "./content-store.js";
import {
  copyChunkTextsToR2,
  chunkObjectKey,
  deleteChunkObjects,
  deleteConversationChunkObjects,
} from "./chunk-store.js";
import { deleteVectorsByIds } from "./vectorize.js";
import type { Env, AuthContext } from "../types.js";
import { canAccessConversation } from "./spaces.js";

export async function createConversation(
  db: D1Database,
  organizationId: string,
  title?: string,
  agentId?: string,
  tags?: string[],
  metadata?: Record<string, unknown>,
  space?: { seatId?: string | null; visibility?: "shared" | "private" }
): Promise<string> {
  const created = await createConversationDedup(
    db, organizationId, title, agentId, tags, metadata, space,
  );
  return created.id;
}

/**
 * Create a conversation, honoring importer idempotency (engram#254):
 * when metadata.import_fingerprint is present and a conversation with
 * that fingerprint already exists for the org, return it instead of
 * creating a duplicate. The fingerprint is also promoted to its indexed
 * column on insert.
 */
export async function createConversationDedup(
  db: D1Database,
  organizationId: string,
  title?: string,
  agentId?: string,
  tags?: string[],
  metadata?: Record<string, unknown>,
  space?: { seatId?: string | null; visibility?: "shared" | "private" }
): Promise<{ id: string; existing: boolean; message_count: number }> {
  const fingerprint =
    typeof metadata?.import_fingerprint === "string" && metadata.import_fingerprint
      ? metadata.import_fingerprint.slice(0, 200)
      : null;

  if (fingerprint) {
    const dupe = await getConversationByFingerprint(db, organizationId, fingerprint);
    if (dupe) return { id: dupe.id, existing: true, message_count: dupe.message_count ?? 0 };
  }

  const id = generateId("conv");
  await insertConversation(
    db,
    id,
    organizationId,
    title ?? null,
    agentId ?? null,
    tags ?? [],
    metadata ?? {},
    space?.seatId ?? null,
    space?.visibility ?? "shared"
  );
  if (fingerprint) {
    await db
      .prepare("UPDATE conversations SET import_fingerprint = ? WHERE id = ?")
      .bind(fingerprint, id)
      .run();
  }
  return { id, existing: false, message_count: 0 };
}

/**
 * Get the org's default memory conversation, creating it on first use. This
 * is the target for append_messages calls that don't specify a conversation —
 * it lets agents "just remember this" without managing conversation ids.
 */
export async function getOrCreateDefaultConversation(
  db: D1Database,
  organizationId: string,
): Promise<string> {
  const existing = await getDefaultConversationId(db, organizationId);
  if (existing?.id) return existing.id;
  return createConversation(db, organizationId, "Memory", undefined, [
    DEFAULT_CONVERSATION_TAG,
  ]);
}

export interface VaultEntryInput {
  id: string;
  encrypted_value: string;
  iv: string;
  secret_type: string;
}

/**
 * Maintenance write freeze.
 *
 * Set WRITES_FROZEN=1 to reject writes for the length of a maintenance
 * window. Used for operations that must not race with concurrent inserts —
 * notably rebuilding the messages table to reclaim freed pages (#383), where
 * a row written mid-copy would be silently dropped by the table swap.
 *
 * Freezing rather than reconciling afterwards is a deliberate choice: it is
 * the only approach that is zero-loss *by construction* rather than by
 * getting a delta query right. The rebuild takes minutes, and the CLI daemon
 * already queues locally and retries on failure, so for the largest writers
 * this degrades to a pause rather than an error.
 *
 * Reads, search and recall stay fully available throughout.
 */
export function assertWritesEnabled(env: Env): void {
  if (env.WRITES_FROZEN === "1") {
    const message =
      "Engram is paused for a few minutes of scheduled maintenance. " +
      "Nothing already saved is affected, and nothing is lost — retry shortly, " +
      "or let your client retry automatically.";
    // An HTTPException, like the 404 in appendMessages, so both layers answer
    // with this text instead of masking it: a bare Error reached app.onError
    // as a generic 500 on the REST path, and the tool guard (engram#513) would
    // now hide it as an internal failure on the MCP path. 503 + Retry-After
    // is what the CLI daemon already backs off on.
    throw new HTTPException(503, {
      message,
      res: new Response(JSON.stringify({ error: "writes_paused", message }), {
        status: 503,
        headers: { "Content-Type": "application/json", "Retry-After": "60" },
      }),
    });
  }
}

/**
 * Bound single-message content by TRUNCATING, not rejecting. This caps
 * worst-case stored bytes (a free org's 10k-message cap x this ceiling is the
 * storage ceiling) without wedging the CLI sync daemon, which cannot split one
 * oversized message and would otherwise re-send and re-fail the same row
 * forever. A visible marker keeps it honest — the reader sees the memory was
 * clipped rather than silently altered. Enormous single messages are
 * tool-output dumps (Claude Code), where the tail is the least useful part;
 * the request still succeeds and every other message is stored verbatim.
 * Exported for direct testing.
 */
export function boundMessageContent(messageInputs: MessageInput[]): MessageInput[] {
  return messageInputs.map((m) =>
    m.content.length > MAX_MESSAGE_CONTENT_CHARS ? { ...m, content: boundContent(m.content) } : m,
  );
}

export async function appendMessages(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageInputs: MessageInput[],
  vaultEntries?: VaultEntryInput[]
): Promise<Message[]> {
  assertWritesEnabled(env);

  messageInputs = boundMessageContent(messageInputs);

  // Verify conversation exists and belongs to org. The lookup is org-scoped,
  // so another tenant's id is indistinguishable from a nonexistent one —
  // which is the correct answer to give either way.
  //
  // Thrown as a 404 HTTPException rather than a bare Error because the bare
  // Error reached app.onError and became a 500: a client that mistyped a
  // conversation_id got "internal_error", and every such mistake landed in
  // the logs as a server fault. The MCP tool pre-checks and returns its own
  // "Conversation not found", so this is the REST surface's equivalent.
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) {
    throw new HTTPException(404, {
      res: Response.json(
        {
          error: "conversation_not_found",
          message: "No conversation with that id exists in this account.",
        },
        { status: 404 },
      ),
    });
  }

  // Get current max sequence
  const seqResult = await getMaxSequence(env.DB, conversationId);
  let nextSeq = (seqResult?.max_seq ?? 0) + 1;

  // Build message records
  const messages: Message[] = messageInputs.map((input) => {
    const msg: Message = {
      id: generateId("msg"),
      conversation_id: conversationId,
      organization_id: organizationId,
      role: input.role,
      content: input.content,
      tool_call_id: input.tool_call_id ?? null,
      tool_name: input.tool_name ?? null,
      sequence: nextSeq++,
      metadata: input.metadata ?? {},
      created_at: new Date().toISOString(),
    };
    return msg;
  });

  // Redact secrets, credentials, and PII before storage
  const { messages: redacted, totalRedactions } = redactMessages(messages);
  if (totalRedactions > 0) {
    console.log(`[redact] Scrubbed ${totalRedactions} sensitive pattern(s) from ${conversationId}`);
  }

  // Store verbatim content in R2 (D1 keeps only a pointer), falling back to
  // inline D1 if R2 is unavailable so content is never lost.
  const stored = await Promise.all(
    redacted.map((m) => storeContent(env, m.id, m.content))
  );

  // Insert message rows (content lives in R2; D1 row carries the pointer) AND
  // bump the conversation's message_count in the SAME atomic batch, so the
  // count can never drift from the actual rows.
  await insertMessagesWithCount(
    env.DB,
    redacted.map((m, i) => ({
      id: m.id,
      conversationId: m.conversation_id,
      organizationId: m.organization_id,
      role: m.role,
      content: stored[i].content,
      contentEncoding: stored[i].encoding,
      toolCallId: m.tool_call_id,
      toolName: m.tool_name,
      sequence: m.sequence,
      metadata: m.metadata,
    })),
    conversationId,
  );

  // Store client-encrypted vault entries (zero-knowledge — server never decrypts)
  if (vaultEntries && vaultEntries.length > 0) {
    await insertVaultEntries(
      env.DB,
      vaultEntries.map((e) => ({
        id: e.id,
        organizationId,
        conversationId,
        messageId: null,
        secretType: e.secret_type,
        encryptedValue: e.encrypted_value,
        iv: e.iv,
        expiresAt: null,
      }))
    );
    console.log(
      `[vault] Stored ${vaultEntries.length} encrypted vault entry(ies) for ${conversationId}`
    );
  }

  // (message_count was bumped atomically with the inserts above.)

  // Chunk the redacted messages for embedding.
  // Indexing (embeddings + vectorize) is best-effort — if it fails, messages
  // are still stored. They just won't be searchable until the next successful
  // index run. This prevents AI model or Vectorize rate limits from crashing
  // the entire append_messages request.
  const chunks = chunkMessages(redacted);

  if (chunks.length > 0) {
    try {
      // Generate embeddings for all chunks
      const texts = chunks.map((c) => c.text);
      const embeddings = await generateEmbeddings(env.AI, texts);

      // Prepare chunk records with vectorize IDs
      const chunkRecords = chunks.map((chunk, i) => {
        // Deterministic id -> re-indexing the same window is a pure upsert,
        // never a duplicate. Same value for the row id and the vector id.
        const cid = chunkId(
          conversationId,
          chunk.startSequence,
          chunk.endSequence,
          chunk.index,
        );
        return {
          id: cid,
          conversationId,
          organizationId,
          chunkText: chunk.text,
          chunkSummary: summarizeChunk(chunk.text),
          startSequence: chunk.startSequence,
          endSequence: chunk.endSequence,
          vectorizeId: cid,
          embedding: embeddings[i],
        };
      });

      // Insert chunks into D1
      await insertChunks(
        env.DB,
        chunkRecords.map((c) => ({
          id: c.id,
          conversationId: c.conversationId,
          organizationId: c.organizationId,
          chunkText: c.chunkText,
          chunkSummary: c.chunkSummary,
          startSequence: c.startSequence,
          endSequence: c.endSequence,
          vectorizeId: c.vectorizeId,
        }))
      );

      // Second copy of each chunk's text in R2 (engram#384), written only
      // after the D1 rows exist and overlapped with the Vectorize upsert.
      // Best-effort and never throws: D1 still holds the text, and the
      // chunk mover copies anything this misses.
      const copied = copyChunkTextsToR2(
        env,
        conversationId,
        chunkRecords.map((c) => ({ id: c.id, text: c.chunkText })),
      );

      // Upsert vectors to Vectorize
      const vectors = chunkRecords.map((c) => ({
        id: c.vectorizeId,
        values: c.embedding,
        metadata: {
          organization_id: organizationId,
          conversation_id: conversationId,
          start_sequence: c.startSequence,
          end_sequence: c.endSequence,
        },
      }));

      try {
        await env.VECTORIZE.upsert(vectors);
      } finally {
        await copied;
      }
    } catch (err) {
      // Log but don't fail — messages are already stored above.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[index] Failed to index ${chunks.length} chunk(s) for ${conversationId}: ${msg}`,
      );
    }
  }

  return messages;
}

export async function getConversation(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageLimit: number,
  messageOffset: number
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) return null;

  const raw = conv as Record<string, unknown>;
  const conversation: Conversation = {
    id: raw.id as string,
    organization_id: raw.organization_id as string,
    title: raw.title as string | null,
    agent_id: raw.agent_id as string | null,
    tags: JSON.parse((raw.tags as string) || "[]"),
    metadata: JSON.parse((raw.metadata as string) || "{}"),
    message_count: raw.message_count as number,
    created_at: raw.created_at as string,
    updated_at: raw.updated_at as string,
  };

  const msgsResult = await getMessagesByConversation(
    env.DB,
    conversationId,
    organizationId,
    messageLimit,
    messageOffset
  );

  // Load message content (from R2 or legacy inline) in parallel
  const rawMessages = msgsResult.results as Array<Record<string, unknown>>;
  const messages = await Promise.all(
    rawMessages.map(async (m) => ({
      ...m,
      content: await loadContent(env, {
        id: m.id as string,
        content: m.content as string,
        content_encoding: m.content_encoding as string | null,
      }),
      metadata: JSON.parse((m.metadata as string) || "{}"),
    }))
  ) as Message[];

  return { conversation, messages };
}

/**
 * Update one message's content in place (engram: update API — requested by
 * the community Obsidian plugin). The edit goes through the same redaction
 * + compression pipeline as append, then the search index is rebuilt for
 * exactly the chunk window the message participates in: overlapping chunks
 * are deleted (D1 + FTS + Vectorize) and re-chunked from the fresh message
 * contents, so recall stays consistent with what's stored. Reindexing is
 * best-effort like append — on failure the edit is saved and search
 * catches up on the next successful index.
 *
 * Returns the updated message, or null if the conversation/message doesn't
 * exist (or the viewer can't access a private conversation).
 */
export async function updateMessage(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageId: string,
  newContent: string,
  viewer?: AuthContext
): Promise<Message | null> {
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) return null;
  if (
    viewer &&
    !canAccessConversation(
      viewer,
      conv as { visibility?: string | null; seat_id?: string | null }
    )
  ) {
    return null;
  }

  const existing = (await getMessageById(env.DB, messageId, organizationId)) as
    | (Record<string, unknown> & { conversation_id: string; sequence: number })
    | null;
  if (!existing || existing.conversation_id !== conversationId) return null;

  // Same hygiene as append: bound (engram#445 — an edit used to take
  // 1,000,000 characters straight into the embedding model, ~10x append's
  // per-message ceiling), redact, then compress for storage.
  const [bounded] = boundMessageContent([
    { role: existing.role as MessageInput["role"], content: newContent },
  ]);
  const candidate: Message = {
    id: existing.id as string,
    conversation_id: conversationId,
    organization_id: organizationId,
    role: existing.role as Message["role"],
    content: bounded.content,
    tool_call_id: (existing.tool_call_id as string | null) ?? null,
    tool_name: (existing.tool_name as string | null) ?? null,
    sequence: existing.sequence,
    metadata: JSON.parse((existing.metadata as string) || "{}"),
    created_at: existing.created_at as string,
  };
  const { messages: redacted, totalRedactions } = redactMessages([candidate]);
  if (totalRedactions > 0) {
    console.log(
      `[redact] Scrubbed ${totalRedactions} sensitive pattern(s) from edit of ${messageId}`
    );
  }
  const updated = redacted[0];

  // Plan the re-index BEFORE writing anything (engram#445): an edit
  // re-embeds the chunk window it sits in, and the indexing budget is
  // checked against that exact count. A refusal leaves the message, its
  // history and the index untouched — the caller gets a 429 instead of an
  // edit that is stored but silently unsearchable.
  const plan = await planReindex(env, conversationId, organizationId, existing.sequence, {
    id: messageId,
    content: updated.content,
  });
  const indexCheck = await meterReindex(env, organizationId, viewer, plan);
  if (!indexCheck.allowed) throw new IndexingQuotaError(indexCheck);

  // Preserve the body we are about to destroy.
  //
  // storeContent writes to the SAME R2 key, so without this the previous
  // wording is gone from both stores with no way back. Engram's whole claim
  // is that it keeps what was actually said rather than a later
  // interpretation of it — an edit used to erase exactly that. See migration
  // 0041. History is kept in full: nothing here prunes.
  //
  // Done BEFORE the overwrite and allowed to throw: losing history silently
  // is the bug being fixed, so a failure must abort the edit rather than
  // proceed and destroy it.
  const previousText = await loadContent(env, {
    id: messageId,
    content: (existing.content as string) ?? "",
    content_encoding: (existing.content_encoding as string | null) ?? null,
  });
  const revisionId = generateId("rev");
  const revisionNo = await nextRevisionNumber(env.DB, messageId);
  const archived = await storeContent(env, revisionId, previousText);
  await insertMessageRevision(env.DB, {
    id: revisionId,
    messageId,
    conversationId,
    organizationId,
    revision: revisionNo,
    content: archived.content,
    contentEncoding: archived.encoding,
  });

  // Overwrite the R2 object for this message (same key) — falls back to inline.
  const stored = await storeContent(env, messageId, updated.content);
  await updateMessageContent(
    env.DB,
    messageId,
    organizationId,
    stored.content,
    stored.encoding
  );

  // Rebuild the affected slice of the search index — planned above, before
  // the write, so the budget could refuse first.
  try {
    await applyReindex(env, conversationId, organizationId, plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[index] Failed to reindex after edit of ${messageId}: ${msg}`
    );
  }

  return updated;
}

/**
 * A search-index rebuild for the chunk window that spans one sequence: the
 * chunks currently covering it (stale once a message in it changed or went
 * away) and what the window's CURRENT message rows re-chunk to. Chunk
 * boundaries are per-append-batch, so re-chunking only the spanned window
 * can't shift neighbouring chunks. Shared by message edit and delete.
 */
interface ReindexPlan {
  old: Array<{ id: string; vectorize_id: string }>;
  chunks: ChunkResult[];
}

/**
 * Work out the plan without touching anything. `override` stands in for a
 * message whose new body is not written yet — the edit path plans before
 * it writes, so the indexing budget (engram#445) can refuse first.
 */
async function planReindex(
  env: Env,
  conversationId: string,
  organizationId: string,
  sequence: number,
  override?: { id: string; content: string }
): Promise<ReindexPlan> {
  const overlapping = await getChunksOverlappingSequence(
    env.DB,
    conversationId,
    organizationId,
    sequence
  );
  const old = overlapping.results ?? [];
  const startSeq = old.length
    ? Math.min(...old.map((c) => c.start_sequence))
    : sequence;
  const endSeq = old.length
    ? Math.max(...old.map((c) => c.end_sequence))
    : sequence;

  const windowResult = await getMessagesBySequenceRange(
    env.DB,
    conversationId,
    organizationId,
    startSeq,
    endSeq
  );
  const windowMessages = (await Promise.all(
    (windowResult.results as Array<Record<string, unknown>>).map(
      async (m) => ({
        ...m,
        content:
          override && m.id === override.id
            ? override.content
            : await loadContent(env, {
                id: m.id as string,
                content: m.content as string,
                content_encoding: m.content_encoding as string | null,
              }),
        metadata: JSON.parse((m.metadata as string) || "{}"),
      })
    )
  )) as Message[];

  return { old, chunks: chunkMessages(windowMessages) };
}

/**
 * Charge a plan's new chunks to the period's indexing budget (engram#445).
 * Unmetered without a viewer (internal callers). The caller decides what a
 * refusal means: the edit path refuses before writing; the delete path
 * proceeds but drops the stale chunks without regenerating.
 */
async function meterReindex(
  env: Env,
  organizationId: string,
  viewer: AuthContext | undefined,
  plan: ReindexPlan
): Promise<TierCheckResult> {
  if (!viewer || plan.chunks.length === 0) return { allowed: true };
  return checkAndTrackIndexing(env.DB, organizationId, viewer.tier, plan.chunks.length);
}

/**
 * Apply a plan: embed the new chunks, drop the stale vectors, swap the stale
 * rows for the new ones, then drop the stale R2 copies and put the new ones.
 * A plan with no chunks is a pure drop.
 *
 * The order keeps every chunk's text somewhere at every step (engram#567).
 * Once the clear has moved a row's text to R2, its object is the only copy,
 * so no object goes before the rows that point at it, and old and new rows
 * change in one transaction. Whatever fails, D1 holds either the old rows,
 * with their objects, or the new rows, with their text in the column:
 *   - the vector delete fails: nothing else has changed;
 *   - the swap fails (twice): the old rows and objects are as they were,
 *     some without their vectors, so the window is found by keyword alone
 *     until it is next reindexed;
 *   - anything after the swap fails: the new rows hold their text inline.
 *     A stale copy that could not be deleted is an orphan, which the sweep
 *     (engram#557) removes, or sits under a reused key, which the put below
 *     or the mover's verify rewrites; a new copy that did not land is
 *     rewritten by the verify.
 * It used to delete the objects first, so a failure between that and the
 * insert left cleared rows pointing at objects that were gone.
 */
async function applyReindex(
  env: Env,
  conversationId: string,
  organizationId: string,
  plan: ReindexPlan
): Promise<void> {
  const { old, chunks } = plan;
  if (old.length === 0 && chunks.length === 0) return;
  const texts = chunks.map((c) => c.text);
  const embeddings = texts.length
    ? await generateEmbeddings(env.AI, texts)
    : [];
  const chunkRecords = chunks.map((chunk, i) => {
    const cid = chunkId(
      conversationId,
      chunk.startSequence,
      chunk.endSequence,
      chunk.index,
    );
    return {
      id: cid,
      chunkText: chunk.text,
      chunkSummary: summarizeChunk(chunk.text),
      startSequence: chunk.startSequence,
      endSequence: chunk.endSequence,
      vectorizeId: cid,
      embedding: embeddings[i],
    };
  });

  // Vectors first, and a failure aborts with nothing else changed. A vector
  // must not outlive its row: a conversation delete finds the vectors to
  // remove through the rows, so one left behind would never be removed.
  if (old.length > 0) {
    await deleteVectorsByIds(env, old.map((c) => c.vectorize_id));
  }

  // Retried once, whatever the error. D1 can report a failure for a request
  // that committed (which is why withD1Retry retries only rejections that
  // never ran), but the swap is idempotent: a second run leaves the same rows.
  const swap = () =>
    replaceChunks(
      env.DB,
      conversationId,
      organizationId,
      old.map((c) => c.id),
      chunkRecords,
    );
  let swapped: { owned: boolean };
  try {
    swapped = await swap();
  } catch (err) {
    console.warn(
      `[reindex] chunk swap for ${conversationId} failed, retrying: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    swapped = await swap();
  }
  if (!swapped.owned) {
    // Deleted, or moved to another organization by a merge, since the plan
    // was made. The swap wrote nothing. The objects are keyed by
    // conversation, not organization, so they still belong to whoever has
    // the rows now; deleting them, or upserting vectors labelled with this
    // organization, would be wrong either way.
    console.warn(
      `[reindex] ${conversationId} no longer belongs to ${organizationId}; left its chunks as they are`
    );
    return;
  }

  if (old.length > 0) {
    // The stale copies, now that no row points at them. An edit is often a
    // redaction, so the old wording should not stay in the bucket: retried
    // once, then logged for the orphan sweep (engram#557). Every old key goes,
    // reused ones too: the put below writes those again, and if it fails the
    // row still holds its text, where a stale copy would be the wrong one.
    const oldKeys = old.map((c) => chunkObjectKey(conversationId, c.id));
    try {
      await deleteChunkObjects(env, oldKeys);
    } catch {
      try {
        await deleteChunkObjects(env, oldKeys);
      } catch (err) {
        console.error(
          `[reindex] ${oldKeys.length} stale chunk copies of ${conversationId} not deleted; the orphan sweep removes them: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  if (chunkRecords.length > 0) {
    const copied = copyChunkTextsToR2(
      env,
      conversationId,
      chunkRecords.map((c) => ({ id: c.id, text: c.chunkText })),
    );
    try {
      await env.VECTORIZE.upsert(
        chunkRecords.map((c) => ({
          id: c.vectorizeId,
          values: c.embedding,
          metadata: {
            organization_id: organizationId,
            conversation_id: conversationId,
            start_sequence: c.startSequence,
            end_sequence: c.endSequence,
          },
        }))
      );
    } finally {
      await copied;
    }
  }
}

/**
 * Permanently delete a single message: its R2 body, its D1 row (with an
 * atomic message_count decrement), and its slice of the search index — the
 * chunk window it participated in is regenerated from the remaining messages,
 * so recall can no longer surface the deleted content.
 *
 * Returns false if the conversation/message doesn't exist (or the viewer
 * can't access a private conversation) — indistinguishable from absent,
 * like the other delete paths.
 */
export async function deleteMessage(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageId: string,
  viewer?: AuthContext
): Promise<boolean> {
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) return false;
  if (
    viewer &&
    !canAccessConversation(
      viewer,
      conv as { visibility?: string | null; seat_id?: string | null }
    )
  ) {
    return false;
  }

  const existing = (await getMessageById(env.DB, messageId, organizationId)) as
    | (Record<string, unknown> & { conversation_id: string; sequence: number })
    | null;
  if (!existing || existing.conversation_id !== conversationId) return false;

  // R2 before D1, same as conversation delete: the row is the only pointer
  // to the object — delete the row first and the body is orphaned forever.
  // deleteContent is idempotent for inline/missing objects.
  //
  // Edit history goes with it. The revision ROWS cascade from messages, but
  // D1 does not cascade R2, so a superseded body would otherwise stay in the
  // bucket after the user deleted the message it belonged to.
  const revIds = await getR2RevisionIdsByMessage(env.DB, messageId);
  await deleteContent(env, [messageId, ...(revIds.results ?? []).map((r) => r.id)]);

  // From here until the row is gone the row points at nothing — exactly the
  // dangling `r2:*` pointer engram#541 diagnosed (placeholder served, no
  // error, no trace). A D1 hiccup here is rare, so retry once; if it still
  // fails, name the row so the content-integrity scan or a human can finish
  // the job, then surface the error so the caller knows to retry.
  try {
    await deleteMessageWithCount(env.DB, messageId, conversationId, organizationId);
  } catch {
    try {
      await deleteMessageWithCount(env.DB, messageId, conversationId, organizationId);
      console.warn(`[delete] row delete for ${messageId} succeeded on retry`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[delete] R2 body purged but row delete failed twice for ${messageId} in ${conversationId} — row now points at a missing object (engram#541): ${msg}`
      );
      throw err;
    }
  }

  // Reindex is best-effort like edit — but a failure here means the deleted
  // text may still be recalled from a stale chunk, so log it loudly.
  try {
    let plan = await planReindex(env, conversationId, organizationId, existing.sequence);
    const indexCheck = await meterReindex(env, organizationId, viewer, plan);
    if (!indexCheck.allowed) {
      // Deletes are never refused. Past the budget the stale chunks still
      // go — the deleted text must not stay recallable — but the window is
      // not re-embedded.
      console.warn(
        `[index] Indexing budget exhausted for ${organizationId}; dropping stale chunks after delete of ${messageId} without regenerating`
      );
      plan = { old: plan.old, chunks: [] };
    }
    await applyReindex(env, conversationId, organizationId, plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[index] Failed to reindex after delete of ${messageId} — stale chunks may remain until the next reindex: ${msg}`
    );
  }

  // Deleting frees storage (engram#275), one message's worth.
  await releaseStorage(env.DB, organizationId, 1);

  return true;
}

export async function deleteConversation(
  env: Env,
  organizationId: string,
  conversationId: string,
  viewer?: AuthContext
): Promise<boolean> {
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) return false;
  // Private-space enforcement (engram#264): only the owning seat can
  // delete a private conversation; report it as absent to others.
  if (viewer && !canAccessConversation(viewer, conv as { visibility?: string | null; seat_id?: string | null })) {
    return false;
  }

  // Get vectorize IDs to delete from Vectorize
  const chunksResult = await getVectorizeIdsByConversation(
    env.DB,
    conversationId,
    organizationId
  );
  const vectorizeIds = chunksResult.results.map((r) => r.vectorize_id);

  // Order matters, in both directions.
  //
  // R2 must go before D1: the message ids ARE the R2 keys, so once the rows
  // are deleted the objects can never be found again — they would sit in the
  // bucket forever, after we told the user the conversation was deleted.
  //
  // R2 must also go before Vectorize: deleteContent throws on failure so the
  // caller can abort, and aborting is only clean while nothing else has been
  // destroyed. Purging vectors first would leave a conversation that still
  // exists but has silently stopped being searchable.
  //
  // Chunk text copies (engram#384) go first of all. They live under
  // `<conversation_id>/`, so a prefix sweep finds every one without reading
  // the chunk rows, and it throws. Ahead of the bodies, a failed sweep
  // leaves the conversation whole and readable for the retry; behind them,
  // it would strand a conversation whose messages are already gone.
  await deleteConversationChunkObjects(env, conversationId);
  const r2Ids = await getR2MessageIdsByConversation(
    env.DB,
    conversationId,
    organizationId
  );
  // Superseded bodies live under their own R2 keys and are not reachable from
  // the message ids, so they have to be collected explicitly.
  const revR2 = await getR2RevisionIdsByConversation(
    env.DB,
    conversationId,
    organizationId
  );
  const purged = await deleteContent(env, [
    ...r2Ids.results.map((r) => r.id),
    ...(revR2.results ?? []).map((r) => r.id),
  ]);

  // Delete from Vectorize (chunked to the 100-id limit — a large conversation
  // has >100 chunks and would otherwise throw code 40007).
  //
  // Best-effort by design (engram#542). This runs AFTER the R2 purge, so a
  // throw here used to produce the worst of both worlds: bodies gone, the
  // conversation still listed with every message a placeholder, and the
  // retry failing the same way — a half-deleted conversation the user could
  // neither read nor remove. Vectors are an index, not the record: search
  // resolves hits through the chunk rows, which the D1 delete below removes,
  // so an orphaned vector is unreachable and costs us, not the user. Retry
  // once, then log loudly and finish the delete.
  if (vectorizeIds.length > 0) {
    try {
      await deleteVectorsByIds(env, vectorizeIds);
    } catch {
      try {
        await deleteVectorsByIds(env, vectorizeIds);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[delete] Vectorize delete failed twice for conversation ${conversationId}; continuing with the D1 delete (${vectorizeIds.length} vector id(s) orphaned): ${msg}`
        );
      }
    }
  }

  // Delete from D1 (cascading: chunks, messages, conversation)
  await deleteConversationById(env.DB, conversationId, organizationId);

  // Sweep the chunk prefix once more. An append racing this delete can put
  // a chunk copy after the first sweep; with the rows now gone nothing else
  // would ever remove it. Best-effort: the delete itself has succeeded.
  try {
    await deleteConversationChunkObjects(env, conversationId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[delete] second chunk-copy sweep failed for conversation ${conversationId}: ${msg}`
    );
  }

  if (purged > 0) {
    console.log(`[delete] purged ${purged} R2 object(s) for conversation ${conversationId}`);
  }

  // Deleting frees storage (engram#275) — memory never expires on its
  // own, but the user can always make room.
  const freed = (conv as { message_count?: number }).message_count ?? 0;
  await releaseStorage(env.DB, organizationId, freed);

  return true;
}
