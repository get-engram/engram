import { describe, it, expect, vi } from "vitest";
import {
  relevanceCheckEnabled,
  RERANK_MODEL,
  scoreRelevance,
  WEAK_MATCH_SCORE,
} from "../services/relevance-check.js";
import { isWeakPage } from "../services/search.js";
import type { Env } from "../types.js";

/**
 * The relevance check (engram#758, stage 2): the second model's scores, and
 * the rule that it can never fail a search.
 */

const ai = (run: (model: string, input: unknown) => unknown) => ({ run: vi.fn(run) }) as unknown as Env["AI"];

describe("scoreRelevance", () => {
  it("returns one score per text, in the order the texts were given", async () => {
    const binding = ai(async () => ({
      // The model answers best first, not in input order.
      response: [
        { id: 2, score: 0.91 },
        { id: 0, score: 0.4 },
        { id: 1, score: 0.0003 },
      ],
    }));
    const res = await scoreRelevance(binding, "the query", ["a", "b", "c"]);
    expect(res).toEqual({ ok: true, scores: [0.4, 0.0003, 0.91] });
    const run = (binding as unknown as { run: ReturnType<typeof vi.fn> }).run;
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(RERANK_MODEL);
    expect(run.mock.calls[0][1]).toEqual({
      query: "the query",
      contexts: [{ text: "a" }, { text: "b" }, { text: "c" }],
      top_k: 3,
    });
  });

  it("does not call the model for an empty page", async () => {
    const binding = ai(async () => ({ response: [] }));
    expect(await scoreRelevance(binding, "q", [])).toEqual({ ok: true, scores: [] });
    expect((binding as unknown as { run: ReturnType<typeof vi.fn> }).run).not.toHaveBeenCalled();
  });

  it("caps an oversized text before sending it", async () => {
    const binding = ai(async () => ({ response: [{ id: 0, score: 0.5 }] }));
    await scoreRelevance(binding, "q", ["x".repeat(10_000)]);
    const sent = (binding as unknown as { run: ReturnType<typeof vi.fn> }).run.mock.calls[0][1] as {
      contexts: { text: string }[];
    };
    expect(sent.contexts[0].text.length).toBe(2400);
  });

  it("leaves a text unscored when the model skipped it or scored it with nonsense", async () => {
    const binding = ai(async () => ({
      response: [
        { id: 0, score: 0.7 },
        { id: 1, score: Number.NaN },
        { id: 9, score: 0.9 },
        { id: -1, score: 0.9 },
        { id: 1.5, score: 0.9 },
        { id: "2", score: 0.9 },
      ],
    }));
    expect(await scoreRelevance(binding, "q", ["a", "b", "c"])).toEqual({
      ok: true,
      scores: [0.7, undefined, undefined],
    });
  });

  it("reports a model error without throwing", async () => {
    const binding = ai(async () => {
      throw new Error("internal error; reference = abc");
    });
    expect(await scoreRelevance(binding, "q", ["a"])).toEqual({ ok: false, reason: "error" });
  });

  it("reports a synchronous throw from the binding without throwing", async () => {
    const binding = ai(() => {
      throw new Error("binding missing");
    });
    expect(await scoreRelevance(binding, "q", ["a"])).toEqual({ ok: false, reason: "error" });
  });

  it.each([null, undefined, {}, { response: "no" }, { response: [] }, { response: [{ id: 5, score: 1 }] }, { data: [[0.1]] }])(
    "reports an answer in an unexpected shape (%j)",
    async (answer) => {
      const binding = ai(async () => answer);
      expect(await scoreRelevance(binding, "q", ["a"])).toEqual({ ok: false, reason: "shape" });
    },
  );

  it("stops waiting after its time budget, and a late failure goes nowhere", async () => {
    const binding = ai(
      () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 60)),
    );
    const started = Date.now();
    expect(await scoreRelevance(binding, "q", ["a"], 15)).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(55);
    // Let the late rejection land: an unhandled rejection would fail the run.
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
});

describe("relevanceCheckEnabled", () => {
  it("is on unless switched off", () => {
    expect(relevanceCheckEnabled({})).toBe(true);
    expect(relevanceCheckEnabled({ SEARCH_RELEVANCE_CHECK: "" })).toBe(true);
    expect(relevanceCheckEnabled({ SEARCH_RELEVANCE_CHECK: "on" })).toBe(true);
    expect(relevanceCheckEnabled({ SEARCH_RELEVANCE_CHECK: "off" })).toBe(false);
    expect(relevanceCheckEnabled({ SEARCH_RELEVANCE_CHECK: " OFF\n" })).toBe(false);
  });
});

describe("isWeakPage", () => {
  it("is true only when every result is labelled weak", () => {
    expect(isWeakPage([{ match: "weak" }, { match: "weak" }])).toBe(true);
    expect(isWeakPage([{ match: "weak" }, { match: "strong" }])).toBe(false);
    // Unlabelled: the check did not run, so nothing is claimed.
    expect(isWeakPage([{ match: "weak" }, {}])).toBe(false);
    expect(isWeakPage([{}])).toBe(false);
    expect(isWeakPage([])).toBe(false);
  });

  it("keeps the threshold where it was measured", () => {
    expect(WEAK_MATCH_SCORE).toBe(0.02);
  });
});
