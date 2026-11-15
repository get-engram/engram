/**
 * Record the embeddings the search relevance benchmark replays (engram#758).
 *
 *   pnpm --filter @getengram/mcp-server bench:record
 *
 * Run after editing src/__tests__/search-bench/corpus.ts. It embeds every
 * chunk and query that has no recorded vector yet with the production model,
 * through the Workers AI binding of whoever is logged in to wrangler, and
 * rewrites embeddings.json with exactly the texts the corpus now has. The
 * corpus is invented text, so nothing private is sent. A full recording is
 * a few hundred short texts.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPlatformProxy } from "wrangler";
import { EMBEDDING_MODEL } from "@getengram/shared";
import {
  EMBEDDINGS_FILE,
  encodeVector,
  readEmbeddingsFile,
  textKey,
  textsToEmbed,
  type EmbeddingsFile,
} from "../src/__tests__/search-bench/vectors.js";

const BATCH = 50;

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
    const proxy = await getPlatformProxy<{ AI: Ai }>({
      configPath: join(dirname(fileURLToPath(import.meta.url)), "search-bench.wrangler.toml"),
    });
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
