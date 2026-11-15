import type { Env } from "../types.js";
import type { SearchResult } from "@getengram/shared";
import { generateEmbedding } from "./embedding.js";
import { getChunksByVectorizeIds, getChunksByIds, searchChunksFts, type ChunkKeywordHit } from "@getengram/db";
import { isTextInR2Only, loadChunkTexts } from "./chunk-store.js";
import { relevanceCheckEnabled, scoreRelevance, WEAK_MATCH_SCORE } from "./relevance-check.js";

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

// Ranking (engram#215, retuned against the relevance benchmark in engram#758:
// src/__tests__/search-bench, `pnpm bench:search`). Change a number here only
// with the benchmark's before and after in hand.
//
// The two lists are fused into one score per chunk. The best hit of each list
// is worth 1/RRF_K, so a chunk at the top of both scores 1.0 once normalised.
const RRF_K = 60;
const RRF_MAX = 2 / RRF_K;
// The keyword list is fused by rank. The semantic list is fused by how close
// each hit is to the best one: (similarity / best similarity) ^ sharpness.
// Rank alone makes fifteen candidates look almost equally good whether the
// second one is a near-tie or far behind, and then any boost at all reorders
// the page. With similarity kept, a near-tie is a near-tie and a clear winner
// stays one. It also means a semantic-only hit far behind the best one falls
// under the default min_score and is dropped, where it used to pad the page.
const SIMILARITY_SHARPNESS = 2.5;
// Recency: of two conversations that match about equally well, the newer one
// is usually the one meant. At most +8%, halving every 30 days: enough to
// settle a near-tie, never enough to lift a weaker match over a better one.
// It was +50%, which put any recent conversation above the best match in an
// old one.
const RECENCY_WEIGHT = 0.08;
const RECENCY_HALFLIFE_DAYS = 30;
// Title match: names ("Antonia") get diluted in embedding space, so a result
// whose conversation title contains the query's words gets up to +20%, scaled
// by the share of the query's words the title has.
const TITLE_BOOST = 1.2;
// Words that say nothing about which conversation is meant. A title is
// matched on whole words that are not in this list and are not bare numbers.
const TITLE_STOP_WORDS = new Set(
  (
    "the and for from with what when where which who whom why how did does done was were are been being " +
    "our ours about that this these those have has had you your yours into not but can will should would " +
    "could their them they his her hers its out all any one two get got run use via per also just than then " +
    "there here some more most much many over under again last next new old"
  ).split(" "),
);
// D1 allows 100 bound values per statement; a page of 20 can bring 100
// conversations here, plus the organization id.
const CONVERSATION_LOOKUP_BATCH = 90;
// Reads of the text bucket are bounded: the page, then up to two refills for
// rows dropped as repeats.
const PAGE_FILL_ROUNDS = 3;

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

/** Distinct lowercased query terms of length >= 3. */
export function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])];
}

/** The query terms a title is matched on: no stop words, no bare numbers. */
export function titleTerms(query: string): string[] {
  return queryTerms(query).filter((t) => !TITLE_STOP_WORDS.has(t) && !/^[0-9]+$/.test(t));
}

/**
 * Title multiplier in [1, TITLE_BOOST]: 1 plus the boost scaled by the share
 * of `terms` that appear in the title as whole words. Whole words, because a
 * substring match let "port" boost every "Report" and "the" boost nearly
 * every title.
 */
