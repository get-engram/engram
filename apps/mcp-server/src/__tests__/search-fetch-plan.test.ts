import { describe, it, expect } from "vitest";
import { getChunksByVectorizeIds } from "@getengram/db";

/**
 * The search hydration fetch must force idx_chunks_vectorize (engram#469).
 *
 * With `WHERE vectorize_id IN (…) AND organization_id = ?` the planner prefers
 * the org index and walks every chunk the org owns — 215k rows per search for
 * the largest account — which is the mechanism behind the 2026-10-06 D1
 * overload. This pins the INDEXED BY clause so a well-meaning cleanup can't
 * quietly hand the query back to the planner.
 */
describe("getChunksByVectorizeIds", () => {
  it("forces the vectorize_id index and keeps the org fence", () => {
    let sql = "";
    const db = {
      prepare: (q: string) => {
        sql = q;
        return { bind: () => ({ all: async () => ({ results: [] }) }) };
      },
    } as unknown as D1Database;
    void getChunksByVectorizeIds(db, ["chk_a", "chk_b", "chk_c"], "org_x");
    expect(sql).toMatch(/FROM conversation_chunks INDEXED BY idx_chunks_vectorize WHERE vectorize_id IN \(\?,\?,\?\)/);
    expect(sql).toMatch(/AND organization_id = \?$/);
  });
});
