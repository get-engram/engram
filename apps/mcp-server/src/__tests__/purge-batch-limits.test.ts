import { describe, it, expect, vi } from "vitest";
import { deleteVectorsByIds } from "../services/vectorize.js";
import { deleteMessageRowsByIds, deleteChunkRowsAndFts } from "@getengram/db";

// The two hidden batch-size limits that silently wedged the purge for any org
// with >100 vectors: Vectorize deleteByIds caps at 100 ids/call (code 40007),
// and D1 caps bound parameters per statement ("too many SQL variables"). Both
// must be chunked. These pin the chunking so the purge can never regress into
// throwing on a large org again.

describe("Vectorize delete respects the 100-id cap", () => {
  it("chunks deleteByIds into <=100-id calls", async () => {
    const calls: number[] = [];
    const env = { VECTORIZE: { deleteByIds: vi.fn(async (ids: string[]) => { calls.push(ids.length); }) } } as never;
    const ids = Array.from({ length: 250 }, (_, i) => `v${i}`);
    await deleteVectorsByIds(env, ids);
    expect(calls).toEqual([100, 100, 50]);
    expect(Math.max(...calls)).toBeLessThanOrEqual(100);
  });
});

describe("D1 IN-list deletes stay under the bound-parameter limit", () => {
  function captureBatch() {
    const stmts: { sql: string; args: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }),
      batch: async (s: { sql: string; args: unknown[] }[]) => { stmts.push(...s); return []; },
    } as unknown as D1Database;
    return { db, stmts };
  }

  it("chunks a 1000-id message delete into statements of <=100 params each", async () => {
    const { db, stmts } = captureBatch();
    await deleteMessageRowsByIds(db, Array.from({ length: 1000 }, (_, i) => `m${i}`));
    expect(stmts.length).toBeGreaterThan(1);
    for (const s of stmts) expect(s.args.length).toBeLessThanOrEqual(100);
    // Every id is deleted exactly once.
    expect(stmts.reduce((n, s) => n + s.args.length, 0)).toBe(1000);
  });

  it("chunks chunk + FTS deletes under the limit too", async () => {
    const { db, stmts } = captureBatch();
    await deleteChunkRowsAndFts(
      db,
      Array.from({ length: 300 }, (_, i) => `c${i}`),
      Array.from({ length: 300 }, (_, i) => i),
    );
    for (const s of stmts) expect(s.args.length).toBeLessThanOrEqual(100);
  });
});
