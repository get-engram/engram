import type { Env } from "../types.js";
import type { SearchResult } from "@getengram/shared";
import { generateEmbedding } from "./embedding.js";
import { getChunksByVectorizeIds, getChunksByIds, searchChunksFts } from "@getengram/db";

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_SNIPPET_CHARS = 2000;
const MAX_SNIPPET_CHARS = 5000;
const DEFAULT_MIN_SCORE = 0.3;
const TRUNCATION_MARKER = "\n...[truncated]";

// RRF constant — dampens high-rank dominance. k=60 is standard.
const RRF_K = 60;
// Max possible RRF score with 2 lists: 2 / (k + 0)
const RRF_MAX = 2 / RRF_K;

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

  // Over-fetch for post-processing headroom
  const fetchK = Math.min(limit * 3, 50);

  const filter: VectorizeVectorMetadataFilter = { organization_id: organizationId };
  if (conversationId) {
    filter.conversation_id = conversationId;
  }

  // Run embedding generation and FTS5 keyword search in parallel.
  // FTS errors (malformed queries) degrade gracefully to vector-only.
  const [queryEmbedding, ftsResults] = await Promise.all([
    generateEmbedding(env.AI, query),
    searchChunksFts(env.DB, query, organizationId, fetchK, conversationId)
      .catch(() => ({ results: [] as { chunk_id: string; rank: number }[] })),
  ]);

  const vectorResults = await env.VECTORIZE.query(queryEmbedding, {
    topK: fetchK,
    filter,
    returnMetadata: "all",
  });

  const vectorMatches = (vectorResults.matches ?? []) as VectorizeMatch[];
  const ftsMatches = ftsResults.results ?? [];

  if (vectorMatches.length === 0 && ftsMatches.length === 0) {
    return [];
  }

  // Build rank maps (0-indexed position)
  const vectorRank = new Map<string, number>();
  vectorMatches.forEach((m, i) => vectorRank.set(m.id, i));

  const ftsRank = new Map<string, number>();
  ftsMatches.forEach((m, i) => ftsRank.set(m.chunk_id, i));

  // Fetch chunk rows for both result sets
  const vectorizeIds = vectorMatches.map((m) => m.id);
  const ftsChunkIds = ftsMatches.map((m) => m.chunk_id);

  const [vectorChunksResult, ftsChunksResult] = await Promise.all([
    vectorizeIds.length > 0
      ? getChunksByVectorizeIds(env.DB, vectorizeIds)
      : { results: [] },
    ftsChunkIds.length > 0
      ? getChunksByIds(env.DB, ftsChunkIds)
      : { results: [] },
  ]);

  type ChunkRow = {
    id: string;
    conversation_id: string;
    organization_id: string;
    chunk_text: string;
    start_sequence: number;
    end_sequence: number;
    vectorize_id: string;
  };

  // Merge all chunks into a single map keyed by chunk_id
  const chunkMap = new Map<string, ChunkRow>();
  for (const row of vectorChunksResult.results as ChunkRow[]) {
    chunkMap.set(row.id, row);
  }
  for (const row of ftsChunksResult.results as ChunkRow[]) {
    if (!chunkMap.has(row.id)) {
      chunkMap.set(row.id, row);
    }
  }

  // Build vectorize_id → chunk_id mapping for RRF scoring
  const vecIdToChunkId = new Map<string, string>();
  for (const chunk of chunkMap.values()) {
    vecIdToChunkId.set(chunk.vectorize_id, chunk.id);
  }

  // Compute RRF scores for each unique chunk
  const rrfScores = new Map<string, number>();

  for (const [vecId, rank] of vectorRank) {
    const chunkId = vecIdToChunkId.get(vecId);
    if (!chunkId) continue;
    const score = rrfScores.get(chunkId) ?? 0;
    rrfScores.set(chunkId, score + 1 / (RRF_K + rank));
  }

  for (const [chunkId, rank] of ftsRank) {
    const score = rrfScores.get(chunkId) ?? 0;
    rrfScores.set(chunkId, score + 1 / (RRF_K + rank));
  }

  // Hydrate conversation title + tags
  const uniqueConvIds = [...new Set([...chunkMap.values()].map((c) => c.conversation_id))];
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

  // Build results with normalized RRF scores [0, 1]
  let results: SearchResult[] = [];
  for (const [chunkId, rawScore] of rrfScores) {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) continue;
    const meta = convMeta.get(chunk.conversation_id);
    results.push({
      chunk_id: chunk.id,
      conversation_id: chunk.conversation_id,
      conversation_title: meta?.title,
      tags: meta?.tags,
      chunk_text: truncateSnippet(chunk.chunk_text, cappedSnippet),
      score: rawScore / RRF_MAX, // normalize to [0, 1]
      start_sequence: chunk.start_sequence,
      end_sequence: chunk.end_sequence,
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  // Drop results below the minimum relevance threshold
  if (minScore > 0) {
    results = results.filter((r) => r.score >= minScore);
  }

  // Filter by tags
  if (tags && tags.length > 0) {
    results = results.filter((r) => {
      if (!r.tags) return false;
      return tags.every((t) => r.tags!.includes(t));
    });
  }

  // Deduplicate: keep only the highest-scoring chunk per conversation
  if (dedupe) {
    const seen = new Set<string>();
    results = results.filter((r) => {
      if (seen.has(r.conversation_id)) return false;
      seen.add(r.conversation_id);
      return true;
    });
  }

  return results.slice(0, limit);
}
