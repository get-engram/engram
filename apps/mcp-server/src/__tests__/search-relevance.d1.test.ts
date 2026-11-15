import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildBench, formatReport, runBench, summarize, type Bench, type CaseOutcome } from "./search-bench/harness.js";
import { QUERIES } from "./search-bench/corpus.js";

/**
 * Search relevance benchmark (engram#758): the real search over a fixed
 * corpus, with labelled queries. `pnpm bench:search` prints the full report.
 * The assertions are a floor under today's numbers, so a ranking change that
 * makes search worse fails here. What it cannot tell you: whether a query
 * with no answer should return nothing (it returns a full page today), or
 * anything about an index of real size.
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

  // Floors just under the measured numbers (hit@1 0.89, MRR 0.95, recall 1.00
  // when this was written; 0.46, 0.59 and 0.86 before the retune). Raise them
  // when ranking improves; do not lower them to make a change pass.
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

  // The scenarios ranking gets entirely right today. tool-noise and
  // title-recency still have known misses (a tool dump that repeats the
  // query's words; see engram#758, stage 2) and are held by the floors above.
  it.each(["semantic", "keyword", "freshness", "duplicate", "filter"] as const)(
    "ranks a relevant result first for every %s query",
    (scenario) => {
      const misses = outcomes.filter((o) => o.scenario === scenario && o.rank !== 1).map((o) => o.id);
      expect(misses).toEqual([]);
    },
  );
});
