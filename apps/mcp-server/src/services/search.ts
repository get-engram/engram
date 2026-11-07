import type { Env } from "../types.js";
import type { SearchResult } from "@getengram/shared";
import { generateEmbedding } from "./embedding.js";
import { getChunksByVectorizeIds, getChunksByIds, searchChunksFts, type ChunkKeywordHit } from "@getengram/db";
import { isTextInR2Only, loadChunkTexts } from "./chunk-store.js";

interface VectorizeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_SNIPPET_CHARS = 2000;
const MAX_SNIPPET_CHARS = 5000;
const DEFAULT_MIN_SCORE = 0.3;
const TRUNCATION_MARKER = "\n...[truncated]";

/** True for Engram-seeded system conversations (the welcome note) — identified
 *  by metadata {"system":true}. These are not the user's memory and are
 *  excluded from search results. Exported for testing. */
export function isSystemConversation(metadata: string | null | undefined): boolean {
  if (!metadata) return false;
  try {
    return (JSON.parse(metadata) as { system?: boolean }).system === true;
  } catch {
    return false;
  }
}

// RRF constant — dampens high-rank dominance. k=60 is standard.
const RRF_K = 60;
// Max possible RRF score with 2 lists: 2 / (k + 0)
const RRF_MAX = 2 / RRF_K;

// Recall tuning (engram#215).
// Recency: "remember when we were doing X" almost always means recently, so
// boost recent conversations. Multiplier decays from (1 + weight) at age 0 to
// 1.0 for old conversations, half-life 30 days — a tie-breaker, not an override.
const RECENCY_WEIGHT = 0.5;
const RECENCY_HALFLIFE_DAYS = 30;
// Title/proper-noun match: names ("Antonia") get diluted in embedding space,
// so boost results whose conversation title contains a query term.
const TITLE_BOOST = 1.4;

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** Recency multiplier in [1, 1+RECENCY_WEIGHT]; 1.0 when the timestamp is missing/invalid. */
export function recencyMultiplier(updatedAt?: string | null): number {
  if (!updatedAt) return 1;
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 1;
  const ageDays = (Date.now() - t) / 86_400_000;
  if (ageDays <= 0) return 1 + RECENCY_WEIGHT;
  return 1 + RECENCY_WEIGHT * Math.pow(0.5, ageDays / RECENCY_HALFLIFE_DAYS);
}

/** Distinct lowercased query terms of length >= 3 for title matching. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

/** Why a keyword search failed, in words that are safe to log. */
export type KeywordFailureClass = "syntax" | "overloaded" | "timeout" | "network" | "d1" | "other";

// Status codes D1 and SQLite put in error messages. Only these exact strings
// are ever logged: anything else in a message may be the user's query.
const LOGGABLE_ERROR_CODES = new Set([
  "D1_ERROR", "D1_EXEC_ERROR", "D1_TYPE_ERROR", "D1_COLUMN_NOTFOUND", "D1_DUMP_ERROR", "D1_RESET_DO",
  "SQLITE_ERROR", "SQLITE_INTERNAL", "SQLITE_PERM", "SQLITE_ABORT", "SQLITE_BUSY", "SQLITE_LOCKED",
  "SQLITE_NOMEM", "SQLITE_READONLY", "SQLITE_INTERRUPT", "SQLITE_IOERR", "SQLITE_CORRUPT", "SQLITE_NOTFOUND",
  "SQLITE_FULL", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "SQLITE_EMPTY", "SQLITE_SCHEMA", "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT", "SQLITE_MISMATCH", "SQLITE_MISUSE", "SQLITE_NOLFS", "SQLITE_AUTH", "SQLITE_FORMAT",
  "SQLITE_RANGE", "SQLITE_NOTADB", "SQLITE_NOTICE", "SQLITE_WARNING",
]);

/**
 * Classify a keyword-search failure for the log (engram#564).
 *
 * A failed keyword search degrades to semantic-only and the caller never
 * sees it, so the log line is the only record that it happened. It carries a
 * class and the D1/SQLite status codes, never the message: FTS5 quotes the
 * offending query text in its errors ("syntax error near ..."), and query text
 * is user content. Exported for tests.
 */
