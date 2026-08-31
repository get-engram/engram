import {
  generateId,
  chunkMessages,
  chunkId,
  summarizeChunk,
  redactMessages,
  type MessageInput,
  type Message,
  type Conversation,
} from "@getengram/shared";
import {
  insertConversation,
  getConversationById,
  getConversationByFingerprint,
  getDefaultConversationId,
  DEFAULT_CONVERSATION_TAG,
  listConversations as dbListConversations,
  updateConversationMessageCount,
  deleteConversationById,
  insertMessages,
  getMessagesByConversation,
  getMaxSequence,
  insertChunks,
  getVectorizeIdsByConversation,
  insertVaultEntries,
  getMessageById,
  updateMessageContent,
  getMessagesBySequenceRange,
  getChunksOverlappingSequence,
  deleteChunksByIds,
  getR2MessageIdsByConversation,
} from "@getengram/db";
import { generateEmbeddings } from "./embedding.js";
import { releaseStorage } from "./tier.js";
import { storeContent, deleteContent, loadContent } from "./content-store.js";
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

export async function appendMessages(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageInputs: MessageInput[],
  vaultEntries?: VaultEntryInput[]
): Promise<Message[]> {
  // Verify conversation exists and belongs to org
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) {
    throw new Error(`Conversation ${conversationId} not found`);
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

  // Insert message rows (content lives in R2; D1 row carries the pointer)
  await insertMessages(
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
    }))
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

  // Update conversation message count
  await updateConversationMessageCount(env.DB, conversationId, redacted.length);

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

      await env.VECTORIZE.upsert(vectors);
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

  // Same hygiene as append: redact, then compress for storage.
  const candidate: Message = {
    id: existing.id as string,
    conversation_id: conversationId,
    organization_id: organizationId,
    role: existing.role as Message["role"],
    content: newContent,
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
  // Overwrite the R2 object for this message (same key) — falls back to inline.
  const stored = await storeContent(env, messageId, updated.content);
  await updateMessageContent(
    env.DB,
    messageId,
    organizationId,
    stored.content,
    stored.encoding
  );

  // Rebuild the affected slice of the search index. Chunk boundaries are
  // per-append-batch, so re-chunking just the window spanned by the
  // invalidated chunks can't shift neighbours.
  try {
    const overlapping = await getChunksOverlappingSequence(
      env.DB,
      conversationId,
      organizationId,
      existing.sequence
    );
    const old = overlapping.results ?? [];
    const startSeq = old.length
      ? Math.min(...old.map((c) => c.start_sequence))
      : existing.sequence;
    const endSeq = old.length
      ? Math.max(...old.map((c) => c.end_sequence))
      : existing.sequence;

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
          content: await loadContent(env, {
            id: m.id as string,
            content: m.content as string,
            content_encoding: m.content_encoding as string | null,
          }),
          metadata: JSON.parse((m.metadata as string) || "{}"),
        })
      )
    )) as Message[];

    const chunks = chunkMessages(windowMessages);
    const texts = chunks.map((c) => c.text);
    const embeddings = texts.length
      ? await generateEmbeddings(env.AI, texts)
      : [];

    if (old.length > 0) {
      await env.VECTORIZE.deleteByIds(old.map((c) => c.vectorize_id));
      await deleteChunksByIds(
        env.DB,
        old.map((c) => c.id),
        organizationId
      );
    }

    if (chunks.length > 0) {
      const chunkRecords = chunks.map((chunk, i) => {
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
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[index] Failed to reindex after edit of ${messageId}: ${msg}`
    );
  }

  return updated;
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
  const r2Ids = await getR2MessageIdsByConversation(
    env.DB,
    conversationId,
    organizationId
  );
  const purged = await deleteContent(env, r2Ids.results.map((r) => r.id));

  // Delete from Vectorize
  if (vectorizeIds.length > 0) {
    await env.VECTORIZE.deleteByIds(vectorizeIds);
  }

  // Delete from D1 (cascading: chunks, messages, conversation)
  await deleteConversationById(env.DB, conversationId, organizationId);

  if (purged > 0) {
    console.log(`[delete] purged ${purged} R2 object(s) for conversation ${conversationId}`);
  }

  // Deleting frees storage (engram#275) — memory never expires on its
  // own, but the user can always make room.
  const freed = (conv as { message_count?: number }).message_count ?? 0;
  await releaseStorage(env.DB, organizationId, freed);

  return true;
}