export function titleMultiplier(title: string | null | undefined, terms: string[]): number {
  if (!title || terms.length === 0) return 1;
  const words = new Set(title.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const hits = terms.filter((t) => words.has(t)).length;
  return 1 + (TITLE_BOOST - 1) * (hits / terms.length);
}

/**
 * What a semantic hit adds to its chunk's score: 1/RRF_K for the best
 * visible hit, less for the others in proportion to their similarity. Falls
 * back to rank when the best similarity is not a positive number.
 */
export function semanticContribution(similarity: number, bestSimilarity: number, rank: number): number {
  if (!(bestSimilarity > 0) || !Number.isFinite(similarity)) return 1 / (RRF_K + rank);
  const ratio = Math.min(Math.max(similarity, 0) / bestSimilarity, 1);
  return Math.pow(ratio, SIMILARITY_SHARPNESS) / RRF_K;
}

/**
 * How many candidates to take from each list. Three pages' worth normally;
 * six when a tag or project filter will discard most of them, so the filter
 * has something left to pick from. Capped at 50.
 */
export function candidatePoolSize(limit: number, filtered: boolean): number {
  return Math.min(filtered ? limit * 6 : limit * 3, 50);
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
  minScore?: number,
  dedupe: boolean = true,
  project?: string,
  viewerSeatId?: string | null
): Promise<SearchResult[]> {
  const cappedSnippet = Math.min(
    Math.max(snippetChars, 0),
    MAX_SNIPPET_CHARS
  );

  // Over-fetch for post-processing headroom. Tag and project filters run
  // after ranking and discard most candidates, so they get a wider pool.
  const fetchK = candidatePoolSize(limit, !!project || (tags?.length ?? 0) > 0);

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

  // In batches: both lists at their widest can name 100 conversations, and
  // D1 takes 100 bound values per statement.
  for (let i = 0; i < uniqueConvIds.length; i += CONVERSATION_LOOKUP_BATCH) {
    const batch = uniqueConvIds.slice(i, i + CONVERSATION_LOOKUP_BATCH);
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT id, title, tags, updated_at, visibility, seat_id, metadata FROM conversations WHERE id IN (${placeholders}) AND organization_id = ?`
    )
      .bind(...batch, organizationId)
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

  // A chunk is a candidate only if its conversation resolved inside this org
  // and the caller may see it. Blocked: private to another seat (engram#264)
  // or a system conversation. No conversation at all: an orphan of a deleted
  // conversation, or something hydration should never have returned; either
  // way its text is not a result (engram#452), which is also how a
  // cross-tenant row would be stopped, had one ever reached chunkMap.
  const visible = (chunk: ChunkRow | undefined): chunk is ChunkRow =>
    !!chunk && !blockedConvIds.has(chunk.conversation_id) && convMeta.has(chunk.conversation_id);

  // Fuse the two lists into one score per chunk. Semantic hits are measured
  // against the best hit the caller can see, never against a hidden one, so
  // a score says nothing about what else is in the index.
  const fused = new Map<string, number>();
  const semanticHits: { chunkId: string; similarity: number; rank: number }[] = [];
  for (const [vecId, rank] of vectorRank) {
    const chunkId = vecIdToChunkId.get(vecId);
    if (!chunkId || !visible(chunkMap.get(chunkId))) continue;
    semanticHits.push({ chunkId, similarity: vectorMatches[rank].score, rank });
  }
  const bestSimilarity = semanticHits.reduce((best, h) => Math.max(best, h.similarity), 0);
  for (const h of semanticHits) {
    fused.set(h.chunkId, (fused.get(h.chunkId) ?? 0) + semanticContribution(h.similarity, bestSimilarity, h.rank));
  }
  for (const [chunkId, rank] of ftsRank) {
    if (!visible(chunkMap.get(chunkId))) continue;
    fused.set(chunkId, (fused.get(chunkId) ?? 0) + 1 / (RRF_K + rank));
  }

  // Normalise, then apply the two boosts: recency and title match.
  const terms = titleTerms(query);
  let results: SearchResult[] = [];
  for (const [chunkId, rawScore] of fused) {
    const chunk = chunkMap.get(chunkId);
    if (!visible(chunk)) continue;
    const meta = convMeta.get(chunk.conversation_id);
    if (!meta) continue;
    const boosted =
      (rawScore / RRF_MAX) *
      recencyMultiplier(meta.updatedAt) *
      titleMultiplier(meta.title, terms);
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

  // Drop results below the minimum relevance threshold. A search scoped to
  // one conversation has no default threshold: the caller is reading through
  // that conversation and wants its best chunks, however far behind the first.
  const floor = minScore ?? (conversationId ? 0 : DEFAULT_MIN_SCORE);
  if (floor > 0) {
    results = results.filter((r) => r.score >= floor);
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

  // Fill the page. A row whose text lives only in R2 (engram#384) carries ''
  // in chunk_text, so its snippet above is empty: fetch the text for the rows
  // about to be returned, never for the whole candidate set. A copy that
  // cannot be read degrades to the summary rather than failing the search.
  //
  // With the text in hand, a result that repeats an earlier result word for
  // word is dropped and the next candidate takes its place: the same session
  // saved twice should not take two places on the page. A row whose text
  // could not be read is kept.
  const page: SearchResult[] = [];
  const fullText = new Map<string, string>();
  const seenText = new Set<string>();
  let cursor = 0;
  for (let round = 0; round < PAGE_FILL_ROUNDS && page.length < limit && cursor < results.length; round++) {
    const batch = results.slice(cursor, cursor + (limit - page.length));
    cursor += batch.length;
    const inR2 = batch
      .map((r) => chunkMap.get(r.chunk_id))
      .filter((row): row is ChunkRow => !!row && isTextInR2Only(row));
    const texts = inR2.length > 0 ? await loadChunkTexts(env, inR2) : new Map<string, string>();
    for (const r of batch) {
      const row = chunkMap.get(r.chunk_id);
      if (!row) continue;
      let text: string | undefined = row.chunk_text;
      if (isTextInR2Only(row)) {
        text = texts.get(row.id);
        r.chunk_text =
          text !== undefined ? truncateSnippet(text, cappedSnippet) : (row.chunk_summary ?? "");
      }
      if (dedupe && text) {
        if (seenText.has(text)) continue;
        seenText.add(text);
      }
      if (text) fullText.set(r.chunk_id, text);
      page.push(r);
    }
  }

  // Label the page (engram#758, stage 2). Ranking always finds a nearest
  // text, so a query about something never saved still fills the page. A
  // second model reads the query against each result; one it calls unrelated
  // is marked weak unless the keywords or the title matched, the two signals
  // that model is known to miss. Labels only: nothing is dropped, because the
  // model is occasionally wrong about a real answer. Not for a search inside
  // one conversation, where the caller already chose what to read.
  if (!conversationId && page.length > 0 && relevanceCheckEnabled(env)) {
    const readable = page.filter((r) => fullText.has(r.chunk_id));
    const started = Date.now();
    const check = await scoreRelevance(
      env.AI,
      query,
      readable.map((r) => fullText.get(r.chunk_id)!),
    );
    if (check.ok) {
      let weak = 0;
      readable.forEach((r, i) => {
        const score = check.scores[i];
        if (score === undefined) return;
        const backed = ftsRank.has(r.chunk_id) || titleMultiplier(r.conversation_title, terms) > 1;
        r.match = score < WEAK_MATCH_SCORE && !backed ? "weak" : "strong";
        if (r.match === "weak") weak++;
      });
      // Counts only. Never the query or the text: both are user content.
      console.log(
        `[search] relevance check ${JSON.stringify({ results: page.length, checked: readable.length, weak, ms: Date.now() - started })}`,
      );
    } else {
      console.warn(`[search] relevance check skipped ${JSON.stringify({ reason: check.reason })}`);
    }
  }

  return page;
}

/** True when the check ran and called every result on the page weak: the
 *  page is the closest stored text, and probably not about the query. */
export function isWeakPage(results: Pick<SearchResult, "match">[]): boolean {
  return results.length > 0 && results.every((r) => r.match === "weak");
}

export const WEAK_PAGE_NOTICE =
  "No strong match was found for this query. These are the closest saved items and may be unrelated: read them before relying on them, and if none answers the question, say that nothing saved covers it.";
