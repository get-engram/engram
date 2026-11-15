import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildBench, formatReport, runBench, summarize, type Bench, type CaseOutcome } from "./search-bench/harness.js";
import { QUERIES } from "./search-bench/corpus.js";

/**
 * Search relevance benchmark (engram#758): the real search over a fixed
 * corpus, with labelled queries. `pnpm bench:search` prints the full report.
 * The assertions are a floor under today's numbers, so a ranking change that
 * makes search worse fails here. What it cannot tell you: anything about an
 * index of real size.
 *
 * A query with no answer still returns a page (ranking always finds a
 * nearest text); the relevance check labels that page instead of emptying
 * it, because the model behind it is sometimes wrong about a real answer.
 * The benchmark replays that model's recorded scores.
 */
describe("search relevance benchmark (engram#758)", () => {
  let bench: Bench;
  let outcomes: CaseOutcome[];

  beforeAll(async () => {
    bench = await buildBench();
    outcomes = await runBench(bench);
    if (process.env.BENCH_REPORT) console.log("\n" + formatReport(outcomes) + "\n");
  }, 120_000);

  afterAll(async () => {
    await bench?.dispose();
  });

  it("runs every labelled query", () => {
    expect(outcomes).toHaveLength(QUERIES.length);
  });

  // Floors just under the measured numbers (hit@1 0.88, MRR 0.94, recall 1.00
  // with the tool-answer queries added in stage 2; 0.46, 0.59 and 0.86 before
  // the stage 1 retune). Raise them when ranking improves; do not lower them
  // to make a change pass.
  it("puts a relevant result first for most queries", () => {
    const s = summarize(outcomes);
    expect(s.hitAt1).toBeGreaterThanOrEqual(0.85);
    expect(s.mrr).toBeGreaterThanOrEqual(0.92);
  });

  it("finds everything there is to find within the page", () => {
    expect(summarize(outcomes).recall).toBe(1);
  });

  it("never returns the same text twice", () => {
    expect(summarize(outcomes).duplicates).toBe(0);
  });

  // The scenarios ranking gets entirely right today. tool-noise, tool-answer
  // and title-recency have known misses, all at rank 2 (a tool dump that
  // holds every word of the query) and are held by the floors above. Ranking
  // tool output lower by its role was measured in stage 2 and rejected: every
  // setting strong enough to fix those misses hid a tool-answer query, where
  // tool output is the only place the answer is.
  it("finds the answer in the top two when only tool output holds it", () => {
    const misses = outcomes.filter((o) => o.scenario === "tool-answer" && (o.rank ?? 99) > 2).map((o) => o.id);
    expect(misses).toEqual([]);
  });

  // The relevance check, measured: 10 of the 12 no-answer pages flagged, the
  // other two held back by a near miss (a real tax conversation) and a title
  // match. One real answer is labelled weak and its page flagged: sem-portugal,
  // which shares no wording with its answer. That is why weak results are
  // labelled and not dropped.
  it("says so when nothing saved answers the query", () => {
    expect(summarize(outcomes).noAnswerFlagged).toBeGreaterThanOrEqual(0.8);
  });

  it("almost never calls a real answer weak", () => {
    const s = summarize(outcomes);
    expect(s.relevantWeak).toBeLessThanOrEqual(1);
    expect(s.answerableFlagged).toBeLessThanOrEqual(1);
  });

  it("returns every result the ranking chose, labelled or not", () => {
    const s = summarize(outcomes);
    expect(s.noAnswerReturned).toBeGreaterThan(0);
    expect(s.recall).toBe(1);
  });

  it.each(["semantic", "keyword", "freshness", "duplicate", "filter"] as const)(
    "ranks a relevant result first for every %s query",
    (scenario) => {
      const misses = outcomes.filter((o) => o.scenario === scenario && o.rank !== 1).map((o) => o.id);
      expect(misses).toEqual([]);
    },
  );
});
