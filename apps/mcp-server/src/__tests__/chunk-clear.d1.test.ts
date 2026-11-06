import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { Miniflare } from "miniflare";
import {
  CHUNK_CLEAR_MAX_ROWS,
  clearChunkTexts,
  getChunkClearPage,
  getMaxChunkRowid,
  insertConversation,
  restoreChunkTexts,
} from "@getengram/db";
import { appendMessages } from "../services/conversation.js";
import { chunkObjectKey, loadChunkTexts } from "../services/chunk-store.js";
import {
  CLEAR_PAGE,
  ChunkRestoreError,
  emptyCounts,
  runChunkClearBatch,
  runChunkMoverBatch,
  type ChunkMoverBatch,
  type ChunkMoverCounts,
} from "../services/chunk-mover.js";
import { searchConversations } from "../services/search.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#384 stage 2: the clear, against real SQLite and real R2
 * (Miniflare). The clear is the step that leaves a chunk's text in R2 only,
 * so most of these are about when it must NOT clear, or must give a row its
 * text back: an object missing or different, a row written inside the
 * settle window, a row rewritten, re-created, marked or deleted between the
 * read and the update, an object deleted or replaced between the update and
 * the check after it, a write whose outcome is unknown, a restore that
 * fails. And that a cleared row is still read, searched and verified from
 * its object, at a new rowid above the run's ceiling.
 *
 * Every test seeds its own organization and runs scoped to it, or to the
 * rowid range it seeded, because the database is shared.
 */

type Row = {
  rid: number;
  id: string;
  conversation_id: string;
  chunk_text: string;
  chunk_encoding: string | null;
  created_at: string;
};
type Totals = ChunkMoverCounts & { problems: string[]; pages: number };

const isClear = (sql: string) => sql.includes("SET chunk_text = ''");
const isRestore = (sql: string) => sql.includes("chunk_encoding = NULL");
const isReadBack = (sql: string) => sql.includes("WHERE id IN");
const isClearPage = (sql: string) => sql.includes("AS settled");

