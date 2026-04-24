import {
  generateId,
  chunkMessages,
  type MessageInput,
  type Message,
  type Conversation,
} from "@getengram/shared";
import {
  insertConversation,
  getConversationById,
  listConversations as dbListConversations,
  updateConversationMessageCount,
  deleteConversationById,
  insertMessages,
  getMessagesByConversation,
  getMaxSequence,
  insertChunks,
  getVectorizeIdsByConversation,
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

export async function appendMessages(
  env: Env,
  organizationId: string,
  conversationId: string,
  messageInputs: MessageInput[]
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

  // Compress message content for storage
  const compressed = await Promise.all(
    messages.map((m) => compressContent(m.content))
  );

  // Insert messages with compressed content
  await insertMessages(
    env.DB,
    messages.map((m, i) => ({
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

  // Update conversation message count
  await updateConversationMessageCount(env.DB, conversationId, messages.length);

  // Chunk the new messages for embedding
  const chunks = chunkMessages(messages);

  if (chunks.length > 0) {
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
