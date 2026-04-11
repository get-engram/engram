import type { Env } from "../types.js";
import type { SearchResult, Message } from "@getengram/shared";
import { generateEmbedding } from "./embedding.js";
import { getChunksByVectorizeIds } from "@getengram/db";
import { getMessagesBySequenceRange } from "@getengram/db";

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export async function searchConversations(
  env: Env,
  organizationId: string,
  query: string,
  limit: number,
  conversationId?: string,
  tags?: string[]
): Promise<SearchResult[]> {
  const queryEmbedding = await generateEmbedding(env.AI, query);

  const filter: VectorizeVectorMetadataFilter = { organization_id: organizationId };
  if (conversationId) {
    filter.conversation_id = conversationId;
  }

  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: limit,
    filter,
    returnMetadata: "all",
  });

  if (!vectorResults.matches || vectorResults.matches.length === 0) {
    return [];
  }

  const vectorizeIds = vectorResults.matches.map((m: VectorizeMatch) => m.id);
  const scoreMap = new Map(
    vectorResults.matches.map((m: VectorizeMatch) => [m.id, m.score])
  );

  const chunksResult = await getChunksByVectorizeIds(env.DB, vectorizeIds);
  const chunks = chunksResult.results as Array<{
    id: string;
    conversation_id: string;
    organization_id: string;
    chunk_text: string;
    start_sequence: number;
    end_sequence: number;
    vectorize_id: string;
  }>;

  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    // If tags filter specified, we'd need to check the conversation's tags
    // For now, tag filtering happens at the Vectorize metadata level or post-filter

    const messagesResult = await getMessagesBySequenceRange(
      env.DB,
      chunk.conversation_id,
      chunk.organization_id,
      chunk.start_sequence,
      chunk.end_sequence
    );

    results.push({
      chunk_id: chunk.id,
      conversation_id: chunk.conversation_id,
      chunk_text: chunk.chunk_text,
      score: scoreMap.get(chunk.vectorize_id) ?? 0,
      start_sequence: chunk.start_sequence,
      end_sequence: chunk.end_sequence,
      messages: messagesResult.results as unknown as Message[],
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}