describe("chunk clear (engram#384 stage 2), against real SQLite and R2", () => {
  let mf: Miniflare;
  let db: D1Database;
  let chunks: R2Bucket;
  let content: R2Bucket;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "chunk-clear" },
      r2Buckets: { CHUNKS: "clear-chunks", CONTENT: "clear-content" },
    });
    db = await mf.getD1Database("DB");
    chunks = (await mf.getR2Bucket("CHUNKS")) as unknown as R2Bucket;
    content = (await mf.getR2Bucket("CONTENT")) as unknown as R2Bucket;
    await applyAllMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Fixtures ────────────────────────────────────────────────────────────

  /** The real bucket with chosen methods replaced. Explicit forwarding: Miniflare's bindings are proxies. */
  function bucketWith(over: Partial<Record<"get" | "head", unknown>> = {}): R2Bucket {
    return {
      put: (k: string, v: string, o?: R2PutOptions) => chunks.put(k, v, o),
      get: (over.get as R2Bucket["get"]) ?? ((k: string) => chunks.get(k)),
      head: (over.head as R2Bucket["head"]) ?? ((k: string) => chunks.head(k)),
      delete: (k: string | string[]) => chunks.delete(k),
      list: (o?: R2ListOptions) => chunks.list(o),
    } as unknown as R2Bucket;
  }

  /**
   * The bucket, with `hook` run once right after the clear has read `key`'s
   * object: a save or delete landing between the read and the update.
   */
  function afterRead(key: string, hook: () => Promise<void>): R2Bucket {
    let fired = false;
    return bucketWith({
      get: async (k: string) => {
        const obj = await chunks.get(k);
        if (!obj) return null;
        const text = await obj.text();
        if (k === key && !fired) {
          fired = true;
          await hook();
        }
        return { etag: obj.etag, text: async () => text };
      },
    });
  }

  /**
   * The bucket, with `hook` run once right before the check that follows
   * the update looks at `key`: a delete or reindex landing just after the
   * clear. A hook that throws makes that check fail.
   */
  function beforeCheck(key: string, hook: () => Promise<void>): R2Bucket {
    let fired = false;
    return bucketWith({
      head: async (k: string) => {
        if (k === key && !fired) {
          fired = true;
          await hook();
        }
        return chunks.head(k);
      },
    });
  }

  /**
   * The real database, with batches and reads routed through hooks that
   * see each statement's SQL. Statements are wrapped so the batch can be
   * told apart; the real ones are what run.
   */
  function dbWith(hooks: {
    batch?: (sql: string, run: () => Promise<D1Result[]>) => Promise<D1Result[]>;
    all?: (sql: string, args: unknown[], run: () => Promise<D1Result>) => Promise<D1Result>;
  }): D1Database {
    const real = new WeakMap<object, { stmt: D1PreparedStatement; sql: string }>();
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            const wrapper = {
              all: () => (hooks.all ? hooks.all(sql, args, () => bound.all()) : bound.all()),
              first: (col?: string) => (col === undefined ? bound.first() : bound.first(col)),
              run: () => bound.run(),
            };
            real.set(wrapper, { stmt: bound, sql });
            return wrapper;
          },
          first: () => stmt.first(),
          all: () => stmt.all(),
          run: () => stmt.run(),
        };
      },
      batch(stmts: object[]) {
        const parts = stmts.map((s) => real.get(s)!);
        const run = () => db.batch(parts.map((p) => p.stmt));
        return hooks.batch ? hooks.batch(parts[0].sql, run) : run();
      },
    } as unknown as D1Database;
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

  function makeEnv(over: { CHUNKS?: R2Bucket; DB?: D1Database; aiDown?: boolean } = {}): Env {
    return {
      DB: over.DB ?? db,
      CHUNKS: over.CHUNKS ?? bucketWith(),
      CONTENT: content,
      AI: {
        async run(_model: string, input: { text: string[] }) {
          if (over.aiDown) throw new Error("ai down (test)");
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

  const key = (conv: string, id: string) => chunkObjectKey(conv, id);
  const top = () => getMaxChunkRowid(db);

  async function rowsOf(conv: string): Promise<Row[]> {
    const res = await db
      .prepare(
        `SELECT rowid AS rid, id, conversation_id, chunk_text, chunk_encoding, created_at
           FROM conversation_chunks WHERE conversation_id = ? ORDER BY start_sequence, id`,
      )
      .bind(conv)
      .all<Row>();
    return res.results ?? [];
  }

  async function rowById(id: string): Promise<Row | null> {
    return db
      .prepare("SELECT rowid AS rid, id, conversation_id, chunk_text, chunk_encoding, created_at FROM conversation_chunks WHERE id = ?")
      .bind(id)
      .first<Row>();
  }

  async function objectText(k: string): Promise<string | null> {
    const obj = await chunks.get(k);
    return obj ? obj.text() : null;
  }

  /** Make a conversation's rows look written two days ago, past the settle window. */
  async function backdate(conv: string) {
    await db
      .prepare("UPDATE conversation_chunks SET created_at = datetime('now', '-2 days') WHERE conversation_id = ?")
      .bind(conv)
      .run();
  }

  let seq = 0;
  /**
   * A conversation of eight messages (three chunks) saved through the real
   * path, in a new organization unless one is given, settled unless told
   * otherwise. Multi-byte text, so a byte-level difference would show.
   */
  async function seed(word: string, opts: { org?: string; settled?: boolean } = {}) {
    seq++;
    const org = opts.org ?? `org_clear${seq}`;
    const conv = `conv_clear${seq}`;
    if (!opts.org) await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(org, org).run();
    await insertConversation(db, conv, org, `title ${conv}`, null, [], {});
    await appendMessages(
      makeEnv(),
      org,
      conv,
      Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `${word} message ${i + 1} about the harbour lighthouse — café naïve 🙂\r\nsecond line`,
      })),
    );
    if (opts.settled !== false) await backdate(conv);
    const rows = await rowsOf(conv);
    expect(rows.length).toBe(3);
    return { org, conv, rows };
  }

  function add(total: Totals, b: ChunkMoverBatch) {
    for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) total[k] += b[k];
    total.problems.push(...b.problems);
    total.pages++;
  }

  /** Clear pages until done, as the mover would. */
  async function runClear(
    env: Env,
    opts: { upto: number; org?: string; after?: number; limit?: number },
  ): Promise<Totals> {
    const total: Totals = { ...emptyCounts(), problems: [], pages: 0 };
    let after = opts.after ?? 0;
    for (let i = 0; i < 1000; i++) {
      const b = await runChunkClearBatch(env, { after, upto: opts.upto, org: opts.org, limit: opts.limit });
      add(total, b);
      after = b.nextAfter;
      if (b.done) return total;
    }
    throw new Error("clear did not finish");
  }

  async function runVerify(env: Env, org: string): Promise<Totals> {
    const total: Totals = { ...emptyCounts(), problems: [], pages: 0 };
    let after = 0;
    for (let i = 0; i < 1000; i++) {
      const b = await runChunkMoverBatch(env, { mode: "verify", org, after });
      add(total, b);
      after = b.nextAfter;
      if (b.done) return total;
    }
    throw new Error("verify did not finish");
  }

  /** Just the counts, to compare whole. */
  function counts(t: Totals): ChunkMoverCounts {
    const { problems: _p, pages: _n, ...c } = t;
    return c;
  }

  // ── Statements ──────────────────────────────────────────────────────────

  it("its statements are bounded index reads and primary-key updates, never a scan or a sort", async () => {
    const seen: string[] = [];
    const rec = recordingDb(seen);
    await getChunkClearPage(rec, { after: 0, upto: 10, limit: 50, settleSeconds: 60 });
    await getChunkClearPage(rec, { after: 0, upto: 10, limit: 50, settleSeconds: 60, organizationId: "org_plan" });
    await clearChunkTexts(rec, [{ id: "chk_none", text: "x" }], { encoding: "r2:raw", settleSeconds: 60 });
    await restoreChunkTexts(rec, [{ id: "chk_none", text: "x" }], "r2:raw");
    await getMaxChunkRowid(rec);
    const [whole, byOrg, clearSql, restoreSql, maxSql] = seen;

    const plan = async (sql: string, binds: unknown[]) => {
      const res = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      return res.results.map((r) => r.detail).join(" | ");
    };
    const plans = {
      whole: await plan(whole, ["-60 seconds", 0, 10, 50]),
      byOrg: await plan(byOrg, ["-60 seconds", "org_plan", 0, 10, 50]),
      clear: await plan(clearSql, ["r2:raw", "chk_none", "x", "-60 seconds"]),
      restore: await plan(restoreSql, ["x", "chk_none", "r2:raw"]),
      max: await plan(maxSql, []),
    };
    console.info(JSON.stringify(plans, null, 2));

    expect(plans.whole).toMatch(/SEARCH conversation_chunks USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/);
    expect(plans.byOrg).toMatch(
      /SEARCH conversation_chunks USING INDEX idx_chunks_org \(organization_id=\? AND rowid>\? AND rowid<\?\)/,
    );
    for (const p of [plans.clear, plans.restore]) {
      expect(p).toMatch(/SEARCH conversation_chunks USING INDEX sqlite_autoindex_conversation_chunks_1 \(id=\?\)/);
    }
    for (const p of Object.values(plans)) {
      expect(p).not.toMatch(/TEMP B-TREE/);
      expect(p).not.toMatch(/\bSCAN\b/);
    }
  });

  it("the statements refuse an oversized batch, a bad settle window and an encoding that is not R2", async () => {
    expect(CLEAR_PAGE).toBe(CHUNK_CLEAR_MAX_ROWS);
    const many = Array.from({ length: CHUNK_CLEAR_MAX_ROWS + 1 }, (_, i) => ({ id: `chk_x${i}`, text: "x" }));
    await expect(clearChunkTexts(db, many, { encoding: "r2:raw", settleSeconds: 60 })).rejects.toThrow(/at most 50 rows/);
    await expect(restoreChunkTexts(db, many, "r2:raw")).rejects.toThrow(/at most 50 rows/);
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      await expect(clearChunkTexts(db, [], { encoding: "r2:raw", settleSeconds: bad })).rejects.toThrow(/settle window/);
      expect(() => getChunkClearPage(db, { after: 0, upto: 1, limit: 1, settleSeconds: bad })).toThrow(/settle window/);
    }
    for (const enc of ["raw", "", "R2:raw", " r2:raw"]) {
      await expect(clearChunkTexts(db, [], { encoding: enc, settleSeconds: 60 })).rejects.toThrow(/refusing to clear/);
    }
  });

  it("a page never reads more rows than one clear transaction takes", async () => {
    const { org } = await seed("bunting");
    const limits: unknown[] = [];
    const env = makeEnv({
      DB: dbWith({
        all: (sql, args, run) => {
          if (isClearPage(sql)) limits.push(args[args.length - 1]);
          return run();
        },
      }),
    });
    const upto = await top();
    await runChunkClearBatch(env, { after: 0, upto, org, limit: 500, settleSeconds: 1_000_000_000 });
    await runChunkClearBatch(env, { after: 0, upto, org, limit: 7, settleSeconds: 1_000_000_000 });
    await runChunkClearBatch(env, { after: 0, upto, org, settleSeconds: 1_000_000_000 });
    expect(limits).toEqual([50, 7, 50]);
  });

  // ── Clearing ────────────────────────────────────────────────────────────

  it("clears a settled row whose object matches: column emptied, row moved above the ceiling, object untouched, readers unchanged", async () => {
    const { org, conv, rows } = await seed("avocet");
    const upto = await top();
    const etags = new Map<string, string>();
    for (const r of rows) etags.set(r.id, (await chunks.head(key(conv, r.id)))!.etag);
    const env = makeEnv({ aiDown: true }); // keyword search only: the FTS index, keyed by fts_rowid

    const res = await runClear(env, { upto, org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 3 });
    expect(res.problems).toEqual([]);

    const now = await rowsOf(conv);
    expect(now.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    for (const r of now) {
      expect(r.chunk_text).toBe("");
      expect(r.chunk_encoding).toBe("r2:raw");
      expect(r.rid).toBeGreaterThan(upto);
    }
    expect(new Set(now.map((r) => r.rid)).size).toBe(3);
    expect(await top()).toBe(upto + 3);
    for (const r of rows) {
      expect(await objectText(key(conv, r.id))).toBe(r.chunk_text);
      expect((await chunks.head(key(conv, r.id)))!.etag).toBe(etags.get(r.id));
    }

    // Every reader gets the column's old text, character for character.
    const texts = await loadChunkTexts(env, now);
    expect(rows.map((r) => texts.get(r.id))).toEqual(rows.map((r) => r.chunk_text));
    const hits = await searchConversations(env, org, "avocet", 5, undefined, undefined, 2000, 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.chunk_text).toBe(rows.find((r) => r.id === h.chunk_id)!.chunk_text);

    // Verify finds every object; a second run clears nothing and checks them again.
    expect(await runVerify(env, org)).toMatchObject({ scanned: 3, clearedOk: 3, lost: 0, ok: 0, missing: 0 });
    const again = await runClear(env, { upto: await top(), org });
    expect(counts(again)).toEqual({ ...emptyCounts(), scanned: 3, clearedOk: 3 });
  });

  it("a full page clears in one transaction, and the walk never meets a row it moved", async () => {
    const first = await seed("dunlin");
    for (let i = 0; i < 17; i++) await seed("dunlin", { org: first.org });
    const upto = await top();
    const res = await runClear(makeEnv(), { upto, org: first.org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 54, cleared: 54 });
    expect(res.pages).toBe(2); // 50, then 4
    const all = await db
      .prepare("SELECT rowid AS rid, chunk_text, chunk_encoding FROM conversation_chunks WHERE organization_id = ?")
      .bind(first.org)
      .all<{ rid: number; chunk_text: string; chunk_encoding: string | null }>();
    expect(all.results.length).toBe(54);
    expect(all.results.every((r) => r.chunk_text === "" && r.chunk_encoding === "r2:raw" && r.rid > upto)).toBe(true);
    expect(new Set(all.results.map((r) => r.rid)).size).toBe(54);

    // Small pages too: each moved row lands above the ceiling, behind the cursor's end.
    const small = await seed("dunlin small");
    const smallRes = await runClear(makeEnv(), { upto: await top(), org: small.org, limit: 2 });
    expect(counts(smallRes)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 3 });
    expect(smallRes.pages).toBe(2);
  });

  it("leaves a row written inside the settle window inline, and clears it once settled", async () => {
    const { org, conv, rows } = await seed("bittern", { settled: false });
    const env = makeEnv();
    const young = await runClear(env, { upto: await top(), org });
    expect(counts(young)).toEqual({ ...emptyCounts(), scanned: 3, young: 3 });
    expect((await rowsOf(conv)).map((r) => [r.chunk_text, r.chunk_encoding])).toEqual(
      rows.map((r) => [r.chunk_text, null]),
    );

    await backdate(conv);
    expect(await runClear(env, { upto: await top(), org })).toMatchObject({ cleared: 3, young: 0 });
  });

  it("never clears a row whose object is missing or differs from the column, and reports it", async () => {
    const { org, conv, rows } = await seed("curlew");
    await chunks.delete(key(conv, rows[0].id));
    await chunks.put(key(conv, rows[1].id), `${rows[1].chunk_text} `);
    const res = await runClear(makeEnv(), { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, missing: 1, mismatched: 1, cleared: 1 });
    expect([...res.problems].sort()).toEqual([rows[0].id, rows[1].id].sort());
    expect((await rowById(rows[0].id))!.chunk_text).toBe(rows[0].chunk_text);
    expect((await rowById(rows[1].id))!.chunk_text).toBe(rows[1].chunk_text);
    expect((await rowById(rows[2].id))!.chunk_text).toBe("");
  });

  it("skips a row with no text, and reports one with text and an encoding it does not know", async () => {
    const { org, rows } = await seed("lapwing");
    await db.prepare("UPDATE conversation_chunks SET chunk_text = '' WHERE id = ?").bind(rows[0].id).run();
    await db.prepare("UPDATE conversation_chunks SET chunk_encoding = 'zstd' WHERE id = ?").bind(rows[1].id).run();
    const res = await runClear(makeEnv(), { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, skipped: 2, cleared: 1 });
    expect(res.problems).toEqual([rows[1].id]);
    expect(await rowById(rows[1].id)).toMatchObject({ chunk_text: rows[1].chunk_text, chunk_encoding: "zstd" });
  });

  it("touches only the org it is given, and only rows at or below the ceiling", async () => {
    const a = await seed("merlin");
    const b = await seed("merlin");
    const upto = await top();
    const late = await seed("merlin", { org: a.org }); // saved after the run started

    const res = await runClear(makeEnv(), { upto, org: a.org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 3 });
    expect((await rowsOf(a.conv)).every((r) => r.chunk_text === "")).toBe(true);
    expect((await rowsOf(b.conv)).map((r) => r.chunk_text)).toEqual(b.rows.map((r) => r.chunk_text));
    expect((await rowsOf(late.conv)).map((r) => r.chunk_text)).toEqual(late.rows.map((r) => r.chunk_text));
  });

  it("without an org, walks the rowid range it is given and nothing outside it", async () => {
    const before = await top();
    const a = await seed("osprey");
    const b = await seed("osprey");
    const upto = await top();
    const outside = await seed("osprey");

    const res = await runClear(makeEnv(), { after: before, upto });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 6, cleared: 6 });
    for (const c of [a, b]) expect((await rowsOf(c.conv)).every((r) => r.chunk_text === "")).toBe(true);
    expect((await rowsOf(outside.conv)).every((r) => r.chunk_text !== "")).toBe(true);
  });

  // ── Races between the read and the update ───────────────────────────────

  it.each([
    {
      race: "rewritten",
      sql: "UPDATE conversation_chunks SET chunk_text = 'rewritten (test)' WHERE id = ?",
      left: { chunk_text: "rewritten (test)", chunk_encoding: null },
    },
    {
      race: "re-created with the same text (created_at reset, as INSERT OR REPLACE does)",
      sql: "UPDATE conversation_chunks SET created_at = datetime('now') WHERE id = ?",
      left: { chunk_encoding: null },
    },
    {
      race: "marked",
      sql: "UPDATE conversation_chunks SET chunk_encoding = 'r2:raw' WHERE id = ?",
      left: { chunk_encoding: "r2:raw" },
    },
    { race: "deleted", sql: "DELETE FROM conversation_chunks WHERE id = ?", left: null },
  ])("a row $race between the read and the update is not cleared", async ({ sql, left }) => {
    const { org, conv, rows } = await seed("plover");
    const target = rows[0];
    const env = makeEnv({
      CHUNKS: afterRead(key(conv, target.id), async () => {
        await db.prepare(sql).bind(target.id).run();
      }),
    });
    const res = await runClear(env, { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, raced: 1, cleared: 2 });
    expect(res.problems).toEqual([]);

    const now = await rowById(target.id);
    if (left === null) expect(now).toBeNull();
    else {
      expect(now).toMatchObject(left);
      if (!("chunk_text" in left)) expect(now!.chunk_text).toBe(target.chunk_text);
    }
    expect(await objectText(key(conv, target.id))).toBe(target.chunk_text);
  });

  // ── The check after the update ──────────────────────────────────────────

  it.each([
    { change: "deleted", hook: (k: string) => chunks.delete(k), object: null as string | null },
    { change: "replaced", hook: (k: string) => chunks.put(k, "replaced (test)").then(() => {}), object: "replaced (test)" },
    {
      change: "unreadable",
      hook: async () => {
        throw new Error("R2 head failed (test)");
      },
      object: "same",
    },
  ])("a row whose object is $change straight after the clear gets its text back", async ({ hook, object }) => {
    const { org, conv, rows } = await seed("redshank");
    const target = rows[0];
    const k = key(conv, target.id);
    const res = await runClear(makeEnv({ CHUNKS: beforeCheck(k, () => hook(k)) }), { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 2, restored: 1 });
    expect(res.problems).toEqual([target.id]);
    expect(await rowById(target.id)).toMatchObject({ chunk_text: target.chunk_text, chunk_encoding: null });
    expect(await objectText(k)).toBe(object === "same" ? target.chunk_text : object);
    for (const r of rows.slice(1)) expect((await rowById(r.id))!.chunk_text).toBe("");
  });

  it.each([
    {
      change: "rewritten by a reindex",
      sql: "UPDATE conversation_chunks SET chunk_text = 'reindexed (test)', chunk_encoding = NULL WHERE id = ?",
      left: { chunk_text: "reindexed (test)", chunk_encoding: null } as Record<string, unknown> | null,
    },
    {
      // Nothing writes this state; the restore must still leave a column with text alone.
      change: "given text while still marked",
      sql: "UPDATE conversation_chunks SET chunk_text = 'other (test)' WHERE id = ?",
      left: { chunk_text: "other (test)", chunk_encoding: "r2:raw" },
    },
    {
      change: "re-created empty",
      sql: "UPDATE conversation_chunks SET chunk_encoding = NULL WHERE id = ?",
      left: { chunk_text: "", chunk_encoding: null },
    },
    { change: "deleted with its conversation", sql: "DELETE FROM conversation_chunks WHERE id = ?", left: null },
  ])("a restore never writes over a row $change since the clear", async ({ sql, left }) => {
    const { org, conv, rows } = await seed("sanderling");
    const target = rows[0];
    const k = key(conv, target.id);
    const env = makeEnv({
      CHUNKS: beforeCheck(k, async () => {
        await chunks.delete(k);
        await db.prepare(sql).bind(target.id).run();
      }),
    });
    const res = await runClear(env, { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 2, raced: 1 });
    expect(res.problems).toEqual([target.id]);
    const now = await rowById(target.id);
    if (left === null) expect(now).toBeNull();
    else expect(now).toMatchObject(left);
  });

  // ── A write whose outcome is unknown ────────────────────────────────────

  it("a clear whose reply is lost after it committed is read back and counted from the rows", async () => {
    const { org, conv, rows } = await seed("godwit");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv({
      DB: dbWith({
        batch: async (sql, run) => {
          const out = await run();
          if (isClear(sql)) throw new Error("Network connection lost (test)");
          return out;
        },
      }),
      // One row rewritten in between, so the read-back has to tell them apart.
      CHUNKS: afterRead(key(conv, rows[2].id), async () => {
        await db.prepare("UPDATE conversation_chunks SET chunk_text = 'edited (test)' WHERE id = ?").bind(rows[2].id).run();
      }),
    });
    const res = await runClear(env, { upto: await top(), org });
    expect(counts(res)).toEqual({ ...emptyCounts(), scanned: 3, cleared: 2, raced: 1 });
    expect((await rowsOf(conv)).map((r) => r.chunk_text)).toEqual(["", "", "edited (test)"]);
    expect(String(errors.mock.calls[0][0])).toMatch(
      /clear write failed after rowid 0; reading the rows back: Network connection lost \(test\)/,
    );
  });

  it("a clear that failed without committing fails the page and leaves every row inline", async () => {
    const { org, conv, rows } = await seed("knot");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const upto = await top();
    const env = makeEnv({
      DB: dbWith({
        batch: async (sql, run) => {
          if (isClear(sql)) throw new Error("D1_ERROR: storage reset (test)");
          return run();
        },
      }),
    });
    await expect(runChunkClearBatch(env, { after: 0, upto, org })).rejects.toThrow(/storage reset \(test\)/);
    const now = await rowsOf(conv);
    expect(now.map((r) => [r.rid, r.chunk_text, r.chunk_encoding])).toEqual(rows.map((r) => [r.rid, r.chunk_text, null]));

    // The same page again, once the database is back.
    expect(await runClear(makeEnv(), { upto, org })).toMatchObject({ scanned: 3, cleared: 3 });
  });

  it("when the rows cannot be read back either, checks every row it tried, restores what it must, then fails the page", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const readBackFails = (committed: boolean) =>
      dbWith({
        batch: async (sql, run) => {
          if (!isClear(sql)) return run();
          if (committed) await run();
          throw new Error("Network connection lost (test)");
        },
        all: (sql, _args, run) => {
          if (isReadBack(sql)) return Promise.reject(new Error("D1 unreachable (test)"));
          return run();
        },
      });

    // Committed, and one object deleted just after: that row gets its text
    // back; the others stay cleared, their objects checked.
    const done = await seed("ruff");
    const k0 = key(done.conv, done.rows[0].id);
    const env = makeEnv({ DB: readBackFails(true), CHUNKS: beforeCheck(k0, () => chunks.delete(k0)) });
    await expect(runChunkClearBatch(env, { after: 0, upto: await top(), org: done.org })).rejects.toThrow(
      /Network connection lost \(test\)/,
    );
    expect((await rowsOf(done.conv)).map((r) => r.chunk_text)).toEqual([done.rows[0].chunk_text, "", ""]);
    const logged = errors.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/could not read them back either; checking the object of every row tried: D1 unreachable/);
    expect(logged).toMatch(/clear outcome unknown after rowid 0: checked the objects of 3 rows, 1 gone or changed, 1 given their text back/);
    expect(await runVerify(makeEnv(), done.org)).toMatchObject({ clearedOk: 2, lost: 0, missing: 1 });

    // Not committed: nothing to give back, every row still inline.
    const not = await seed("ruff");
    await expect(
      runChunkClearBatch(makeEnv({ DB: readBackFails(false) }), { after: 0, upto: await top(), org: not.org }),
    ).rejects.toThrow(/Network connection lost \(test\)/);
    expect((await rowsOf(not.conv)).map((r) => r.chunk_text)).toEqual(not.rows.map((r) => r.chunk_text));
  });

  it("a restore that keeps failing throws ChunkRestoreError naming the rows, after three tries", async () => {
    const { org, conv, rows } = await seed("kittiwake");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const target = rows[0];
    const k = key(conv, target.id);
    let restoreTries = 0;
    const env = makeEnv({
      DB: dbWith({
        batch: async (sql, run) => {
          if (isRestore(sql)) {
            restoreTries++;
            throw new Error("D1_ERROR: down (test)");
          }
          return run();
        },
      }),
      CHUNKS: beforeCheck(k, () => chunks.delete(k)),
    });
    const err = await runChunkClearBatch(env, { after: 0, upto: await top(), org }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkRestoreError);
    expect((err as ChunkRestoreError).chunkIds).toEqual([target.id]);
    expect((err as Error).message).toContain(target.id);
    expect((err as Error).message).toContain("D1_ERROR: down (test)");
    expect(restoreTries).toBe(3);

    // What the mover stops for: this row's text is now nowhere, and verify says so.
    expect(await runVerify(makeEnv(), org)).toMatchObject({ clearedOk: 2, lost: 1, problems: [target.id] });
  });
});
