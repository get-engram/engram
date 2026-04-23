import type { Env } from "../types.js";
import type { SearchResult } from "@getengram/shared";
import { generateEmbedding } from "./embedding.js";
import { getChunksByVectorizeIds } from "@getengram/db";

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

// Default cap per chunk_text in the search response. Full message bodies
// can run 1–5k tokens each when tool-call output is included; clipping to
// ~800 chars keeps a 5-result search response under ~1.5k tokens total
// without destroying the ranking signal. Callers that need the full
// window should call get_conversation with start_sequence / end_sequence.
export const DEFAULT_SNIPPET_CHARS = 800;
export const MAX_SNIPPET_CHARS = 5000;
export const DEFAULT_MIN_SCORE = 0.5;
const TRUNCATION_MARKER = "\n...[truncated]";

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

export async function searchConversations(
  env: Env,
  organizationId: string,
  query: string,
  limit: number,
  conversationId?: string,
  tags?: string[],
  snippetChars: number = DEFAULT_SNIPPET_CHARS,
  minScore: number = DEFAULT_MIN_SCORE,
  dedupe: boolean = true
): Promise<SearchResult[]> {
  const cappedSnippet = Math.min(
    Math.max(snippetChars, 0),
    MAX_SNIPPET_CHARS
  );

  const queryEmbedding = await generateEmbedding(env.AI, query);

  const filter: VectorizeVectorMetadataFilter = { organization_id: organizationId };
  if (conversationId) {
    filter.conversation_id = conversationId;
  }

  // Over-fetch from Vectorize when dedupe is on. Overlapping chunks mean
  // multiple results per conversation, so we need headroom to still return
  // `limit` unique conversations after dedup. Also over-fetch when tags
  // are specified since tag filtering is post-query.
  const needsOverfetch = dedupe || (tags && tags.length > 0);
  const fetchK = needsOverfetch ? Math.min(limit * 3, 50) : limit;

  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: fetchK,
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

  // Hydrate conversation title + tags for each unique conversation in
  // the result set. Single batched query instead of N+1.
  const uniqueConvIds = [...new Set(chunks.map((c) => c.conversation_id))];
  const convMeta = new Map<string, { title: string; tags: string[] }>();

  if (uniqueConvIds.length > 0) {
    const placeholders = uniqueConvIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, title, tags FROM conversations WHERE id IN (${placeholders}) AND organization_id = ?`
    )
      .bind(...uniqueConvIds, organizationId)
      .all<{ id: string; title: string; tags: string }>();

    for (const row of rows.results) {
      convMeta.set(row.id, {
        title: row.title,
        tags: row.tags ? JSON.parse(row.tags) : [],
      });
    }
  }

  // Note: we intentionally do NOT hydrate full Message rows here. chunk_text
  // already contains the same window in a model-friendly `[role]: content`
  // format, and returning both duplicated the payload (see issue #8). If a
  // caller needs the structured messages they can call get_conversation with
  // start_sequence / end_sequence.
  let results: SearchResult[] = chunks.map((chunk) => {
    const meta = convMeta.get(chunk.conversation_id);
    return {
      chunk_id: chunk.id,
      conversation_id: chunk.conversation_id,
      conversation_title: meta?.title,
      tags: meta?.tags,
      chunk_text: truncateSnippet(chunk.chunk_text, cappedSnippet),
      score: scoreMap.get(chunk.vectorize_id) ?? 0,
      start_sequence: chunk.start_sequence,
      end_sequence: chunk.end_sequence,
    };
  });

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Drop results below the minimum relevance threshold
  if (minScore > 0) {
    results = results.filter((r) => r.score >= minScore);
  }

  // Filter by tags — a result matches if its conversation has ALL requested tags
  if (tags && tags.length > 0) {
    results = results.filter((r) => {
      if (!r.tags) return false;
      return tags.every((t) => r.tags!.includes(t));
    });
  }

  // Deduplicate: keep only the highest-scoring chunk per conversation.
  // Overlapping chunks (window=5, stride=3) cause the same content to
  // appear multiple times; dedup prevents wasting the caller's tokens.
  if (dedupe) {
    const seen = new Set<string>();
    results = results.filter((r) => {
      if (seen.has(r.conversation_id)) return false;
      seen.add(r.conversation_id);
      return true;
    });
  }

  // Cap to requested limit after all filtering
  return results.slice(0, limit);
}
