import { describe, it, expect } from "vitest";
import { TIER_LIMITS, MAX_MESSAGE_CONTENT_CHARS, type Tier } from "@getengram/shared";
import { getCurrentPeriod } from "@getengram/db";
import {
  estimateIndexingUnits,
  checkAndTrackIndexing,
  checkAndTrackSearch,
  IndexingQuotaError,
} from "../services/tier.js";

/**
 * The two cost budgets (engram#445, #450, #451): chunks embedded and
 * searches run per period. These tests pin the unit the indexing budget
 * is charged in (the real chunker's output), the exact SQL shape each gate
 * issues — a reserve-if-within-limit UPDATE, one statement, so concurrent
 * requests cannot both pass — and the rejection payloads the routes turn
 * into 429s. SQLite semantics of that UPDATE are covered in
 * usage-quotas.d1.test.ts against a real database.
 */

interface Call {
  sql: string;
  bindings: unknown[];
}

function stubDb(firstFor: (sql: string, bindings: unknown[]) => unknown = () => null) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...bindings: unknown[]) {
          calls.push({ sql, bindings });
          return {
            first: async () => firstFor(sql, bindings),
            run: async () => ({ success: true, meta: {}, results: [] }),
            all: async () => ({ success: true, meta: {}, results: [] }),
          };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

const isUpsert = (c: Call) => /INSERT INTO usage/.test(c.sql);
const isCounter = (col: string) => (c: Call) =>
  new RegExp(`UPDATE usage\\s+SET ${col} = ${col} \\+ \\?`).test(c.sql);

describe("estimateIndexingUnits", () => {
  it("is zero for an empty batch and one chunk for a short message", () => {
    expect(estimateIndexingUnits([])).toBe(0);
    expect(estimateIndexingUnits([{ role: "user", content: "remember this" }])).toBe(1);
  });

  it("matches the chunker's window/stride partition for a long batch", () => {
    // 200 messages: a 5-message window starts every 3 messages, including
    // the partial tail → ceil(200 / 3) = 67 chunks.
    const batch = Array.from({ length: 200 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
    }));
    expect(estimateIndexingUnits(batch)).toBe(Math.ceil(200 / 3));
  });

  it("charges an oversized body for every slice it will be split into", () => {
    const huge = "x".repeat(100_000);
    expect(estimateIndexingUnits([{ role: "user", content: huge }])).toBe(53);
  });

  it("clips a body the way append clips it before counting", () => {
    // Append truncates at MAX_MESSAGE_CONTENT_CHARS (plus a visible marker)
    // before chunking, so every over-cap body embeds the same number of
    // chunks. The estimate must agree — a raw 1,000,000-character body
    // would otherwise be charged the ~520 slices it never produces.
    const justOver = "y".repeat(MAX_MESSAGE_CONTENT_CHARS + 1);
    const wayOver = "y".repeat(1_000_000);
    const units = estimateIndexingUnits([{ role: "user", content: wayOver }]);
    expect(units).toBe(estimateIndexingUnits([{ role: "user", content: justOver }]));
    expect(units).toBeLessThan(60);
  });
});