export function classifyKeywordFailure(err: unknown): { class: KeywordFailureClass; codes?: string[] } {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e != null && depth < 3; depth++) {
    if (e instanceof Error) {
      parts.push(e.message);
      e = (e as { cause?: unknown }).cause;
    } else {
      if (typeof e === "string") parts.push(e);
      break;
    }
  }
  const text = parts.join("\n");
  const codes = [...new Set(text.match(/\b(?:D1|SQLITE)_[A-Z_]+\b/g) ?? [])].filter((c) =>
    LOGGABLE_ERROR_CODES.has(c),
  );
  let cls: KeywordFailureClass;
  if (/fts5|syntax error|unterminated string|no such column|malformed match|parse error/i.test(text)) cls = "syntax";
  else if (/overloaded|queued for too long|too many requests/i.test(text)) cls = "overloaded";
  else if (/timed? ?out|timeout|deadline/i.test(text)) cls = "timeout";
  else if (/network connection lost|connection reset|socket hang up|econnreset|fetch failed/i.test(text)) cls = "network";
  else if (codes.length > 0 || /\bD1\b/.test(text)) cls = "d1";
  else cls = "other";
  return codes.length > 0 ? { class: cls, codes } : { class: cls };
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
  dedupe: boolean = true,
  project?: string,
  viewerSeatId?: string | null
): Promise<SearchResult[]> {
  const cappedSnippet = Math.min(
    Math.max(snippetChars, 0),
    MAX_SNIPPET_CHARS
  );

  // Over-fetch for post-processing headroom. When a project filter is active,
  // many results will be discarded so we fetch more aggressively.
  const fetchK = Math.min(project ? limit * 6 : limit * 3, 50);

  const filter: VectorizeVectorMetadataFilter = { organization_id: organizationId };
  if (conversationId) {
    filter.conversation_id = conversationId;
  }

  // Run embedding generation and FTS5 keyword search in parallel.
  // Both degrade gracefully — if the AI model or Vectorize is down,
  // search falls back to whichever source is available.
  const [embeddingResult, ftsResults] = await Promise.all([
    generateEmbedding(env.AI, query)
      .then((emb) => ({ ok: true as const, embedding: emb }))
      .catch((err) => {
        console.error(`[search] embedding failed, falling back to FTS-only: ${err instanceof Error ? err.message : err}`);
        return { ok: false as const, embedding: null };
      }),
    searchChunksFts(env.DB, query, organizationId, fetchK, conversationId)
      .then((r) => {
        // A declined search is not a failure, but counting them is how the
        // cap gets tuned (engram#564). Never log the query: it is user content.
        if (r.skipped) console.log(`[search] keyword search skipped ${JSON.stringify({ reason: r.skipped })}`);
        return r;
      })
      .catch((err: unknown) => {
        console.error(`[search] keyword search failed ${JSON.stringify(classifyKeywordFailure(err))}`);
        return { results: [] as ChunkKeywordHit[] };
      }),
  ]);

  let vectorMatches: VectorizeMatch[] = [];
  if (embeddingResult.ok) {
    try {
      const vectorResults = await env.VECTORIZE.query(embeddingResult.embedding, {
        topK: fetchK,
        filter,
        returnMetadata: "all",
      });
      vectorMatches = (vectorResults.matches ?? []) as VectorizeMatch[];
    } catch (err) {
      console.error(`[search] vectorize query failed, using FTS-only: ${err instanceof Error ? err.message : err}`);
    }
  }

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
      ? getChunksByVectorizeIds(env.DB, vectorizeIds, organizationId)
      : { results: [] },
    ftsChunkIds.length > 0
      ? getChunksByIds(env.DB, ftsChunkIds, organizationId)
      : { results: [] },
  ]);

  type ChunkRow = {
    id: string;
    conversation_id: string;
    organization_id: string;
    chunk_text: string;
    /** 'r2:raw' once the text lives only in R2 (engram#384); chunk_text is '' then. */
    chunk_encoding?: string | null;
    chunk_summary: string | null;
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
  const convMeta = new Map<
    string,
    { title: string; tags: string[]; updatedAt: string | null }
  >();
  // Conversations the caller may NOT see (engram#264). Kept as an explicit
  // set for the log line and the test, even though a blocked conversation
  // also has no entry in convMeta and would be dropped by that rule alone.
  const blockedConvIds = new Set<string>();

  if (uniqueConvIds.length > 0) {
    const placeholders = uniqueConvIds.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, title, tags, updated_at, visibility, seat_id, metadata FROM conversations WHERE id IN (${placeholders}) AND organization_id = ?`
    )
      .bind(...uniqueConvIds, organizationId)
      .all<{ id: string; title: string; tags: string; updated_at: string | null; visibility?: string | null; seat_id?: string | null; metadata?: string | null }>();

    for (const row of rows.results) {
      // Private-space enforcement (engram#264): a chunk whose
      // conversation is private to a different seat is invisible to
      // this caller.
      if (
        (row.visibility ?? "shared") === "private" &&
        (row.seat_id ?? null) !== (viewerSeatId ?? null)
      ) {
        blockedConvIds.add(row.id);
        continue;
      }
      // The seeded welcome note (metadata {"system":true,...}) is instructional
      // boilerplate, not the user's memory. Returning it as a search hit means a
      // brand-new user's first "what do you remember?" surfaces our own onboarding
      // prose as if they'd written it — which reads as broken and buries the
      // activation moment. Exclude system conversations from ranked results; a
      // user with no real memories now gets a clean empty result (which triggers
      // searchEmptyTip) instead. (engram activation, 2026-09)
      if (isSystemConversation(row.metadata)) {
        blockedConvIds.add(row.id);
        continue;
      }
      convMeta.set(row.id, {
        title: row.title,
        tags: row.tags ? JSON.parse(row.tags) : [],
        updatedAt: row.updated_at ?? null,
      });
    }
  }

  // Build results with normalized RRF scores, then apply recall boosts:
  // recency (recent conversations) and title match (proper nouns). (engram#215)
  const terms = queryTerms(query);
  let results: SearchResult[] = [];
  for (const [chunkId, rawScore] of rrfScores) {
    const chunk = chunkMap.get(chunkId);
    if (!chunk) continue;
    if (blockedConvIds.has(chunk.conversation_id)) continue; // private to another seat (engram#264)
    const meta = convMeta.get(chunk.conversation_id);
    // No conversation resolved inside this org means the chunk is an orphan
    // of a deleted conversation, or something hydration should never have
    // returned. Either way its text is not a result (engram#452). Until now
    // such chunks passed through with no title — which is also how a
    // cross-tenant row would have surfaced, had one ever reached chunkMap.
    if (!meta) continue;
    const titleHit =
      !!meta.title &&
      terms.some((t) => meta.title.toLowerCase().includes(t));
    const boosted =
      (rawScore / RRF_MAX) *
      recencyMultiplier(meta.updatedAt) *
      (titleHit ? TITLE_BOOST : 1);
    results.push({
      chunk_id: chunk.id,
      conversation_id: chunk.conversation_id,
      conversation_title: meta.title,
      tags: meta.tags,
      chunk_text: truncateSnippet(chunk.chunk_text, cappedSnippet),
      chunk_summary: chunk.chunk_summary ?? undefined,
      score: boosted,
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

  // Filter by project — matches conversation titles that start with the
  // project name (case-insensitive). This eliminates cross-project noise
  // when the caller knows which project they care about.
  if (project) {
    const prefix = project.toLowerCase();
    results = results.filter((r) => {
      if (!r.conversation_title) return false;
      return r.conversation_title.toLowerCase().startsWith(prefix);
    });
  }

  // Deduplicate: keep only the highest-scoring chunk per conversation — this
  // gives cross-conversation searches diversity (one hit per conversation).
  // But when the search is SCOPED to a single conversation, dedupe-by-
  // conversation can only ever return one chunk, starving the caller (an AI
  // drilling into one memory) of the rest of the relevant thread. Skip it when
  // a conversation_id filter is active so scoped search returns the top-k.
  if (dedupe && !conversationId) {
    const seen = new Set<string>();
    results = results.filter((r) => {
      if (seen.has(r.conversation_id)) return false;
      seen.add(r.conversation_id);
      return true;
    });
  }

  const page = results.slice(0, limit);

  // A row whose text lives only in R2 (engram#384) carries '' in
  // chunk_text, so its snippet above is empty. Fetch the text for the rows
  // actually returned — never for the whole candidate set. A copy that
  // cannot be read degrades to the summary rather than failing the search.
  const inR2 = page
    .map((r) => chunkMap.get(r.chunk_id))
    .filter((row): row is ChunkRow => !!row && isTextInR2Only(row));
  if (inR2.length > 0) {
    const texts = await loadChunkTexts(env, inR2);
    for (const r of page) {
      const row = chunkMap.get(r.chunk_id);
      if (!row || !isTextInR2Only(row)) continue;
      const text = texts.get(row.id);
      r.chunk_text =
        text !== undefined ? truncateSnippet(text, cappedSnippet) : (row.chunk_summary ?? "");
    }
  }

  return page;
}
