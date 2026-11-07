import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  ftsRowid,
  insertConversation,
  orgFtsToken,
  refillChunkText,
  replaceChunks,
  searchChunksFts,
  updateMessageContent,
} from "@getengram/db";
import { chunkId } from "@getengram/shared";
import {
  appendMessages,
  deleteConversation,
  deleteMessage,
  updateMessage,
} from "../services/conversation.js";
import { runChunkMoverBatch, emptyCounts, type ChunkMoverCounts } from "../services/chunk-mover.js";
import { rebuildLostChunk } from "../services/chunk-rebuild.js";
import { scanContentIntegrity } from "../services/content-integrity.js";
import { loadContentOrNull, storeContent } from "../services/content-store.js";
import { searchConversations } from "../services/search.js";
import { moveConversation } from "../routes/merge-orgs.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#567, against real SQLite and real R2 (Miniflare).
 *
 * Once the clear (engram#384 stage 2) has emptied a row's column, the row's
 * R2 object is the only copy of its text. These tests clear rows by hand, as
 * the clear leaves them, break each step of the reindex an edit or a message
 * delete runs, and check that every chunk's text is still somewhere: in its
 * row, or in the object of a row that points at it. Where an object is lost
 * anyway, the mover's verify + repair must rebuild the row from its
 * messages exactly, or leave it alone.
 */

type Bucket = R2Bucket;

describe("reindex and rebuild never lose chunk text (engram#567), against real SQLite and R2", () => {
  let mf: Miniflare;
  let db: D1Database;
  let chunks: Bucket;
  let content: Bucket;
  const vectors = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "reindex-safety" },
      r2Buckets: { CHUNKS: "chunks", CONTENT: "content" },
    });
    db = await mf.getD1Database("DB");
    chunks = (await mf.getR2Bucket("CHUNKS")) as unknown as Bucket;
    content = (await mf.getR2Bucket("CONTENT")) as unknown as Bucket;
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  // ── Fixtures ────────────────────────────────────────────────────────────

  /** The real bucket with chosen methods replaced (Miniflare's bindings do not survive a spread). */
  function bucketWith(over: Partial<Record<"put" | "get" | "head" | "delete" | "list", unknown>> = {}): Bucket {
    return {
      put: (over.put as Bucket["put"]) ?? ((k, v, o) => chunks.put(k, v, o)),
      get: (over.get as Bucket["get"]) ?? ((k: string) => chunks.get(k)),
      head: (over.head as Bucket["head"]) ?? ((k: string) => chunks.head(k)),
      delete: (over.delete as Bucket["delete"]) ?? ((k: string | string[]) => chunks.delete(k)),
      list: (over.list as Bucket["list"]) ?? ((o?: R2ListOptions) => chunks.list(o)),
    } as unknown as Bucket;
  }

  /** D1 that records every statement prepared through it. */
  function recordingDb(seen: string[]): D1Database {
    return {
      prepare(sql: string) {
        seen.push(sql);
        return db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;
  }

  /**
   * D1 that steps into the reindex's swap (replaceChunks), found by the
   * ownership check it opens with. `before` runs once, just before the first
   * swap's transaction; each entry of `fail` makes one swap fail: "before"
   * without running it, "after" once it has committed, as when D1 loses the
   * reply to a request that ran.
   */
  function dbAroundSwap(opts: { fail?: Array<"before" | "after">; before?: () => Promise<void> } = {}) {
    const fail = [...(opts.fail ?? [])];
    const state = { swaps: 0 };
    let armed = false;
    const wrapped = {
      prepare(sql: string) {
        if (sql.startsWith("SELECT EXISTS (SELECT 1 FROM conversations") && sql.endsWith(" AS owned")) armed = true;
        return db.prepare(sql);
      },
      async batch(stmts: D1PreparedStatement[]) {
        if (!armed) return db.batch(stmts);
        armed = false;
        state.swaps++;
        if (state.swaps === 1 && opts.before) await opts.before();
        const f = fail.shift();
        if (f === "before") throw new Error("D1 unavailable (test)");
        const res = await db.batch(stmts);
        if (f === "after") throw new Error("D1 reply lost (test)");
        return res;
      },
    } as unknown as D1Database;
    return { db: wrapped, state };
  }

  function makeEnv(
    over: { CHUNKS?: Bucket; CONTENT?: Bucket; DB?: D1Database; aiDown?: boolean; vectorDeleteFails?: boolean } = {},
  ): Env {
    return {
      DB: over.DB ?? db,
      CHUNKS: over.CHUNKS ?? bucketWith(),
      CONTENT: over.CONTENT ?? content,
      AI: {
        async run(_model: string, input: { text: string[] }) {
          if (over.aiDown) throw new Error("ai down (test)");
          return { data: input.text.map(() => Array(768).fill(0.01)) };
        },
      },
      VECTORIZE: {
        async upsert(vs: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
          for (const v of vs) vectors.set(v.id, v);
          return { mutationId: "m" };
        },
        async deleteByIds(ids: string[]) {
          if (over.vectorDeleteFails) throw new Error("vectorize down (test)");
          for (const id of ids) vectors.delete(id);
          return { mutationId: "m" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async getByIds(ids: string[]) {
          return ids.map((id) => vectors.get(id)).filter(Boolean);
        },
      },
    } as unknown as Env;
  }

  async function addOrg(id: string) {
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
  }

  async function addConversation(org: string, conv: string) {
    await insertConversation(db, conv, org, `title ${conv}`, null, [], {});
  }

  /** `n` short messages, numbered and tagged with `word` so a search can find them. */
  function msgs(n: number, word: string) {
    return Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${word} message number ${i + 1} about the harbour lighthouse`,
    }));
  }

  /**
   * An org with one conversation and `n` messages saved through the real
   * path. Sequences start at 1, so 8 messages make the windows [1..5],
   * [4..8] and [7..8].
   */
  async function seed(org: string, conv: string, n: number, word: string) {
    await addOrg(org);
    await addConversation(org, conv);
    return appendMessages(makeEnv(), org, conv, msgs(n, word));
  }

  type Row = {
    id: string;
    organization_id: string;
    chunk_text: string;
    chunk_encoding: string | null;
    chunk_summary: string | null;
    start_sequence: number;
    end_sequence: number;
  };
  async function chunkRows(conv: string): Promise<Row[]> {
    const res = await db
      .prepare(
        `SELECT id, organization_id, chunk_text, chunk_encoding, chunk_summary, start_sequence, end_sequence
           FROM conversation_chunks WHERE conversation_id = ? ORDER BY start_sequence, end_sequence, id`,
      )
      .bind(conv)
      .all<Row>();
    return res.results ?? [];
  }

  async function objectKeys(prefix: string): Promise<string[]> {
    const listed = await chunks.list({ prefix, limit: 1000 });
    return listed.objects.map((o) => o.key).sort();
  }

  async function objectText(key: string): Promise<string | null> {
    const obj = await chunks.get(key);
    return obj ? obj.text() : null;
  }

  /** What the clear leaves in a row's columns (chunk-clear.d1.test.ts runs the real clear). */
  async function clearRow(id: string) {
    await db
      .prepare("UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = 'r2:raw' WHERE id = ?")
      .bind(id)
      .run();
  }

  async function clearAll(conv: string) {
    for (const r of await chunkRows(conv)) await clearRow(r.id);
  }

  /** A conversation's rows and every object under its prefix. */
  async function snapshot(conv: string) {
    const objects: Record<string, string | null> = {};
    for (const k of await objectKeys(`${conv}/`)) objects[k] = await objectText(k);
    return { rows: await chunkRows(conv), objects };
  }

  /** Keyword-index entries under a chunk's rowid (Miniflare only: never count FTS on prod). */
  async function ftsEntries(id: string): Promise<number> {
    const r = await db
      .prepare("SELECT COUNT(*) AS n FROM chunks_fts_v2 WHERE rowid = ?")
      .bind(ftsRowid(id))
      .first<{ n: number }>();
    return r?.n ?? 0;
  }

  async function keywordHits(word: string, org: string): Promise<string[]> {
    const res = await searchChunksFts(db, word, org, 500);
    return res.results.map((h) => h.chunk_id).sort();
  }

  /** Give a row a pre-engram#349 random id, moving its index entry with it; its old copy goes. */
  async function renameChunk(conv: string, org: string, row: Row, newId: string) {
    await db.batch([
      db
        .prepare("UPDATE conversation_chunks SET id = ?, vectorize_id = ?, fts_rowid = ? WHERE id = ?")
        .bind(newId, newId, ftsRowid(newId), row.id),
      db.prepare("DELETE FROM chunks_fts_v2 WHERE rowid = ?").bind(ftsRowid(row.id)),
      db
        .prepare("INSERT INTO chunks_fts_v2(rowid, chunk_text, org) VALUES (?, ?, ?)")
        .bind(ftsRowid(newId), row.chunk_text, orgFtsToken(org)),
    ]);
    await chunks.delete(`${conv}/${row.id}`);
  }

  const params = (sql: string) => (sql.match(/\?/g) ?? []).length;
  const logged = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

  type Totals = ChunkMoverCounts & { problems: string[]; pages: number };
  async function runAll(
    env: Env,
    opts: { mode: "copy" | "verify"; org?: string; repair?: boolean; limit?: number },
  ): Promise<Totals> {
    const total: Totals = { ...emptyCounts(), problems: [], pages: 0 };
    let after = 0;
    for (let i = 0; i < 1000; i++) {
      const b = await runChunkMoverBatch(env, { ...opts, after });
      for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) total[k] += b[k];
      total.problems.push(...b.problems);
      total.pages++;
      after = b.nextAfter;
      if (b.done) return total;
    }
    throw new Error("mover did not finish");
  }

  /** Every row's text is in its column or its object, and every inline row's copy matches. */
  async function expectNothingLost(org: string) {
    const v = await runAll(makeEnv(), { mode: "verify", org });
    expect(v).toMatchObject({ lost: 0, missing: 0, mismatched: 0 });
    return v;
  }

  // ── The reindex, step by step ───────────────────────────────────────────

  it("an edit whose vector delete fails changes nothing else: every cleared row keeps its copy", async () => {
    const saved = await seed("org_vec", "conv_vec", 8, "avocet");
    await clearAll("conv_vec");
    const before = await snapshot("conv_vec");

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ vectorDeleteFails: true }), "org_vec", "conv_vec", saved[1].id, "rewritten with kestrel");
      expect(logged(errors).some((m) => m.includes(`Failed to reindex after edit of ${saved[1].id}`))).toBe(true);
    } finally {
      errors.mockRestore();
    }

    expect(await snapshot("conv_vec")).toEqual(before);
    expect(await expectNothingLost("org_vec")).toMatchObject({ scanned: 3, clearedOk: 3 });
  });

  it("a swap that fails twice leaves the old rows and their copies exactly as they were", async () => {
    const saved = await seed("org_swapfail", "conv_swapfail", 8, "bittern");
    await clearAll("conv_swapfail");
    const before = await snapshot("conv_swapfail");
    const swap = dbAroundSwap({ fail: ["before", "before"] });

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ DB: swap.db }), "org_swapfail", "conv_swapfail", saved[1].id, "rewritten with kestrel");
      expect(swap.state.swaps).toBe(2);
      expect(logged(warns).some((m) => m.includes("chunk swap for conv_swapfail failed, retrying"))).toBe(true);
      expect(logged(errors).some((m) => m.includes(`Failed to reindex after edit of ${saved[1].id}`))).toBe(true);
    } finally {
      warns.mockRestore();
      errors.mockRestore();
    }

    expect(await snapshot("conv_swapfail")).toEqual(before);
    expect(await expectNothingLost("org_swapfail")).toMatchObject({ clearedOk: 3 });
  });

  it("a swap whose reply is lost after it committed runs again and leaves each new row once", async () => {
    const saved = await seed("org_replay", "conv_replay", 8, "chiffchaff");
    const original = await chunkRows("conv_replay");
    await clearAll("conv_replay");

    // Message 4 sits in [1..5] and [4..8], so the reindex re-chunks all eight
    // messages: every id comes back, [7..8]'s from outside the swapped set.
    let swap = dbAroundSwap({ fail: ["after"] });
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ DB: swap.db }), "org_replay", "conv_replay", saved[3].id, "rewritten with kestrel");
      expect(swap.state.swaps).toBe(2);
    } finally {
      warns.mockRestore();
    }
    let rows = await chunkRows("conv_replay");
    expect(rows.map((r) => r.id)).toEqual(original.map((r) => r.id));
    for (const r of rows) {
      expect(r.chunk_encoding).toBeNull();
      expect(r.chunk_text).not.toContain("number 4 about");
      expect(await objectText(`conv_replay/${r.id}`)).toBe(r.chunk_text);
      expect(await ftsEntries(r.id)).toBe(1);
    }
    expect(await keywordHits("kestrel", "org_replay")).toEqual([original[0].id, original[1].id].sort());
    expect(await keywordHits("chiffchaff", "org_replay")).toEqual(original.map((r) => r.id).sort());
    await expectNothingLost("org_replay");

    // Deleting the last message: [4..8] and [7..8] become [4..7], new ids.
    await clearAll("conv_replay");
    swap = dbAroundSwap({ fail: ["after"] });
    expect(await deleteMessage(makeEnv({ DB: swap.db }), "org_replay", "conv_replay", saved[7].id)).toBe(true);
    expect(swap.state.swaps).toBe(2);
    rows = await chunkRows("conv_replay");
    expect(rows.map((r) => r.id)).toEqual([original[0].id, chunkId("conv_replay", 4, 7, 0)]);
    expect(rows[0]).toMatchObject({ chunk_text: "", chunk_encoding: "r2:raw" });
    expect(rows[1].chunk_encoding).toBeNull();
    expect(await objectKeys("conv_replay/")).toEqual(rows.map((r) => `conv_replay/${r.id}`).sort());
    expect(await objectText(`conv_replay/${rows[1].id}`)).toBe(rows[1].chunk_text);
    for (const r of rows) expect(await ftsEntries(r.id)).toBe(1);
    for (const gone of [original[1].id, original[2].id]) expect(await ftsEntries(gone)).toBe(0);
    expect(await expectNothingLost("org_replay")).toMatchObject({ ok: 1, clearedOk: 1 });
  });

  it("old copies a failed delete leaves behind are orphans for the sweep; no row is left without its text", async () => {
    const saved = await seed("org_orphan", "conv_orphan", 8, "dunlin");
    const original = await chunkRows("conv_orphan");
    await clearAll("conv_orphan");
    // Too long for one chunk: [1..5] is cut into pieces under new ids.
    const oversized = ["kestrel", ...Array.from({ length: 300 }, (_, i) => `filler${i}`)].join(" ");
    expect(oversized.length).toBeGreaterThan(1920);
    const failingDelete = bucketWith({
      delete: async () => {
        throw new Error("R2 delete down (test)");
      },
    });

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ CHUNKS: failingDelete }), "org_orphan", "conv_orphan", saved[1].id, oversized);
      expect(
        logged(errors).some((m) => m.includes("stale chunk copies of conv_orphan not deleted; the orphan sweep removes them")),
      ).toBe(true);
    } finally {
      warns.mockRestore();
      errors.mockRestore();
    }

    const rows = await chunkRows("conv_orphan");
    expect(rows.map((r) => `${r.start_sequence}..${r.end_sequence}`)).toEqual([
      "1..1", "2..2", "2..2", "3..5", "4..5", "4..8", "7..8",
    ]);
    expect(rows.some((r) => r.id === original[0].id)).toBe(false);
    expect(rows.filter((r) => r.chunk_encoding !== null).map((r) => r.id)).toEqual([original[1].id, original[2].id]);
    for (const r of rows.filter((x) => x.chunk_encoding === null)) {
      expect(await objectText(`conv_orphan/${r.id}`)).toBe(r.chunk_text);
    }
    // The replaced window's copy outlived its row: an orphan, not a loss.
    expect(await objectText(`conv_orphan/${original[0].id}`)).toBe(original[0].chunk_text);
    expect(await ftsEntries(original[0].id)).toBe(0);
    expect(await keywordHits("kestrel", "org_orphan")).toEqual([chunkId("conv_orphan", 2, 2, 0)]);
    expect(await expectNothingLost("org_orphan")).toMatchObject({ scanned: 7, ok: 5, clearedOk: 2 });
  });

  it("deleting a message from cleared windows swaps them for inline rows; deleting the only one drops it all", async () => {
    const saved = await seed("org_msgdel", "conv_msgdel", 8, "eider");
    const original = await chunkRows("conv_msgdel");
    await clearAll("conv_msgdel");
    expect(await deleteMessage(makeEnv(), "org_msgdel", "conv_msgdel", saved[7].id)).toBe(true);

    const rows = await chunkRows("conv_msgdel");
    expect(rows.map((r) => r.id)).toEqual([original[0].id, chunkId("conv_msgdel", 4, 7, 0)]);
    expect(rows[0]).toMatchObject({ chunk_text: "", chunk_encoding: "r2:raw" });
    expect(rows[1].chunk_encoding).toBeNull();
    expect(rows[1].chunk_text).not.toContain("number 8 about");
    expect(await objectKeys("conv_msgdel/")).toEqual(rows.map((r) => `conv_msgdel/${r.id}`).sort());
    expect(await objectText(`conv_msgdel/${original[0].id}`)).toBe(original[0].chunk_text);
    expect(await objectText(`conv_msgdel/${rows[1].id}`)).toBe(rows[1].chunk_text);
    expect(await expectNothingLost("org_msgdel")).toMatchObject({ ok: 1, clearedOk: 1 });

    const one = await seed("org_lastmsg", "conv_lastmsg", 1, "fulmar");
    const [only] = await chunkRows("conv_lastmsg");
    await clearAll("conv_lastmsg");
    expect(await deleteMessage(makeEnv(), "org_lastmsg", "conv_lastmsg", one[0].id)).toBe(true);
    expect(await chunkRows("conv_lastmsg")).toEqual([]);
    expect(await objectKeys("conv_lastmsg/")).toEqual([]);
    expect(await ftsEntries(only.id)).toBe(0);
  });

  it("a swap that finds its conversation merged away writes nothing, and every row keeps its text", async () => {
    const saved = await seed("org_racefrom", "conv_racemerge", 8, "gannet");
    await addOrg("org_raceto");
    const original = await chunkRows("conv_racemerge");
    await clearAll("conv_racemerge");
    const raw = makeEnv();
    const swap = dbAroundSwap({
      before: async () => {
        await moveConversation(raw, "conv_racemerge", "org_racefrom", "org_raceto");
      },
    });

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ DB: swap.db }), "org_racefrom", "conv_racemerge", saved[1].id, "rewritten with kestrel");
      expect(swap.state.swaps).toBe(1);
      expect(logged(warns).some((m) => m.includes("conv_racemerge no longer belongs to org_racefrom"))).toBe(true);
    } finally {
      warns.mockRestore();
    }

    const rows = await chunkRows("conv_racemerge");
    expect(rows.map((r) => r.id)).toEqual(original.map((r) => r.id));
    for (const [i, r] of rows.entries()) {
      expect(r).toMatchObject({ organization_id: "org_raceto", chunk_text: "", chunk_encoding: "r2:raw" });
      expect(await objectText(`conv_racemerge/${r.id}`)).toBe(original[i].chunk_text);
    }
    expect(await objectKeys("conv_racemerge/")).toEqual(original.map((r) => `conv_racemerge/${r.id}`).sort());
    expect(await keywordHits("gannet", "org_raceto")).toEqual(original.map((r) => r.id).sort());
    expect(await keywordHits("kestrel", "org_raceto")).toEqual([]);
    expect(await keywordHits("gannet", "org_racefrom")).toEqual([]);
    expect(await expectNothingLost("org_raceto")).toMatchObject({ clearedOk: 3 });
  });

  it("a swap that finds its conversation deleted writes nothing back: no row, copy or index entry", async () => {
    const saved = await seed("org_racedel", "conv_racedel", 8, "godwit");
    const original = await chunkRows("conv_racedel");
    await clearAll("conv_racedel");
    const raw = makeEnv();
    let deleted: boolean | undefined;
    const swap = dbAroundSwap({
      before: async () => {
        deleted = await deleteConversation(raw, "org_racedel", "conv_racedel");
      },
    });

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ DB: swap.db }), "org_racedel", "conv_racedel", saved[1].id, "rewritten with kestrel");
      expect(swap.state.swaps).toBe(1);
    } finally {
      warns.mockRestore();
    }

    expect(deleted).toBe(true);
    expect(await chunkRows("conv_racedel")).toEqual([]);
    expect(await objectKeys("conv_racedel/")).toEqual([]);
    for (const id of [...original.map((r) => r.id), chunkId("conv_racedel", 4, 5, 0)]) {
      expect(await ftsEntries(id)).toBe(0);
    }
  });

  // ── D1's 100-parameter limit ────────────────────────────────────────────

  it("an append of more than 100 chunks indexes every one, in statements D1 accepts", async () => {
    await addOrg("org_bigappend");
    await addConversation("org_bigappend", "conv_bigappend");
    const seen: string[] = [];
    await appendMessages(makeEnv({ DB: recordingDb(seen) }), "org_bigappend", "conv_bigappend", msgs(330, "harrier"));

    expect(seen.filter((s) => params(s) > 100)).toEqual([]);
    const rows = await chunkRows("conv_bigappend");
    expect(rows.length).toBe(110);
    for (const r of rows) expect(await ftsEntries(r.id)).toBe(1);
    expect(await keywordHits("harrier", "org_bigappend")).toEqual(rows.map((r) => r.id).sort());
  }, 30_000);

  it("a swap of more than 90 chunks stays within D1's limit, replaces every one, and can run twice", async () => {
    await seed("org_wide", "conv_wide", 330, "ibis");
    const old = await chunkRows("conv_wide");
    expect(old.length).toBe(110);
    const fresh = Array.from({ length: 100 }, (_, i) => ({
      id: `chk_conv_wide_swap_${i}`,
      chunkText: `osprey replacement piece ${i}`,
      chunkSummary: `osprey replacement piece ${i}`,
      startSequence: i + 1,
      endSequence: i + 1,
      vectorizeId: `chk_conv_wide_swap_${i}`,
    }));

    for (let run = 0; run < 2; run++) {
      const seen: string[] = [];
      const res = await replaceChunks(recordingDb(seen), "conv_wide", "org_wide", old.map((r) => r.id), fresh);
      expect(res.owned).toBe(true);
      expect(seen.filter((s) => params(s) > 100)).toEqual([]);
      expect(seen.filter((s) => s.startsWith("DELETE FROM conversation_chunks")).length).toBe(2);
      expect((await chunkRows("conv_wide")).map((r) => r.id).sort()).toEqual(fresh.map((c) => c.id).sort());
      expect(await keywordHits("osprey", "org_wide")).toEqual(fresh.map((c) => c.id).sort());
      expect(await keywordHits("ibis", "org_wide")).toEqual([]);
      for (const r of old) expect(await ftsEntries(r.id)).toBe(0);
    }
  }, 30_000);

  it("a swap that writes over a row outside the replaced set leaves none of that row's old words in keyword search", async () => {
    await seed("org_over", "conv_over", 8, "dunlin");
    const rows = await chunkRows("conv_over");
    // [7..8] is not in the replaced set, as when a reindex re-chunks past
    // the windows it replaces, and its row is written over with new words.
    const outside = rows[2];
    expect([outside.start_sequence, outside.end_sequence]).toEqual([7, 8]);
    const res = await replaceChunks(db, "conv_over", "org_over", [rows[0].id], [
      {
        id: outside.id,
        chunkText: "plover rewritten piece",
        chunkSummary: "plover rewritten piece",
        startSequence: 7,
        endSequence: 8,
        vectorizeId: outside.id,
      },
    ]);
    expect(res.owned).toBe(true);
    expect((await chunkRows("conv_over")).map((r) => r.id)).toEqual([rows[1].id, outside.id]);
    expect(await keywordHits("plover", "org_over")).toEqual([outside.id]);
    // FTS5 takes a second entry under a rowid it already holds and keeps the
    // first, so without its delete the old words would still find this row.
    expect(await keywordHits("dunlin", "org_over")).toEqual([rows[1].id]);
    expect(await ftsEntries(outside.id)).toBe(1);
  });

  // ── Rebuilding a lost row ───────────────────────────────────────────────

  it("verify finds a lost row; verify + repair rebuilds it from its messages, exactly, and puts its copy back", async () => {
    await seed("org_rebuild", "conv_rebuild", 8, "jacana");
    const rows = await chunkRows("conv_rebuild");
    expect(rows.length).toBe(3);
    await clearAll("conv_rebuild");
    const target = rows[1];
    await chunks.delete(`conv_rebuild/${target.id}`);
    const env = makeEnv({ aiDown: true });

    const plain = await runAll(env, { mode: "verify", org: "org_rebuild" });
    expect(plain).toMatchObject({ clearedOk: 2, lost: 1, rebuilt: 0 });
    expect(plain.problems).toEqual([target.id]);
    expect((await chunkRows("conv_rebuild"))[1]).toMatchObject({ chunk_text: "", chunk_encoding: "r2:raw" });
    expect(await objectText(`conv_rebuild/${target.id}`)).toBeNull();

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repaired = await runAll(env, { mode: "verify", org: "org_rebuild", repair: true });
      expect(repaired).toMatchObject({ clearedOk: 2, lost: 1, rebuilt: 1, repaired: 0, raced: 0, putFailed: 0 });
      expect(logged(warns).filter((m) => m.includes("does not match"))).toEqual([]);
    } finally {
      warns.mockRestore();
    }

    // The text, and the summary saved with it, as they were before the clear.
    expect((await chunkRows("conv_rebuild"))[1]).toEqual(target);
    expect(await objectText(`conv_rebuild/${target.id}`)).toBe(target.chunk_text);
    expect(await ftsEntries(target.id)).toBe(1);
    expect(await expectNothingLost("org_rebuild")).toMatchObject({ ok: 1, clearedOk: 2 });

    // Scoped to the conversation, so search returns every window, not its best one.
    const hits = await searchConversations(env, "org_rebuild", "jacana", 10, "conv_rebuild", undefined, 2000, 0);
    expect(hits.map((h) => h.chunk_id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect(hits.find((h) => h.chunk_id === target.id)?.chunk_text).toBe(target.chunk_text);
  });

  it("a lost row is not rebuilt when a message in its window has no readable body", async () => {
    const saved = await seed("org_nobody", "conv_nobody", 8, "kittiwake");
    const rows = await chunkRows("conv_nobody");
    await clearAll("conv_nobody");
    const target = rows[1]; // [4..8]
    await chunks.delete(`conv_nobody/${target.id}`);
    await content.delete(`content/${saved[5].id}`); // message 6

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runAll(makeEnv(), { mode: "verify", org: "org_nobody", repair: true });
      expect(res).toMatchObject({ clearedOk: 2, lost: 1, rebuilt: 0 });
      expect(
        logged(errors).some(
          (m) => m.includes(`lost chunk ${target.id} not rebuilt`) && m.includes(`message ${saved[5].id} has no readable body`),
        ),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }
    expect((await chunkRows("conv_nobody"))[1]).toMatchObject({ id: target.id, chunk_text: "", chunk_encoding: "r2:raw" });
    expect(await objectText(`conv_nobody/${target.id}`)).toBeNull();
  });

  it("a row left stale by a failed reindex, then lost, is rebuilt from its messages as they are now, and says so", async () => {
    const saved = await seed("org_stale", "conv_stale", 8, "lapwing");
    const rows = await chunkRows("conv_stale");
    await clearAll("conv_stale");

    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await updateMessage(makeEnv({ vectorDeleteFails: true }), "org_stale", "conv_stale", saved[1].id, "rewritten with kestrel");
      await chunks.delete(`conv_stale/${rows[0].id}`);
      const res = await runAll(makeEnv(), { mode: "verify", org: "org_stale", repair: true });
      expect(res).toMatchObject({ clearedOk: 2, lost: 1, rebuilt: 1 });
      expect(
        logged(warns).some((m) => m.includes(`rebuilt lost chunk ${rows[0].id}; its stored summary does not match`)),
      ).toBe(true);
    } finally {
      warns.mockRestore();
      errors.mockRestore();
    }

    const [now] = await chunkRows("conv_stale");
    expect(now).toMatchObject({ id: rows[0].id, chunk_encoding: null });
    expect(now.chunk_text).toContain("rewritten with kestrel");
    expect(now.chunk_text).not.toContain("number 2 about");
    expect(await objectText(`conv_stale/${now.id}`)).toBe(now.chunk_text);
  });

  it("the refill writes only into a row still cleared, in its conversation and organization", async () => {
    await seed("org_cas", "conv_cas", 8, "merlin");
    await addOrg("org_cas_other");
    const rows = await chunkRows("conv_cas");
    const [inline, cleared] = [rows[0], rows[1]];
    await clearRow(cleared.id);
    const refill = (
      over: Partial<{ id: string; conversationId: string; organizationId: string; text: string }> = {},
      encoding = "r2:raw",
    ) =>
      refillChunkText(
        db,
        {
          id: cleared.id,
          conversationId: "conv_cas",
          organizationId: "org_cas",
          text: cleared.chunk_text,
          summary: cleared.chunk_summary ?? "",
          ...over,
        },
        encoding,
      );

    expect(await refill({ id: inline.id, text: "something else entirely" })).toBe(false);
    expect(await refill({ id: inline.id, text: inline.chunk_text })).toBe(false);
    expect(await refill({}, "r2:other")).toBe(false);
    expect(await refill({ conversationId: "conv_cas_other" })).toBe(false);
    expect(await refill({ organizationId: "org_cas_other" })).toBe(false);
    await expect(refill({}, "gzip")).rejects.toThrow(/refusing to refill/);
    expect((await chunkRows("conv_cas"))[0]).toEqual(inline);
    expect((await chunkRows("conv_cas"))[1]).toMatchObject({ chunk_text: "", chunk_encoding: "r2:raw" });
    expect(await keywordHits("merlin", "org_cas")).toEqual(rows.map((r) => r.id).sort());
    expect(await keywordHits("merlin", "org_cas_other")).toEqual([]);

    // Given text while still marked (as an older deployment's write can
    // leave it): the column holds text, which the refill never replaces.
    await db.prepare("UPDATE conversation_chunks SET chunk_text = ? WHERE id = ?").bind("written meanwhile", cleared.id).run();
    expect(await refill()).toBe(false);
    expect((await chunkRows("conv_cas"))[1]).toMatchObject({ chunk_text: "written meanwhile", chunk_encoding: "r2:raw" });
    await clearRow(cleared.id);

    expect(await refill()).toBe(true);
    expect(await refill()).toBe(false);
    expect((await chunkRows("conv_cas"))[1]).toEqual(cleared);
    expect(await ftsEntries(cleared.id)).toBe(1);

    expect(await rebuildLostChunk(makeEnv(), inline.id)).toEqual({ status: "gone" });
    expect(await rebuildLostChunk(makeEnv(), cleared.id)).toEqual({ status: "gone" });
    expect(await rebuildLostChunk(makeEnv(), chunkId("conv_cas", 90, 94, 0))).toEqual({ status: "gone" });
  });

  it("a refill for an organization the row has left changes nothing, not even its index entry", async () => {
    await seed("org_left", "conv_left", 3, "moorhen");
    await addOrg("org_joined");
    await moveConversation(makeEnv(), "conv_left", "org_left", "org_joined");
    const [row] = await chunkRows("conv_left");
    expect(row.organization_id).toBe("org_joined");

    const refilled = await refillChunkText(
      db,
      { id: row.id, conversationId: "conv_left", organizationId: "org_left", text: row.chunk_text, summary: row.chunk_summary ?? "" },
      "r2:raw",
    );
    expect(refilled).toBe(false);
    expect(await keywordHits("moorhen", "org_joined")).toEqual([row.id]);
    expect(await keywordHits("moorhen", "org_left")).toEqual([]);
  });

  it("a lost row with a pre-#349 random id is matched by its window, or by its summary where the window was split", async () => {
    // One piece in its window.
    await seed("org_legacy", "conv_legacy", 8, "nightjar");
    const windowRows = await chunkRows("conv_legacy");
    const windowed = { ...windowRows[1], id: "chk_V1StGXR8Z5jdHi6B" };
    await renameChunk("conv_legacy", "org_legacy", windowRows[1], windowed.id);

    // One message long enough to be cut into three pieces of the same window.
    await addConversation("org_legacy", "conv_legacysplit");
    const big = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    await appendMessages(makeEnv(), "org_legacy", "conv_legacysplit", [{ role: "user", content: big }]);
    const pieces = await chunkRows("conv_legacysplit");
    expect(pieces.map((p) => `${p.start_sequence}..${p.end_sequence}`)).toEqual(["1..1", "1..1", "1..1"]);
    const middle = { ...pieces[1], id: "chk_8Lq3TzP0aWmXy2Rc" };
    await renameChunk("conv_legacysplit", "org_legacy", pieces[1], middle.id);

    // An id of today's form that names no piece of its window is not guessed at.
    await addConversation("org_legacy", "conv_legacyodd");
    await appendMessages(makeEnv(), "org_legacy", "conv_legacyodd", msgs(8, "nuthatch"));
    const oddRows = await chunkRows("conv_legacyodd");
    const misnamed = { ...oddRows[1], id: chunkId("conv_legacyodd", 4, 8, 5) };
    await renameChunk("conv_legacyodd", "org_legacy", oddRows[1], misnamed.id);

    const lostOnes: Array<[string, string]> = [
      ["conv_legacy", windowed.id],
      ["conv_legacysplit", middle.id],
      ["conv_legacyodd", misnamed.id],
    ];
    for (const [conv, id] of lostOnes) {
      await clearRow(id);
      await chunks.delete(`${conv}/${id}`);
    }

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await runAll(makeEnv(), { mode: "verify", org: "org_legacy", repair: true });
      expect(res).toMatchObject({ lost: 3, rebuilt: 2 });
      expect(
        logged(errors).some((m) => m.includes(`lost chunk ${misnamed.id} not rebuilt: no re-chunked piece is this row's`)),
      ).toBe(true);
    } finally {
      errors.mockRestore();
    }

    const now = new Map(
      [
        ...(await chunkRows("conv_legacy")),
        ...(await chunkRows("conv_legacysplit")),
        ...(await chunkRows("conv_legacyodd")),
      ].map((r) => [r.id, r]),
    );
    expect(now.get(windowed.id)).toEqual(windowed);
    expect(now.get(middle.id)).toEqual(middle);
    expect(now.get(misnamed.id)).toMatchObject({ chunk_text: "", chunk_encoding: "r2:raw" });
    expect(await objectText(`conv_legacy/${windowed.id}`)).toBe(windowed.chunk_text);
    expect(await objectText(`conv_legacysplit/${middle.id}`)).toBe(middle.chunk_text);
    expect(await objectText(`conv_legacyodd/${misnamed.id}`)).toBeNull();
  });

  // ── A missing message body (engram#572) ─────────────────────────────────
  //
  // When a message's body object is gone, the chunks covering it may be the
  // last place its words are, and the content-integrity repair (engram#541)
  // rebuilds the body from exactly that text. An edit or delete re-chunks
  // the window and replaces those chunks, so it must rebuild a missing body
  // first, and when it cannot, keep the chunks.

  const PLACEHOLDER = "[Message content unavailable";
  const said = (word: string, n: number) => `${word} message number ${n} about the harbour lighthouse`;

  /** Like seed, with each message's role chosen. */
  async function seedRoles(org: string, conv: string, roles: Array<"user" | "assistant">, word: string) {
    await addOrg(org);
    await addConversation(org, conv);
    return appendMessages(
      makeEnv(),
      org,
      conv,
      roles.map((role, i) => ({ role, content: said(word, i + 1) })),
    );
  }

  /** A message's stored body: null when its object is missing, undefined when its row is gone. */
  async function storedBody(id: string): Promise<string | null | undefined> {
    const row = await db
      .prepare("SELECT id, content, content_encoding FROM messages WHERE id = ?")
      .bind(id)
      .first<{ id: string; content: string; content_encoding: string | null }>();
    if (!row) return undefined;
    return loadContentOrNull(makeEnv(), row);
  }

  /** Every chunk's text, from its column or, once cleared, its object. */
  async function chunkTexts(conv: string): Promise<string[]> {
    const out: string[] = [];
    for (const r of await chunkRows(conv)) {
      out.push(r.chunk_text !== "" ? r.chunk_text : ((await objectText(`${conv}/${r.id}`)) ?? "<no copy>"));
    }
    return out;
  }

  async function audited(org: string, action: string) {
    const res = await db
      .prepare("SELECT api_key_id, resource_id, metadata FROM audit_log WHERE organization_id = ? AND action = ?")
      .bind(org, action)
      .all<{ api_key_id: string | null; resource_id: string; metadata: string }>();
    return (res.results ?? []).map((r) => ({ ...r, metadata: JSON.parse(r.metadata) as Record<string, unknown> }));
  }

  /**
   * CONTENT whose first put of `key` runs `first` instead: throw to fail it,
   * as when R2 is briefly down, or step in ahead of it and return nothing to
   * let it go through.
   */
  function contentAroundFirstPut(key: string, first: (o?: R2PutOptions) => Promise<void>): Bucket {
    let done = false;
    return {
      put: async (k: string, v: string, o?: R2PutOptions) => {
        if (k === key && !done) {
          done = true;
          await first(o);
        }
        return content.put(k, v, o);
      },
      get: (k: string) => content.get(k),
      head: (k: string) => content.head(k),
      delete: (k: string | string[]) => content.delete(k),
      list: (o?: R2ListOptions) => content.list(o),
    } as unknown as Bucket;
  }

  /** Runs `fn` with the console quiet, handing back what was logged at each level. */
  async function quietly(fn: () => Promise<unknown>) {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    try {
      await fn();
      return { log: logged(spies.log), warn: logged(spies.warn), error: logged(spies.error) };
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  }

  it.each([false, true])(
    "an edit rebuilds a neighbour's missing body from the old chunks before it replaces them (cleared: %s)",
    async (cleared) => {
      const org = `org_mb_edit_${cleared}`;
      const conv = `conv_mb_edit_${cleared}`;
      const saved = await seed(org, conv, 8, "plover");
      if (cleared) await clearAll(conv);
      await content.delete(`content/${saved[5].id}`); // message 6, in [4..8] only

      // Message 5 sits in [1..5] and [4..8]: the edit re-chunks all eight.
      await quietly(() => updateMessage(makeEnv(), org, conv, saved[4].id, "rewritten with kestrel"));

      expect(await storedBody(saved[5].id)).toBe(said("plover", 6));
      const texts = await chunkTexts(conv);
      expect(texts.filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
      expect(texts.filter((t) => t.includes(`[assistant]: ${said("plover", 6)}`))).toHaveLength(1);
      expect(texts.some((t) => t.includes("rewritten with kestrel"))).toBe(true);
      expect(await audited(org, "message.restore")).toEqual([
        {
          api_key_id: null,
          resource_id: saved[5].id,
          metadata: {
            conversation_id: conv,
            sequence: 6,
            source_chunk: chunkId(conv, 4, 8, 0),
            chars: said("plover", 6).length,
          },
        },
      ]);
      expect(await audited(org, "index.reindex_kept")).toEqual([]);
      await expectNothingLost(org);
    },
  );

  it.each([false, true])(
    "a delete rebuilds a neighbour's missing body before it removes anything, and none of the deleted text goes into it (cleared: %s)",
    async (cleared) => {
      const org = `org_mb_del_${cleared}`;
      const conv = `conv_mb_del_${cleared}`;
      // Messages 5 and 6 are both the user's. Once 5's row is gone, its part
      // of [4..8] could pass for the start of 6's.
      const saved = await seedRoles(
        org,
        conv,
        ["user", "assistant", "user", "assistant", "user", "user", "assistant", "user"],
        "redshank",
      );
      if (cleared) await clearAll(conv);
      await content.delete(`content/${saved[5].id}`); // message 6

      let deleted: boolean | undefined;
      await quietly(async () => {
        deleted = await deleteMessage(makeEnv(), org, conv, saved[4].id);
      });
      expect(deleted).toBe(true);

      expect(await storedBody(saved[5].id)).toBe(said("redshank", 6));
      expect(await storedBody(saved[4].id)).toBeUndefined();
      const texts = await chunkTexts(conv);
      expect(texts.filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
      expect(texts.filter((t) => t.includes("number 5 about"))).toEqual([]);
      expect(texts.some((t) => t.includes(`[user]: ${said("redshank", 6)}`))).toBe(true);
      expect((await audited(org, "message.restore")).map((a) => a.resource_id)).toEqual([saved[5].id]);
      expect(await audited(org, "index.reindex_kept")).toEqual([]);
      await expectNothingLost(org);
    },
  );

  it("bodies that can only be rebuilt one after another all are: the narrow window first", async () => {
    const saved = await seed("org_mb_chain", "conv_mb_chain", 8, "sanderling");
    await clearAll("conv_mb_chain");
    // 6 is only in [4..8], which needs 7's body; 7 is also in [7..8], which
    // needs only 8's.
    await content.delete(`content/${saved[5].id}`);
    await content.delete(`content/${saved[6].id}`);

    await quietly(() => updateMessage(makeEnv(), "org_mb_chain", "conv_mb_chain", saved[7].id, "rewritten with kestrel"));

    expect(await storedBody(saved[5].id)).toBe(said("sanderling", 6));
    expect(await storedBody(saved[6].id)).toBe(said("sanderling", 7));
    expect((await chunkTexts("conv_mb_chain")).filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
    expect(await audited("org_mb_chain", "index.reindex_kept")).toEqual([]);
  });

  it.each(["edit", "delete"] as const)(
    "a %s keeps the window's chunks, untouched, when a body in it cannot be rebuilt, and records which",
    async (trigger) => {
      const org = `org_mb_keep_${trigger}`;
      const conv = `conv_mb_keep_${trigger}`;
      const saved = await seed(org, conv, 8, "whimbrel");
      await clearAll(conv);
      // 4 and 5 are in [1..5] and [4..8] together, and each rebuild needs the
      // other's body: neither can be rebuilt.
      await content.delete(`content/${saved[3].id}`);
      await content.delete(`content/${saved[4].id}`);
      const before = await snapshot(conv);

      // Message 2 is in [1..5] only.
      const logs = await quietly(() =>
        trigger === "edit"
          ? updateMessage(makeEnv(), org, conv, saved[1].id, "rewritten with kestrel")
          : deleteMessage(makeEnv(), org, conv, saved[1].id),
      );
      expect(
        logs.error.some((m) => m.includes(`kept 1 chunk(s) of ${conv} after the ${trigger} of ${saved[1].id}`)),
      ).toBe(true);

      expect(await snapshot(conv)).toEqual(before);
      expect(await storedBody(saved[1].id)).toBe(trigger === "edit" ? "rewritten with kestrel" : undefined);
      expect(await storedBody(saved[3].id)).toBeNull();
      expect(await storedBody(saved[4].id)).toBeNull();
      expect(await audited(org, "index.reindex_kept")).toEqual([
        {
          api_key_id: null,
          resource_id: conv,
          metadata: {
            trigger,
            message_id: saved[1].id,
            unreadable: [saved[3].id, saved[4].id],
            kept_chunks: [chunkId(conv, 1, 5, 0)],
          },
        },
      ]);
      expect(await audited(org, "message.restore")).toEqual([]);
      await expectNothingLost(org);
    },
  );

  it.each([false, true])(
    "an edit of a message whose own body is missing archives its real previous wording (writing the rebuilt body fails: %s)",
    async (putFails) => {
      const org = `org_mb_self_${putFails}`;
      const conv = `conv_mb_self_${putFails}`;
      const saved = await seed(org, conv, 8, "greenshank");
      await clearAll(conv);
      await content.delete(`content/${saved[1].id}`); // message 2
      // The rebuilt wording is what the edit archives, whether or not R2
      // takes it back in the meantime.
      const env = makeEnv(
        putFails
          ? {
              CONTENT: contentAroundFirstPut(`content/${saved[1].id}`, () =>
                Promise.reject(new Error("R2 unavailable (test)")),
              ),
            }
          : {},
      );

      await quietly(() => updateMessage(env, org, conv, saved[1].id, "rewritten with kestrel"));
      expect((await audited(org, "message.restore")).map((a) => a.resource_id)).toEqual(
        putFails ? [] : [saved[1].id],
      );

      const revs = await db
        .prepare("SELECT id, content, content_encoding FROM message_revisions WHERE message_id = ?")
        .bind(saved[1].id)
        .all<{ id: string; content: string; content_encoding: string | null }>();
      expect(revs.results).toHaveLength(1);
      expect(await loadContentOrNull(makeEnv(), revs.results[0])).toBe(said("greenshank", 2));
      expect(await storedBody(saved[1].id)).toBe("rewritten with kestrel");
      const texts = await chunkTexts(conv);
      expect(texts.filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
      expect(texts.filter((t) => t.includes("number 2 about"))).toEqual([]);
      expect(texts.some((t) => t.includes("rewritten with kestrel"))).toBe(true);
    },
  );

  it("a body an edit writes while a reindex rebuilds it is never replaced, and its row stays the edit's", async () => {
    const org = "org_mb_race";
    const conv = "conv_mb_race";
    const saved = await seed(org, conv, 8, "avocet");
    await clearAll(conv);
    await content.delete(`content/${saved[5].id}`); // message 6, in [4..8] only
    // Long enough to be stored gzipped, where the old wording was not.
    const editedText = "edited meanwhile with stilt and turnstone. ".repeat(8);
    let edited: { content: string; encoding: string | null } | undefined;
    // An edit of message 6 stores its new body just before the rebuilt one
    // is written back, the way updateMessage does.
    const racing = contentAroundFirstPut(`content/${saved[5].id}`, async (o) => {
      expect(o?.onlyIf).toBeDefined();
      edited = await storeContent(makeEnv(), saved[5].id, editedText);
      await updateMessageContent(db, saved[5].id, org, edited.content, edited.encoding);
    });

    // Message 5 sits in [1..5] and [4..8]: the edit re-chunks all eight.
    const logs = await quietly(() =>
      updateMessage(makeEnv({ CONTENT: racing }), org, conv, saved[4].id, "rewritten with kestrel"),
    );

    expect(edited?.encoding).toBe("r2:gzip+base64");
    expect(await storedBody(saved[5].id)).toBe(editedText);
    expect(
      await db.prepare("SELECT content, content_encoding FROM messages WHERE id = ?").bind(saved[5].id).first(),
    ).toEqual({ content: edited!.content, content_encoding: edited!.encoding });
    expect(await storedBody(saved[4].id)).toBe("rewritten with kestrel");
    expect(await audited(org, "message.restore")).toEqual([]);
    expect(logs.warn.some((m) => m.includes(saved[5].id) && m.includes("written to it while it was rebuilt"))).toBe(
      true,
    );
    await expectNothingLost(org);
  });

  it("a delete rebuilds its own missing body when a neighbour's rebuild needs it, then removes it", async () => {
    const saved = await seed("org_mb_step", "conv_mb_step", 8, "godwit");
    await clearAll("conv_mb_step");
    // 6 is only in [4..8], whose rebuild needs 4's body; 4's can be rebuilt
    // from [1..5].
    await content.delete(`content/${saved[3].id}`);
    await content.delete(`content/${saved[5].id}`);

    let deleted: boolean | undefined;
    await quietly(async () => {
      deleted = await deleteMessage(makeEnv(), "org_mb_step", "conv_mb_step", saved[3].id);
    });
    expect(deleted).toBe(true);

    expect(await storedBody(saved[5].id)).toBe(said("godwit", 6));
    expect(await storedBody(saved[3].id)).toBeUndefined();
    expect(await content.head(`content/${saved[3].id}`)).toBeNull();
    const texts = await chunkTexts("conv_mb_step");
    expect(texts.filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
    expect(texts.filter((t) => t.includes("number 4 about"))).toEqual([]);
    expect(texts.some((t) => t.includes(said("godwit", 6)))).toBe(true);
    expect((await audited("org_mb_step", "message.restore")).map((a) => a.resource_id).sort()).toEqual(
      [saved[3].id, saved[5].id].sort(),
    );
    expect(await audited("org_mb_step", "index.reindex_kept")).toEqual([]);
  });

  it("a delete leaves its own missing body alone when no other rebuild needs it", async () => {
    const saved = await seed("org_mb_noneed", "conv_mb_noneed", 8, "dunlin");
    await clearAll("conv_mb_noneed");
    // 7 comes back from [7..8] alone, so 4's body is never needed.
    await content.delete(`content/${saved[3].id}`);
    await content.delete(`content/${saved[6].id}`);

    await quietly(() => deleteMessage(makeEnv(), "org_mb_noneed", "conv_mb_noneed", saved[3].id));

    expect(await storedBody(saved[6].id)).toBe(said("dunlin", 7));
    expect(await storedBody(saved[3].id)).toBeUndefined();
    expect(await content.head(`content/${saved[3].id}`)).toBeNull();
    const texts = await chunkTexts("conv_mb_noneed");
    expect(texts.filter((t) => t.includes(PLACEHOLDER))).toEqual([]);
    expect(texts.filter((t) => t.includes("number 4 about"))).toEqual([]);
    expect((await audited("org_mb_noneed", "message.restore")).map((a) => a.resource_id)).toEqual([saved[6].id]);
    expect(await audited("org_mb_noneed", "index.reindex_kept")).toEqual([]);
  });

  it("a deleted neighbour's text left in a stale chunk is never rebuilt into a message's body", async () => {
    const saved = await seedRoles(
      "org_mb_stale",
      "conv_mb_stale",
      ["user", "assistant", "user", "assistant", "user", "user", "assistant", "user"],
      "stint",
    );
    // A delete whose reindex fails leaves [4..8] holding message 5's text,
    // with no row for 5. Message 6 is next to it, and the user's too.
    const del = await quietly(() =>
      deleteMessage(makeEnv({ vectorDeleteFails: true }), "org_mb_stale", "conv_mb_stale", saved[4].id),
    );
    expect(del.error.some((m) => m.includes(`Failed to reindex after delete of ${saved[4].id}`))).toBe(true);
    await content.delete(`content/${saved[5].id}`);

    let scan: Awaited<ReturnType<typeof scanContentIntegrity>> | undefined;
    await quietly(async () => {
      scan = await scanContentIntegrity(makeEnv(), { organizationId: "org_mb_stale", repair: true });
    });
    expect(scan?.repaired).toEqual([]);
    expect(scan?.unrecoverable).toEqual([
      expect.objectContaining({
        id: saved[5].id,
        reason: expect.stringContaining("may hold the deleted message's text"),
      }),
    ]);

    // An edit in the same window keeps its chunks rather than chunk a guess.
    const before = await snapshot("conv_mb_stale");
    await quietly(() => updateMessage(makeEnv(), "org_mb_stale", "conv_mb_stale", saved[7].id, "rewritten with kestrel"));
    expect(await snapshot("conv_mb_stale")).toEqual(before);
    expect(await storedBody(saved[5].id)).toBeNull();
    expect(await audited("org_mb_stale", "message.restore")).toEqual([]);
    expect(await audited("org_mb_stale", "admin.message.restore")).toEqual([]);
    expect((await audited("org_mb_stale", "index.reindex_kept")).map((a) => a.metadata.unreadable)).toEqual([
      [saved[5].id],
    ]);
  });

  it("the guard refuses only both marks together: a gap alone, or a quoted transcript alone, still rebuilds", async () => {
    const saved = await seedRoles(
      "org_mb_bound",
      "conv_mb_bound",
      ["user", "assistant", "user", "assistant", "user", "user", "assistant", "user"],
      "turnstone",
    );
    // A pasted transcript, but with no neighbour deleted next to it.
    const quoted = "as pasted:\n[user]: is the lighthouse open\n[assistant]: on weekends";
    await quietly(() => updateMessage(makeEnv(), "org_mb_bound", "conv_mb_bound", saved[1].id, quoted));
    await content.delete(`content/${saved[1].id}`);
    await quietly(() => updateMessage(makeEnv(), "org_mb_bound", "conv_mb_bound", saved[2].id, "rewritten with kestrel"));
    expect(await storedBody(saved[1].id)).toBe(quoted);

    // A neighbour deleted and its window re-chunked as it should be: 6 is
    // next to the gap, and its plain body comes back.
    await quietly(() => deleteMessage(makeEnv(), "org_mb_bound", "conv_mb_bound", saved[4].id));
    await content.delete(`content/${saved[5].id}`);
    await quietly(() => updateMessage(makeEnv(), "org_mb_bound", "conv_mb_bound", saved[7].id, "rewritten with merlin"));
    expect(await storedBody(saved[5].id)).toBe(said("turnstone", 6));
    expect(await audited("org_mb_bound", "index.reindex_kept")).toEqual([]);
    expect((await audited("org_mb_bound", "message.restore")).map((a) => a.resource_id)).toEqual([
      saved[1].id,
      saved[5].id,
    ]);
  });
});
