import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Miniflare } from "miniflare";
import { insertConversation } from "@getengram/db";
import { appendMessages } from "../services/conversation.js";
import { chunkObjectKey } from "../services/chunk-store.js";
import {
  emptyCounts,
  runOrphanSweepBatch,
  ORPHAN_SETTLE_MS,
  type ChunkMoverCounts,
} from "../services/chunk-mover.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#557: the orphan sweep, against real SQLite and real R2 (Miniflare).
 * Its own database and bucket, the bucket emptied before each test, because
 * the sweep lists all of it and every count depends on what is there.
 *
 * Most of these are about what it must never delete: an object a row still
 * points at (cleared or not), one written inside the settle window, one
 * under a key the save path does not make, one whose row is in another
 * conversation, one that changed or whose row came back between the
 * judgment and the delete — and never more than the run's cap.
 */

const ORPHAN_LOOKUP = "SELECT id, conversation_id FROM conversation_chunks";

describe("chunk orphan sweep (engram#557), against real SQLite and R2", () => {
  let mf: Miniflare;
  let db: D1Database;
  let chunks: R2Bucket;
  let content: R2Bucket;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "chunk-orphan-sweep" },
      r2Buckets: { CHUNKS: "orphan-chunks", CONTENT: "orphan-content" },
    });
    db = await mf.getD1Database("DB");
    chunks = (await mf.getR2Bucket("CHUNKS")) as unknown as R2Bucket;
    content = (await mf.getR2Bucket("CONTENT")) as unknown as R2Bucket;
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    for (;;) {
      const listed = await chunks.list({ limit: 1000 });
      if (listed.objects.length === 0) break;
      await chunks.delete(listed.objects.map((o) => o.key));
    }
  });

  // ── Fixtures ────────────────────────────────────────────────────────────

  /** The real bucket with chosen methods replaced. Explicit forwarding: Miniflare's bindings are proxies. */
  function bucketWith(over: Partial<Record<"head" | "delete" | "list", unknown>> = {}): R2Bucket {
    return {
      put: (k: string, v: string) => chunks.put(k, v),
      get: (k: string) => chunks.get(k),
      head: (over.head as R2Bucket["head"]) ?? ((k: string) => chunks.head(k)),
      delete: (over.delete as R2Bucket["delete"]) ?? ((k: string | string[]) => chunks.delete(k)),
      list: (over.list as R2Bucket["list"]) ?? ((o?: R2ListOptions) => chunks.list(o)),
    } as unknown as R2Bucket;
  }

  function makeEnv(over: { CHUNKS?: R2Bucket; DB?: D1Database } = {}): Env {
    return {
      DB: over.DB ?? db,
      CHUNKS: over.CHUNKS ?? bucketWith(),
      CONTENT: content,
      AI: {
        async run(_model: string, input: { text: string[] }) {
          return { data: input.text.map(() => Array(768).fill(0.01)) };
        },
      },
      VECTORIZE: {
        async upsert() {
          return { mutationId: "m" };
        },
        async deleteByIds() {
          return { mutationId: "m" };
        },
        async query() {
          return { matches: [], count: 0 };
        },
        async getByIds() {
          return [];
        },
      },
    } as unknown as Env;
  }

  /** D1 whose orphan lookups go through `wrap`; everything else is the real database. */
  function dbWithLookup(wrap: (real: () => Promise<D1Result>) => Promise<unknown>): D1Database {
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!sql.startsWith(ORPHAN_LOOKUP)) return stmt;
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            return { all: () => wrap(() => bound.all()) };
          },
        };
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;
  }

  let seq = 0;
  /** A conversation of eight messages saved through the real path: its chunk ids and object keys. */
  async function seed(): Promise<{ conv: string; ids: string[]; keys: string[] }> {
    seq++;
    const org = `org_sweep${seq}`;
    const conv = `conv_sweep${seq}`;
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(org, org).run();
    await insertConversation(db, conv, org, `title ${conv}`, null, [], {});
    await appendMessages(
      makeEnv(),
      org,
      conv,
      Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `sweep ${seq} message number ${i + 1} about the harbour lighthouse`,
      })),
    );
    const rows = await db
      .prepare("SELECT id FROM conversation_chunks WHERE conversation_id = ? ORDER BY start_sequence, id")
      .bind(conv)
      .all<{ id: string }>();
    const ids = rows.results.map((r) => r.id);
    expect(ids.length).toBe(3);
    const keys = ids.map((id) => chunkObjectKey(conv, id));
    for (const k of keys) expect(await chunks.head(k)).not.toBeNull();
    return { conv, ids, keys };
  }

  /** The row goes; its object stays — what a lost race leaves behind. */
  async function dropRow(id: string) {
    await db.prepare("DELETE FROM conversation_chunks WHERE id = ?").bind(id).run();
  }

  /** Every object in the bucket, key → text. */
  async function snapshot(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const listed = await chunks.list({ limit: 1000 });
    expect(listed.truncated).toBe(false);
    for (const o of listed.objects) out.set(o.key, await (await chunks.get(o.key))!.text());
    return out;
  }

  /** Long after everything a test writes, so the settle window has passed for all of it. */
  const later = () => Date.now() + 2 * ORPHAN_SETTLE_MS;

  type Totals = ChunkMoverCounts & { problems: string[]; pages: number; capped: boolean };
  /** Sweep the whole bucket the way ChunkMoverDO does: page by key, budget spent across pages. */
  async function sweepAll(
    env: Env,
    opts: { deleteOrphans: boolean; maxDeletes?: number; limit?: number; now?: number },
  ): Promise<Totals> {
    const total: Totals = { ...emptyCounts(), problems: [], pages: 0, capped: false };
    let after: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const b = await runOrphanSweepBatch(env, {
        after,
        deleteOrphans: opts.deleteOrphans,
        deleteBudget: Math.max(0, (opts.maxDeletes ?? 0) - total.orphansRemoved),
        limit: opts.limit,
        now: opts.now ?? later(),
      });
      for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) total[k] += b[k];
      total.problems.push(...b.problems);
      total.pages++;
      if (b.capped) return { ...total, capped: true };
      after = b.nextAfterKey;
      if (b.done) return total;
    }
    throw new Error("sweep did not finish");
  }

  /**
   * Two saved conversations plus one of everything the sweep has to tell
   * apart: two true orphans, three keys the save path does not make, and
   * one chunk filed under the wrong conversation.
   */
  async function mixedBucket() {
    const a = await seed();
    const b = await seed();
    await dropRow(a.ids[0]);
    const neverSaved = chunkObjectKey(b.conv, "chk_never_saved");
    await chunks.put(neverSaved, "text whose row never existed");
    const unrecognized = ["stray-file.txt", `${b.conv}/not-a-chunk`, `${b.conv}/nested/chk_x`];
    for (const k of unrecognized) await chunks.put(k, "not a chunk copy");
    const misfiled = chunkObjectKey(b.conv, a.ids[1]);
    await chunks.put(misfiled, "a's chunk under b's conversation");
    return { a, b, orphans: [a.keys[0], neverSaved], unrecognized, misfiled };
  }

  // ── Judgment ────────────────────────────────────────────────────────────

  it("report only: finds the orphans and the odd keys, and deletes nothing", async () => {
    const m = await mixedBucket();
    const before = await snapshot();

    const t = await sweepAll(makeEnv(), { deleteOrphans: false });
    expect(t).toMatchObject({
      scanned: before.size,
      live: 5, // a's other two and b's three
      orphans: 2,
      unrecognized: 3,
      misfiled: 1,
      young: 0,
      orphansRemoved: 0,
      raced: 0,
      capped: false,
    });
    expect(new Set(t.problems)).toEqual(new Set([...m.orphans, ...m.unrecognized, m.misfiled]));
    expect(await snapshot()).toEqual(before);
  });

  it("delete: removes exactly the orphans; every other object is byte-for-byte untouched", async () => {
    const m = await mixedBucket();
    const before = await snapshot();

    const t = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10 });
    expect(t).toMatchObject({ orphans: 2, orphansRemoved: 2, raced: 0, unrecognized: 3, misfiled: 1, live: 5 });

    const expected = new Map(before);
    for (const k of m.orphans) expected.delete(k);
    expect(await snapshot()).toEqual(expected);

    const again = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10 });
    expect(again).toMatchObject({ orphans: 0, orphansRemoved: 0, live: 5, unrecognized: 3, misfiled: 1 });
  });

  it("a cleared row's object is live: the sweep never touches the only copy", async () => {
    const a = await seed();
    // What stage 2 does to a row once its copy is verified.
    for (const id of a.ids) {
      await db
        .prepare("UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = 'r2:raw' WHERE id = ?")
        .bind(id)
        .run();
    }
    const before = await snapshot();

    const t = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10 });
    expect(t).toMatchObject({ live: 3, orphans: 0, orphansRemoved: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it("objects written inside the settle window are not judged until it has passed", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    const before = await snapshot();

    const now = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10, now: Date.now() });
    expect(now).toMatchObject({ young: 3, live: 0, orphans: 0, orphansRemoved: 0 });
    expect(await snapshot()).toEqual(before);

    const dayLater = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10 });
    expect(dayLater).toMatchObject({ young: 0, live: 2, orphans: 1, orphansRemoved: 1 });
    expect(await chunks.head(a.keys[0])).toBeNull();
  });

  it("pages through the bucket by key", async () => {
    await seed();
    const b = await seed();
    await dropRow(b.ids[2]);

    const t = await sweepAll(makeEnv(), { deleteOrphans: true, maxDeletes: 10, limit: 2 });
    expect(t).toMatchObject({ scanned: 6, live: 5, orphans: 1, orphansRemoved: 1 });
    expect(t.pages).toBeGreaterThanOrEqual(3);
    expect(await chunks.head(b.keys[2])).toBeNull();
  });

  // ── The guards on the delete ────────────────────────────────────────────

  it("a page with more orphans than the cap allows deletes nothing and says so", async () => {
    const a = await seed();
    for (const id of a.ids) await dropRow(id);
    const before = await snapshot();

    const capped = await runOrphanSweepBatch(makeEnv(), {
      after: null,
      deleteOrphans: true,
      deleteBudget: 2,
      now: later(),
    });
    expect(capped).toMatchObject({ capped: true, done: false, nextAfterKey: null, orphans: 3, orphansRemoved: 0 });
    expect(await snapshot()).toEqual(before);

    const spent = await runOrphanSweepBatch(makeEnv(), { after: null, deleteOrphans: true, deleteBudget: 0, now: later() });
    expect(spent).toMatchObject({ capped: true, orphansRemoved: 0 });
    expect(await snapshot()).toEqual(before);

    const fits = await runOrphanSweepBatch(makeEnv(), { after: null, deleteOrphans: true, deleteBudget: 3, now: later() });
    expect(fits).toMatchObject({ capped: false, done: true, orphansRemoved: 3 });
    expect((await snapshot()).size).toBe(0);
  });

  it("a row that comes back between the judgment and the delete keeps its object", async () => {
    const a = await seed();
    const id = a.ids[1];
    // Out of sight for the first lookup, then back — as a reindex re-creates
    // a chunk under its deterministic id.
    await db.prepare("UPDATE conversation_chunks SET id = ? WHERE id = ?").bind(`${id}_away`, id).run();
    let lookups = 0;
    const env = makeEnv({
      DB: dbWithLookup(async (real) => {
        const res = await real();
        if (++lookups === 1) {
          await db.prepare("UPDATE conversation_chunks SET id = ? WHERE id = ?").bind(id, `${id}_away`).run();
        }
        return res;
      }),
    });
    const before = await snapshot();

    const t = await sweepAll(env, { deleteOrphans: true, maxDeletes: 10 });
    expect(t).toMatchObject({ live: 2, orphans: 1, raced: 1, orphansRemoved: 0 });
    expect(lookups).toBe(2);
    expect(await snapshot()).toEqual(before);
  });

  it("an object put again since the listing is kept, even with the same bytes", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    const text = await (await chunks.get(a.keys[0]))!.text();
    let reput = false;
    const env = makeEnv({
      CHUNKS: bucketWith({
        head: async (k: string) => {
          if (k === a.keys[0] && !reput) {
            reput = true;
            await new Promise((r) => setTimeout(r, 5));
            await chunks.put(k, text); // same etag: only the upload time tells them apart
          }
          return chunks.head(k);
        },
      }),
    });

    const t = await sweepAll(env, { deleteOrphans: true, maxDeletes: 10 });
    expect(reput).toBe(true);
    expect(t).toMatchObject({ orphans: 1, raced: 1, orphansRemoved: 0 });
    expect(await chunks.head(a.keys[0])).not.toBeNull();
  });

  it("an object already gone by the delete is not counted as removed", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    const env = makeEnv({
      CHUNKS: bucketWith({
        head: async (k: string) => {
          if (k === a.keys[0]) await chunks.delete(k); // a conversation delete swept it first
          return chunks.head(k);
        },
      }),
    });

    const t = await sweepAll(env, { deleteOrphans: true, maxDeletes: 10 });
    expect(t).toMatchObject({ orphans: 1, raced: 1, orphansRemoved: 0, live: 2 });
  });

  it("fails closed: a lookup without a result set throws before anything is deleted", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    const before = await snapshot();
    const env = makeEnv({ DB: dbWithLookup(async () => ({ success: true, meta: {} })) });

    await expect(
      runOrphanSweepBatch(env, { after: null, deleteOrphans: true, deleteBudget: 100, now: later() }),
    ).rejects.toThrow(/no result set/);
    expect(await snapshot()).toEqual(before);
  });

  it("an empty bucket finishes; a page with no keys that says more remain fails instead of spinning", async () => {
    const empty = await runOrphanSweepBatch(makeEnv(), { after: null, deleteOrphans: true, deleteBudget: 10, now: later() });
    expect(empty).toMatchObject({ scanned: 0, done: true, nextAfterKey: null, orphans: 0, orphansRemoved: 0 });

    const stuck = makeEnv({
      CHUNKS: bucketWith({
        list: async () => ({ objects: [], delimitedPrefixes: [], truncated: true, cursor: "c" }),
      }),
    });
    await expect(
      runOrphanSweepBatch(stuck, { after: "conv_x/chk_1", deleteOrphans: true, deleteBudget: 10, now: later() }),
    ).rejects.toThrow(/after key conv_x\/chk_1 returned no keys but says more remain/);
  });

  it("a failed delete fails the page instead of reporting the objects removed", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    const env = makeEnv({
      CHUNKS: bucketWith({
        delete: async () => {
          throw new Error("r2 down (test)");
        },
      }),
    });

    await expect(
      runOrphanSweepBatch(env, { after: null, deleteOrphans: true, deleteBudget: 10, now: later() }),
    ).rejects.toThrow(/r2 down/);
    expect(await chunks.head(a.keys[0])).not.toBeNull();
  });

  // ── What it asks of D1 ──────────────────────────────────────────────────

  it("reads ids only, writes nothing, and looks chunks up by primary key in bounded batches", async () => {
    const a = await seed();
    await dropRow(a.ids[0]);
    // Enough orphans that the lookups span more than one IN (...) batch.
    for (let i = 0; i < 95; i++) await chunks.put(chunkObjectKey(a.conv, `chk_ghost_${i}`), `ghost ${i}`);

    const seen: string[] = [];
    const recording = {
      prepare(sql: string) {
        seen.push(sql);
        return db.prepare(sql);
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
    } as unknown as D1Database;

    const t = await sweepAll(makeEnv({ DB: recording }), { deleteOrphans: true, maxDeletes: 200 });
    expect(t).toMatchObject({ live: 2, orphans: 96, orphansRemoved: 96 });

    expect(seen.length).toBe(4); // judge 98 ids (90 + 8), re-check 96 (90 + 6)
    for (const sql of seen) {
      expect(sql.startsWith(`${ORPHAN_LOOKUP} WHERE id IN (`)).toBe(true);
      expect(sql).not.toMatch(/chunk_text/);
      const params = (sql.match(/\?/g) ?? []).map(() => "x");
      expect(params.length).toBeLessThanOrEqual(90); // D1 binds at most 100
      const plan = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      const lines = plan.results.map((r) => r.detail);
      expect(lines.join(" | ")).toMatch(
        /SEARCH conversation_chunks USING (COVERING )?INDEX sqlite_autoindex_conversation_chunks_1 \(id=\?\)/,
      );
      expect(lines.filter((l) => /^SCAN/.test(l))).toEqual([]);
    }
  });
});
