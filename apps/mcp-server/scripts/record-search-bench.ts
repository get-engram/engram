/**
 * Record what the search relevance benchmark replays (engram#758): the
 * embeddings, and the relevance-check scores of every query against every
 * chunk text.
 *
 *   pnpm --filter @getengram/mcp-server bench:record
 *
 * Run after editing src/__tests__/search-bench/corpus.ts. It embeds every
 * chunk and query that has no recorded vector yet with the production model,
 * through the Workers AI binding of whoever is logged in to wrangler, and
 * rewrites embeddings.json with exactly the texts the corpus now has. The
 * corpus is invented text, so nothing private is sent. A full recording is
 * a few hundred short texts to embed, then one reranker call per query and
 * forty texts (about a minute and a half).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { EMBEDDING_MODEL } from "@getengram/shared";
import {
  chunkTexts,
  EMBEDDINGS_FILE,
  encodeVector,
  readEmbeddingsFile,
  readRerankFile,
  recordedRelevance,
  RERANK_FILE,
  textKey,
  textsToEmbed,
  type EmbeddingsFile,
  type RerankFile,
} from "../src/__tests__/search-bench/vectors.js";
import { QUERIES } from "../src/__tests__/search-bench/corpus.js";
import { RERANK_MODEL } from "../src/services/relevance-check.js";

const BATCH = 50;
const RERANK_BATCH = 40;
const RERANK_ATTEMPTS = 4;

type Proxy = Awaited<ReturnType<typeof getPlatformProxy<{ AI: Ai }>>>;

async function openProxy(): Promise<Proxy> {
  return getPlatformProxy<{ AI: Ai }>({
    configPath: join(dirname(fileURLToPath(import.meta.url)), "search-bench.wrangler.toml"),
  });
}

async function rerank(proxy: Proxy, query: string, texts: string[]): Promise<number[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = (await proxy.env.AI.run(
        RERANK_MODEL as keyof AiModels,
        { query, contexts: texts.map((text) => ({ text })), top_k: texts.length } as never,
      )) as { response: { id: number; score: number }[] };
      const scores = new Array<number>(texts.length).fill(NaN);
      for (const row of res.response) scores[row.id] = row.score;
      if (scores.some((s) => !Number.isFinite(s))) throw new Error("the reranker left a text unscored");
      return scores;
    } catch (err) {
      if (attempt >= RERANK_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

async function recordRelevance(): Promise<void> {
  const texts = chunkTexts();
  const queries = [...new Set(QUERIES.map((q) => q.query))];
  const previous = readRerankFile();
  const reusable = previous?.model === RERANK_MODEL ? previous : null;
  const file: RerankFile = { model: RERANK_MODEL, texts: texts.map(textKey), queries: {} };

  let proxy: Proxy | undefined;
  let scored = 0;
  try {
    for (const query of queries) {
      const row: (number | undefined)[] = texts.map((text) =>
        reusable ? recordedRelevance(reusable, query, text) : undefined,
      );
      const missing = row.flatMap((score, i) => (score === undefined ? [i] : []));
      for (let i = 0; i < missing.length; i += RERANK_BATCH) {
        proxy ??= await openProxy();
        const batch = missing.slice(i, i + RERANK_BATCH);
        const scores = await rerank(proxy, query, batch.map((column) => texts[column]));
        batch.forEach((column, j) => {
          row[column] = Math.round(scores[j] * 10_000) / 10_000;
        });
        scored += batch.length;
      }
      file.queries[textKey(query)] = row as number[];
    }
  } finally {
    await proxy?.dispose();
  }

  const rows = Object.keys(file.queries)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(file.queries[key])}`);
  writeFileSync(
    RERANK_FILE,
    `{"model":${JSON.stringify(file.model)},\n"texts":${JSON.stringify(file.texts)},\n"queries":{\n${rows.join(",\n")}\n}}\n`,
  );
  console.log(
    `${queries.length} queries x ${texts.length} texts, ${scored} pairs newly scored, written to ${RERANK_FILE}`,
  );
}

async function main() {
  const texts = textsToEmbed();
  const previous = readEmbeddingsFile();
  const reusable = previous?.model === EMBEDDING_MODEL ? previous.vectors : {};
  const vectors: Record<string, string> = {};
  const missing: string[] = [];
  for (const text of texts) {
    const key = textKey(text);
    if (reusable[key]) vectors[key] = reusable[key];
    else missing.push(text);
  }

  let dimensions = previous?.dimensions ?? 0;
  if (missing.length > 0) {
    const proxy = await openProxy();
    try {
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        const res = (await proxy.env.AI.run(EMBEDDING_MODEL as keyof AiModels, { text: batch } as never)) as {
          data: number[][];
        };
        if (res.data.length !== batch.length) throw new Error("embedding count does not match the batch");
        batch.forEach((text, j) => {
          vectors[textKey(text)] = encodeVector(res.data[j]);
        });
        dimensions = res.data[0].length;
        console.log(`embedded ${Math.min(i + BATCH, missing.length)} of ${missing.length}`);
      }
    } finally {
      await proxy.dispose();
    }
  }

  const sorted = Object.fromEntries(Object.keys(vectors).sort().map((k) => [k, vectors[k]]));
  const file: EmbeddingsFile = { model: EMBEDDING_MODEL, dimensions, vectors: sorted };
  writeFileSync(EMBEDDINGS_FILE, JSON.stringify(file, null, 0).replace(/","/g, '",\n"') + "\n");
  console.log(`${texts.length} texts, ${missing.length} newly embedded, written to ${EMBEDDINGS_FILE}`);

  await recordRelevance();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
