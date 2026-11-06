import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer so we can drive the purge orchestration deterministically:
// the load-bearing behavior is "drain in bounded batches; finalize (drop the
// org) ONLY when no heavy data remains; isolate per-org failures." A ~6k-message
// org used to be attempted whole, throw, and be skipped every night — this pins
// that it now drains and finalizes correctly.
const db = vi.hoisted(() => ({
  expired: [] as { id: string }[],
  heavy: new Map<string, { messages: number; chunks: number; revisions: number }>(),
  finalized: [] as string[],
  chunkFetches: 0,
  msgFetches: 0,
  order: [] as string[],
}));

vi.mock("@getengram/db", () => ({
  getExpiredOrganizations: vi.fn(async () => ({ results: db.expired })),
  getChunkPurgeBatch: vi.fn(async (_d: unknown, org: string) => {
    db.chunkFetches++;
    const h = db.heavy.get(org)!;
    const take = Math.min(1000, h.chunks);
    return {
      results: Array.from({ length: take }, (_, i) => ({
        id: `c${i}`,
        conversation_id: `conv_${i % 3}`,
        vectorize_id: `v${i}`,
        fts_rowid: i,
      })),
    };
  }),
  deleteChunkRowsAndFts: vi.fn(async (_d: unknown, ids: string[]) => {
    db.order.push("chunk-rows");
    // decrement the org currently being drained (last fetched)
    for (const [, h] of db.heavy) if (h.chunks > 0) { h.chunks -= ids.length; break; }
  }),
  // Edit history (migration 0041). Drained BEFORE messages, because
  // message_revisions cascades from messages — draining messages first would
  // delete the revision rows and orphan their R2 objects. `order` records
  // which store was touched first so the test can assert that.
  getRevisionPurgeBatch: vi.fn(async (_d: unknown, org: string) => {
    db.order.push("revisions");
    const h = db.heavy.get(org)!;
    const take = Math.min(1000, h.revisions ?? 0);
    return { results: Array.from({ length: take }, (_, i) => ({ id: `rev${i}`, content_encoding: "r2:raw" })) };
  }),
  deleteRevisionRowsByIds: vi.fn(async (_d: unknown, ids: string[]) => {
    for (const [, h] of db.heavy) if ((h.revisions ?? 0) > 0) { h.revisions -= ids.length; break; }
  }),
  getMessagePurgeBatch: vi.fn(async (_d: unknown, org: string) => {
    db.order.push("messages");
    db.msgFetches++;
    const h = db.heavy.get(org)!;
    const take = Math.min(1000, h.messages);
    return { results: Array.from({ length: take }, (_, i) => ({ id: `m${i}`, content_encoding: "r2:raw" })) };
  }),
  deleteMessageRowsByIds: vi.fn(async (_d: unknown, ids: string[]) => {
    for (const [, h] of db.heavy) if (h.messages > 0) { h.messages -= ids.length; break; }
  }),
  countOrgHeavyData: vi.fn(async (_d: unknown, org: string) => db.heavy.get(org)!),
  deleteOrganizationById: vi.fn(async (_d: unknown, org: string) => { db.finalized.push(org); }),
}));

vi.mock("../services/content-store.js", () => ({ deleteContent: vi.fn(async (_e: unknown, ids: string[]) => ids.length) }));

import { purgeDeletedOrganizations } from "../cron/purge-deleted.js";

// Chunk text copies (engram#384): every key the purge deletes, in order.
const chunkKeysDeleted: string[] = [];

function env() {
  return {
    DB: {},
    VECTORIZE: { deleteByIds: vi.fn(async () => { db.order.push("vectors"); }) },
    CONTENT: {},
    CHUNKS: {
      delete: vi.fn(async (keys: string | string[]) => {
        db.order.push("chunk-copies");
        chunkKeysDeleted.push(...(Array.isArray(keys) ? keys : [keys]));
      }),
    },
  } as never;
}

beforeEach(() => {
  db.expired = []; db.heavy = new Map(); db.finalized = []; db.chunkFetches = 0; db.msgFetches = 0; db.order = [];
  chunkKeysDeleted.length = 0;
});

