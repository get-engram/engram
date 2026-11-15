import { Miniflare } from "miniflare";
import { insertChunks, insertConversation } from "@getengram/db";
import { summarizeChunk, type SearchResult } from "@getengram/shared";
import { applyAllMigrations } from "../miniflare.js";
import { createMockEnv } from "../helpers.js";
import { searchConversations } from "../../services/search.js";
import { CHUNK_R2_ENCODING, chunkObjectKey } from "../../services/chunk-store.js";
import { CONVERSATIONS, QUERIES, type BenchQuery } from "./corpus.js";
import { corpusChunks, cosine, decodeVector, readEmbeddingsFile, textKey } from "./vectors.js";

/**
 * The search relevance benchmark (engram#758).
 *
 * Runs the real searchConversations over the corpus in corpus.ts: the
 * keyword side is real SQLite FTS5 (Miniflare's D1, real migrations), the
 * vector side is a brute-force cosine search over embeddings recorded from
 * the production model. Half the conversations have their chunk text only in
 * the chunk bucket, as most production rows now do.
 *
 * It measures ranking, not the size of the index: about a hundred chunks
 * stand in for an account's thousands.
 */

export const BENCH_ORG = "org_search_bench";
const LIMIT = 5;

type SearchEnv = Parameters<typeof searchConversations>[0];

export interface Bench {
  search(q: BenchQuery): Promise<SearchResult[]>;
  /** Cosine similarity of the best-matching chunk for a query, as Vectorize would report it. */
  topSimilarity(query: string): number;
  dispose(): Promise<void>;
}

export async function buildBench(): Promise<Bench> {
  const recorded = readEmbeddingsFile();
  if (!recorded) {
    throw new Error("search-bench/embeddings.json is missing: run `pnpm --filter @getengram/mcp-server bench:record`");
  }
  const vectorOf = (text: string): number[] => {
    const encoded = recorded.vectors[textKey(text)];
    if (!encoded) {
      throw new Error(
        "no recorded embedding for a benchmark text: the corpus changed, run `pnpm --filter @getengram/mcp-server bench:record`",
      );
    }
    return decodeVector(encoded);
  };

  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "search-bench" },
  });
  const db = await mf.getD1Database("DB");
  await applyAllMigrations(db);
  await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(BENCH_ORG, "bench").run();

  const env = createMockEnv(db);
  const chunks = corpusChunks();
  const now = Date.now();

  for (const [i, conv] of CONVERSATIONS.entries()) {
    await insertConversation(db, conv.id, BENCH_ORG, conv.title, "bench", conv.tags ?? [], {});
    await db
      .prepare("UPDATE conversations SET updated_at = ? WHERE id = ?")
      .bind(new Date(now - conv.ageDays * 86_400_000).toISOString(), conv.id)
      .run();
    const mine = chunks.filter((c) => c.conversationId === conv.id);
    await insertChunks(
      db,
      mine.map((c) => ({
        id: c.id,
        conversationId: c.conversationId,
        organizationId: BENCH_ORG,
        chunkText: c.text,
        chunkSummary: summarizeChunk(c.text),
        startSequence: c.startSequence,
        endSequence: c.endSequence,
        vectorizeId: c.id,
      })),
    );
    // Every second conversation: text in the bucket only, column cleared.
    if (i % 2 === 1) {
      for (const c of mine) await env.CHUNKS.put(chunkObjectKey(c.conversationId, c.id), c.text);
      await db
        .prepare("UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = ? WHERE conversation_id = ?")
        .bind(CHUNK_R2_ENCODING, conv.id)
        .run();
    }
  }

  const index = chunks.map((c) => ({ id: c.id, conversationId: c.conversationId, vector: vectorOf(c.text) }));
  const nearest = (vector: ArrayLike<number>, conversationId?: string) =>
    index
      .filter((c) => !conversationId || c.conversationId === conversationId)
      .map((c) => ({ id: c.id, score: cosine(vector, c.vector) }))
      .sort((a, b) => b.score - a.score);

  const mocks = env as unknown as {
    AI: { run: unknown };
    VECTORIZE: { query: unknown };
  };
  mocks.AI.run = async (_model: string, input: { text: string[] }) => ({ data: input.text.map(vectorOf) });
  mocks.VECTORIZE.query = async (
    vector: number[],
    opts: { topK: number; filter?: { organization_id?: string; conversation_id?: string } },
  ) => {
    if (opts.filter?.organization_id !== BENCH_ORG) return { matches: [] };
    const matches = nearest(vector, opts.filter.conversation_id).slice(0, opts.topK);
    return { count: matches.length, matches };
  };

  return {
    search: (q) =>
      searchConversations(
        env as unknown as SearchEnv,
        BENCH_ORG,
        q.query,
        LIMIT,
        undefined,
        q.tags,
        undefined,
        undefined,
        undefined,
        q.project,
      ),
    topSimilarity: (query) => nearest(vectorOf(query))[0]?.score ?? 0,
    dispose: () => mf.dispose(),
  };
}

