import {
  generateId,
  chunkMessages,
  summarizeChunk,
  redactMessages,
  type MessageInput,
  type Message,
  type Conversation,
} from "@getengram/shared";
import {
  insertConversation,
  getConversationById,
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
} from "@getengram/db";
import { generateEmbeddings } from "./embedding.js";
import { compressContent, decompressContent } from "../utils/compress.js";
import type { Env } from "../types.js";

export async function createConversation(
  db: D1Database,
  organizationId: string,
  title?: string,
  agentId?: string,
  tags?: string[],
  metadata?: Record<string, unknown>
): Promise<string> {
  const id = generateId("conv");
  await insertConversation(
    db,
    id,
    organizationId,
    title ?? null,
    agentId ?? null,
    tags ?? [],
    metadata ?? {}
  );
  return id;
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

  // Compress message content for storage
  const compressed = await Promise.all(
    redacted.map((m) => compressContent(m.content))
  );

  // Insert messages with compressed content
  await insertMessages(
    env.DB,
    redacted.map((m, i) => ({
      id: m.id,
      conversationId: m.conversation_id,
      organizationId: m.organization_id,
      role: m.role,
      content: compressed[i].content,
      contentEncoding: compressed[i].encoding,
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
        const vectorizeId = generateId("chk");
        return {
          id: generateId("chk"),
          conversationId,
          organizationId,
          chunkText: chunk.text,
          chunkSummary: summarizeChunk(chunk.text),
          startSequence: chunk.startSequence,
          endSequence: chunk.endSequence,
          vectorizeId,
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
  db: D1Database,
  organizationId: string,
  conversationId: string,
  messageLimit: number,
  messageOffset: number
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const conv = await getConversationById(db, conversationId, organizationId);
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
    db,
    conversationId,
    organizationId,
    messageLimit,
    messageOffset
  );

  // Decompress message content in parallel
  const rawMessages = msgsResult.results as Array<Record<string, unknown>>;
  const messages = await Promise.all(
    rawMessages.map(async (m) => ({
      ...m,
      content: await decompressContent(
        m.content as string,
        m.content_encoding as string | null
      ),
      metadata: JSON.parse((m.metadata as string) || "{}"),
    }))
  ) as Message[];

  return { conversation, messages };
}

export async function deleteConversation(
  env: Env,
  organizationId: string,
  conversationId: string
): Promise<boolean> {
  const conv = await getConversationById(env.DB, conversationId, organizationId);
  if (!conv) return false;

  // Get vectorize IDs to delete from Vectorize
  const chunksResult = await getVectorizeIdsByConversation(
    env.DB,
    conversationId,
    organizationId
  );
  const vectorizeIds = chunksResult.results.map((r) => r.vectorize_id);

  // Delete from Vectorize
  if (vectorizeIds.length > 0) {
    await env.VECTORIZE.deleteByIds(vectorizeIds);
  }

  // Delete from D1 (cascading: chunks, messages, conversation)
  await deleteConversationById(env.DB, conversationId, organizationId);

  return true;
}