describe("checkAndTrackIndexing", () => {
  it("touches nothing when there is nothing to embed", async () => {
    const { db, calls } = stubDb();
    const r = await checkAndTrackIndexing(db, "org_a", "free", 0);
    expect(r.allowed).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("reserves with a single guarded UPDATE bound (count, org, period, count, limit)", async () => {
    const { db, calls } = stubDb((sql) =>
      /UPDATE usage/.test(sql) ? { chunks_indexed: 7 } : { id: "usg_1" },
    );
    const r = await checkAndTrackIndexing(db, "org_a", "free", 7);
    expect(r).toEqual({
      allowed: true,
      used: 7,
      limit: TIER_LIMITS.free.chunks_indexed_per_month,
      tier: "free",
    });

    const counter = calls.filter(isCounter("chunks_indexed"));
    expect(counter).toHaveLength(1);
    expect(counter[0].sql).toMatch(/chunks_indexed \+ \? <= \?/);
    expect(counter[0].sql).toMatch(/RETURNING chunks_indexed/);
    expect(counter[0].bindings).toEqual([
      7,
      "org_a",
      getCurrentPeriod(),
      7,
      TIER_LIMITS.free.chunks_indexed_per_month,
    ]);
    // Only the counter is ever interpolated — never caller input.
    expect(counter[0].sql).not.toContain("org_a");
  });

  it("refuses with limit/used/tier when the reserve returns no row", async () => {
    const { db } = stubDb((sql) =>
      /UPDATE usage/.test(sql) ? null : { id: "usg_1", chunks_indexed: 100_000 },
    );
    const r = await checkAndTrackIndexing(db, "org_a", "free", 3);
    expect(r).toEqual({
      allowed: false,
      error: "indexing_quota_exceeded",
      limit: 100_000,
      used: 100_000,
      tier: "free",
    });
  });

  it("counts without a guard on unlimited tiers", async () => {
    const { db, calls } = stubDb(() => ({ id: "usg_1" }));
    const r = await checkAndTrackIndexing(db, "org_a", "enterprise", 50);
    expect(r.allowed).toBe(true);
    expect(calls.some(isUpsert)).toBe(true);
    const counter = calls.filter(isCounter("chunks_indexed"));
    expect(counter).toHaveLength(1);
    expect(counter[0].sql).not.toMatch(/<=/);
    expect(counter[0].bindings).toEqual([50, "org_a", getCurrentPeriod()]);
  });
});

describe("checkAndTrackSearch", () => {
  it("reserves one search with a guarded UPDATE before the search runs", async () => {
    const { db, calls } = stubDb((sql) =>
      /UPDATE usage/.test(sql) ? { searches_run: 12 } : { id: "usg_1" },
    );
    const r = await checkAndTrackSearch(db, "org_s", "pro");
    expect(r).toEqual({
      allowed: true,
      used: 12,
      limit: TIER_LIMITS.pro.searches_per_month,
      tier: "pro",
    });
    const counter = calls.filter(isCounter("searches_run"));
    expect(counter).toHaveLength(1);
    expect(counter[0].bindings).toEqual([
      1,
      "org_s",
      getCurrentPeriod(),
      1,
      TIER_LIMITS.pro.searches_per_month,
    ]);
  });

  it("refuses with search_quota_exceeded once the budget is spent", async () => {
    const { db } = stubDb((sql) =>
      /UPDATE usage/.test(sql) ? null : { id: "usg_1", searches_run: 50_000 },
    );
    const r = await checkAndTrackSearch(db, "org_s", "free");
    expect(r).toEqual({
      allowed: false,
      error: "search_quota_exceeded",
      limit: 50_000,
      used: 50_000,
      tier: "free",
    });
  });

  it("just counts on unlimited tiers", async () => {
    const { db, calls } = stubDb(() => ({ id: "usg_1" }));
    const r = await checkAndTrackSearch(db, "org_s", "enterprise");
    expect(r.allowed).toBe(true);
    const counter = calls.filter(isCounter("searches_run"));
    expect(counter).toHaveLength(1);
    expect(counter[0].sql).not.toMatch(/<=/);
  });
});

describe("IndexingQuotaError", () => {
  it("carries the check result for the route to answer with", () => {
    const err = new IndexingQuotaError({
      allowed: false,
      error: "indexing_quota_exceeded",
      limit: 10,
      used: 10,
      tier: "free",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("IndexingQuotaError");
    expect(err.message).toBe("indexing_quota_exceeded");
    expect(err.result.limit).toBe(10);
  });
});

describe("TIER_LIMITS cost budgets", () => {
  const tiers = Object.keys(TIER_LIMITS) as Tier[];

  it("every tier declares both budgets", () => {
    for (const tier of tiers) {
      expect(typeof TIER_LIMITS[tier].chunks_indexed_per_month).toBe("number");
      expect(typeof TIER_LIMITS[tier].searches_per_month).toBe("number");
    }
  });

  it("paid-or-free tiers are bounded; enterprise is not", () => {
    for (const tier of tiers) {
      const { chunks_indexed_per_month, searches_per_month } = TIER_LIMITS[tier];
      if (tier === "enterprise") {
        expect(chunks_indexed_per_month).toBe(-1);
        expect(searches_per_month).toBe(-1);
      } else {
        expect(chunks_indexed_per_month).toBeGreaterThan(0);
        expect(searches_per_month).toBeGreaterThan(0);
      }
    }
  });

  it("the free indexing budget is an abuse guard, far above a full storage cap", () => {
    // A legitimate free account can fill its lifetime storage several times
    // over in one month before this guard is reachable — it must never be
    // the thing a real user hits.
    expect(TIER_LIMITS.free.chunks_indexed_per_month).toBeGreaterThanOrEqual(
      3 * TIER_LIMITS.free.storage_messages,
    );
  });
});