export interface CaseOutcome {
  id: string;
  scenario: BenchQuery["scenario"];
  /** 1-based position of the first result from a relevant conversation, or null. */
  rank: number | null;
  groups: number;
  groupsFound: number;
  returned: number;
  /** Results whose text repeats an earlier result's text. */
  duplicates: number;
  /** Results that are nothing but tool output. */
  toolOnly: number;
  /** Conversation of each result, in order. */
  order: string[];
}

function isToolOnly(text: string): boolean {
  return !/(^|\n)\[(user|assistant|system)\]: /.test(text);
}

export function scoreCase(q: BenchQuery, results: SearchResult[]): CaseOutcome {
  const relevant = new Set(q.relevant.flat());
  const firstIdx = results.findIndex((r) => relevant.has(r.conversation_id));
  const seenText = new Set<string>();
  let duplicates = 0;
  for (const r of results) {
    if (seenText.has(r.chunk_text)) duplicates++;
    seenText.add(r.chunk_text);
  }
  return {
    id: q.id,
    scenario: q.scenario,
    rank: firstIdx === -1 ? null : firstIdx + 1,
    groups: q.relevant.length,
    groupsFound: q.relevant.filter((g) => results.some((r) => g.includes(r.conversation_id))).length,
    returned: results.length,
    duplicates,
    toolOnly: results.filter((r) => isToolOnly(r.chunk_text)).length,
    order: results.map((r) => r.conversation_id),
  };
}

export async function runBench(bench: Bench): Promise<CaseOutcome[]> {
  const outcomes: CaseOutcome[] = [];
  for (const q of QUERIES) outcomes.push(scoreCase(q, await bench.search(q)));
  return outcomes;
}

export interface Summary {
  cases: number;
  /** Share of answerable queries whose first result is relevant. */
  hitAt1: number;
  /** Mean reciprocal rank of the first relevant result. */
  mrr: number;
  /** Share of the things to find that appear in the page. */
  recall: number;
  duplicates: number;
  toolOnly: number;
  /** Mean results returned for queries nothing answers. */
  noAnswerReturned: number;
}

export function summarize(outcomes: CaseOutcome[]): Summary {
  const answerable = outcomes.filter((o) => o.groups > 0);
  const unanswerable = outcomes.filter((o) => o.groups === 0);
  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
  return {
    cases: outcomes.length,
    hitAt1: mean(answerable.map((o) => (o.rank === 1 ? 1 : 0))),
    mrr: mean(answerable.map((o) => (o.rank ? 1 / o.rank : 0))),
    recall: mean(answerable.map((o) => o.groupsFound / o.groups)),
    duplicates: outcomes.reduce((n, o) => n + o.duplicates, 0),
    toolOnly: answerable.reduce((n, o) => n + o.toolOnly, 0),
    noAnswerReturned: mean(unanswerable.map((o) => o.returned)),
  };
}

export function formatReport(outcomes: CaseOutcome[]): string {
  const lines: string[] = [];
  const row = (label: string, s: Summary) =>
    `${label.padEnd(14)} ${String(s.cases).padStart(3)}  hit@1 ${s.hitAt1.toFixed(2)}  MRR ${s.mrr.toFixed(2)}  recall@5 ${s.recall.toFixed(2)}  dup ${s.duplicates}  tool-only ${s.toolOnly}`;
  const scenarios = [...new Set(outcomes.map((o) => o.scenario))].filter((s) => s !== "no-answer");
  for (const s of scenarios) lines.push(row(s, summarize(outcomes.filter((o) => o.scenario === s))));
  const all = summarize(outcomes);
  lines.push(row("ALL answerable", { ...all, cases: outcomes.filter((o) => o.groups > 0).length }));
  lines.push(`no-answer: ${all.noAnswerReturned.toFixed(1)} results returned on average (ideal 0)`);
  lines.push("");
  for (const o of outcomes) {
    lines.push(
      `${o.id.padEnd(20)} rank ${String(o.rank ?? "-").padStart(2)}  found ${o.groupsFound}/${o.groups}  n=${o.returned} dup=${o.duplicates} tool=${o.toolOnly}  ${o.order.map((c) => c.replace("conv_", "")).join(" > ")}`,
    );
  }
  return lines.join("\n");
}
