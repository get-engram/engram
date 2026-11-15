import type { Env } from "../types.js";

/**
 * The relevance check (engram#758, stage 2): a second model reads the query
 * against each result on the page and says whether the text answers it.
 *
 * Ranking cannot tell "the best match" from "the least bad match": a query
 * about something never saved still gets a full page, because similarity to
 * the nearest stored text is as high for it (0.50 to 0.75 on real accounts)
 * as for a real answer. A cross-encoder reads the two texts together and
 * separates them far better: it scored about 88% of unrelated results under
 * 0.02, and most real answers between 0.2 and 1.0.
 *
 * It is not right often enough to delete results on its word. A few real
 * answers that share no wording with the query scored under 0.02 as well
 * (0.000 for one in the benchmark). So the check only labels: see `match` on
 * SearchResult. Nothing is dropped and the order does not change.
 *
 * It fails open: an error, a timeout or an answer in an unexpected shape
 * means no labels, never a failed search.
 */

export const RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Below this the model is saying "unrelated". Measured, not chosen by feel:
 *  see the numbers on engram#758 before moving it. */
export const WEAK_MATCH_SCORE = 0.02;

/** How long a search waits for the check before returning without labels. */
export const RELEVANCE_CHECK_BUDGET_MS = 1200;

/** The model reads 512 tokens; a chunk is at most about 2,000 characters.
 *  The cap is for the odd oversized chunk written before chunks had a limit. */
const MAX_CONTEXT_CHARS = 2400;

export type RelevanceFailure = "timeout" | "error" | "shape";

export type RelevanceScores =
  | { ok: true; scores: (number | undefined)[] }
  | { ok: false; reason: RelevanceFailure };

/** "off" switches the check off; anything else, or nothing, leaves it on. */
export function relevanceCheckEnabled(env: Pick<Env, "SEARCH_RELEVANCE_CHECK">): boolean {
  return (env.SEARCH_RELEVANCE_CHECK ?? "").trim().toLowerCase() !== "off";
}

/**
 * Score each text against the query, in the order given. A text the model
 * returned no score for comes back undefined. Never throws.
 */
export async function scoreRelevance(
  ai: Env["AI"],
  query: string,
  texts: string[],
  budgetMs: number = RELEVANCE_CHECK_BUDGET_MS,
): Promise<RelevanceScores> {
  if (texts.length === 0) return { ok: true, scores: [] };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budgetMs);
  });
  try {
    const call = ai.run(
      RERANK_MODEL as keyof AiModels,
      {
        query,
        contexts: texts.map((text) => ({ text: text.slice(0, MAX_CONTEXT_CHARS) })),
        top_k: texts.length,
      } as never,
    ) as Promise<unknown>;
    // A call that loses the race keeps running; its late failure is not ours.
    call.catch(() => {});
    const res = await Promise.race([call, timeout]);
    if (res === "timeout") return { ok: false, reason: "timeout" };

    const rows = (res as { response?: unknown } | null)?.response;
    if (!Array.isArray(rows)) return { ok: false, reason: "shape" };
    const scores: (number | undefined)[] = new Array(texts.length).fill(undefined);
    for (const row of rows as { id?: unknown; score?: unknown }[]) {
      const id = row?.id;
      const score = row?.score;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || id >= texts.length) continue;
      if (typeof score !== "number" || !Number.isFinite(score)) continue;
      scores[id] = score;
    }
    if (scores.every((s) => s === undefined)) return { ok: false, reason: "shape" };
    return { ok: true, scores };
  } catch {
    return { ok: false, reason: "error" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