describe("resumable purge", () => {
  it("fully drains and finalizes a large org (6k messages, 1.9k chunks) in one run", async () => {
    db.expired = [{ id: "org_big" }];
    db.heavy.set("org_big", { messages: 6000, chunks: 1900, revisions: 0 });
    const purged = await purgeDeletedOrganizations(env());
    expect(purged).toBe(1);
    expect(db.finalized).toEqual(["org_big"]); // dropped only after empty
    expect(db.heavy.get("org_big")).toEqual({ messages: 0, chunks: 0, revisions: 0 });
  });

  it("does NOT finalize an org still holding data after the per-run cap", async () => {
    db.expired = [{ id: "org_huge" }];
    // 25k messages > MAX_PER_STORE_PER_RUN (10k) — must NOT be dropped this run.
    db.heavy.set("org_huge", { messages: 25000, chunks: 0, revisions: 0 });
    const purged = await purgeDeletedOrganizations(env());
    expect(purged).toBe(0);
    expect(db.finalized).toEqual([]); // still draining — org row survives
    expect(db.heavy.get("org_huge")!.messages).toBe(15000); // drained exactly the cap
  });

  it("isolates a failing org so the rest still purge", async () => {
    db.expired = [{ id: "org_ok1" }, { id: "org_bad" }, { id: "org_ok2" }];
    db.heavy.set("org_ok1", { messages: 10, chunks: 0, revisions: 0 });
    db.heavy.set("org_ok2", { messages: 10, chunks: 0, revisions: 0 });
    db.heavy.set("org_bad", { messages: 10, chunks: 0, revisions: 0 });
    const mod = await import("@getengram/db");
    const orig = mod.countOrgHeavyData as unknown as ReturnType<typeof vi.fn>;
    orig.mockImplementationOnce(async () => ({ messages: 0, chunks: 0 })) // org_ok1 finalizes
      .mockImplementationOnce(() => { throw new Error("boom"); }) // org_bad throws
      .mockImplementationOnce(async () => ({ messages: 0, chunks: 0 })); // org_ok2 finalizes
    const purged = await purgeDeletedOrganizations(env());
    expect(purged).toBe(2);
    expect(db.finalized).toEqual(["org_ok1", "org_ok2"]);
  });

  it("deletes each chunk's R2 text copy before its vector and its row, and again after (engram#384)", async () => {
    db.expired = [{ id: "org_chunks" }];
    db.heavy.set("org_chunks", { messages: 0, chunks: 1500, revisions: 0 });
    await purgeDeletedOrganizations(env());
    // The rows are the only record of the copy keys, so the copies go first
    // in every batch: a failure then leaves the rows for the next run. A
    // second pass after the rows are gone removes a copy the chunk-copy job
    // put back in between.
    expect(chunkKeysDeleted).toHaveLength(3000);
    expect(chunkKeysDeleted[0]).toBe("conv_0/c0");
    expect(chunkKeysDeleted[1]).toBe("conv_1/c1");
    // Each batch's second pass names exactly the keys of its first.
    expect(chunkKeysDeleted.slice(1000, 2000)).toEqual(chunkKeysDeleted.slice(0, 1000));
    expect(chunkKeysDeleted.slice(2500, 3000)).toEqual(chunkKeysDeleted.slice(2000, 2500));
    // Vectors go out 100 ids per call, so collapse their repeats into one step.
    const steps = db.order
      .filter((s) => s !== "revisions" && s !== "messages")
      .filter((s, i, all) => !(s === "vectors" && all[i - 1] === "vectors"));
    expect(steps).toEqual([
      "chunk-copies", "vectors", "chunk-rows", "chunk-copies",
      "chunk-copies", "vectors", "chunk-rows", "chunk-copies",
    ]);
    expect(db.finalized).toEqual(["org_chunks"]);
  });

  it("leaves the org's chunk rows for the next run when a copy delete fails", async () => {
    db.expired = [{ id: "org_r2down" }];
    db.heavy.set("org_r2down", { messages: 0, chunks: 10, revisions: 0 });
    const e = env() as unknown as { CHUNKS: { delete: ReturnType<typeof vi.fn> } };
    e.CHUNKS.delete.mockImplementation(async () => { throw new Error("R2 unavailable"); });
    const purged = await purgeDeletedOrganizations(e as never);
    expect(purged).toBe(0);
    expect(db.heavy.get("org_r2down")!.chunks).toBe(10);
    expect(db.order).not.toContain("chunk-rows");
    expect(db.finalized).toEqual([]);
  });

  it("finishes the erasure when only the second copy pass fails", async () => {
    db.expired = [{ id: "org_flaky" }];
    db.heavy.set("org_flaky", { messages: 0, chunks: 10, revisions: 0 });
    const e = env() as unknown as { CHUNKS: { delete: ReturnType<typeof vi.fn> } };
    let calls = 0;
    e.CHUNKS.delete.mockImplementation(async () => {
      calls++;
      if (calls % 2 === 0) throw new Error("R2 unavailable");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const purged = await purgeDeletedOrganizations(e as never);
    expect(purged).toBe(1);
    expect(db.finalized).toEqual(["org_flaky"]);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("second chunk-copy delete failed"));
    err.mockRestore();
  });

  it("drains edit history BEFORE messages, so revision R2 objects are never orphaned", async () => {
    db.expired = [{ id: "org_edited" }];
    db.heavy.set("org_edited", { messages: 10, chunks: 0, revisions: 5 });
    await purgeDeletedOrganizations(env());
    // message_revisions cascades from messages: touching messages first would
    // delete the revision rows and lose the only record of their R2 keys.
    expect(db.order.indexOf("revisions")).toBeGreaterThanOrEqual(0);
    expect(db.order.indexOf("revisions")).toBeLessThan(db.order.indexOf("messages"));
    expect(db.finalized).toContain("org_edited");
  });
});
