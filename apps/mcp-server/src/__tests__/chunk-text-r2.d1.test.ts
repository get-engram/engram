import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { Miniflare } from "miniflare";
import {
  getChunkCopyPage,
  getChunkTextsByIds,
  insertConversation,
  searchChunksFts,
} from "@getengram/db";
import {
  appendMessages,
  updateMessage,
  deleteMessage,
  deleteConversation,
} from "../services/conversation.js";
import { chunkObjectKey, sha256Hex } from "../services/chunk-store.js";
import { runChunkMoverBatch, emptyCounts, type ChunkMoverCounts } from "../services/chunk-mover.js";
import { searchConversations } from "../services/search.js";
import { scanContentIntegrity } from "../services/content-integrity.js";
import { moveConversation } from "../routes/merge-orgs.js";
import { purgeDeletedOrganizations } from "../cron/purge-deleted.js";
import { admin } from "../routes/admin.js";
import { applyAllMigrations } from "./miniflare.js";
import type { Env } from "../types.js";

/**
 * engram#384 stage 1, against real SQLite and real R2 (Miniflare): every
 * save, edit and delete keeps the CHUNKS bucket in step with
 * conversation_chunks; the mover copies, verifies and repairs without
 * writing to D1; and every reader that needs chunk text still gets it when a
 * row's column has been cleared to R2, as stage 2 will do. Nothing here
 * clears a row through production code — stage 1 has none — so a cleared
 * row is made by hand with the exact UPDATE stage 2 will run.
 */

type Bucket = R2Bucket;

describe("chunk text in R2 (engram#384), against real SQLite and R2", () => {
  let mf: Miniflare;
  let db: D1Database;
  let chunks: Bucket;
  let content: Bucket;
  const vectors = new Map<string, { id: string; values: number[]; metadata?: Record<string, unknown> }>();

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "chunk-text-r2" },
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

  /**
   * The real bucket with chosen methods replaced, to inject failures.
   * Explicit forwarding rather than a spread: Miniflare's bindings are
   * proxies whose methods do not survive being copied.
   */
  function bucketWith(over: Partial<Record<"put" | "get" | "head" | "delete" | "list", unknown>> = {}): Bucket {
    return {
      put: (over.put as Bucket["put"]) ?? ((k, v, o) => chunks.put(k, v, o)),
      get: (over.get as Bucket["get"]) ?? ((k: string) => chunks.get(k)),
      head: (over.head as Bucket["head"]) ?? ((k: string) => chunks.head(k)),
      delete: (over.delete as Bucket["delete"]) ?? ((k: string | string[]) => chunks.delete(k)),
      list: (over.list as Bucket["list"]) ?? ((o?: R2ListOptions) => chunks.list(o)),
    } as unknown as Bucket;
  }

  /**
   * D1 that runs `hook` once, right after the mover's page read returns —
   * the moment a save or delete can land between the read and the puts.
   */
  function dbWithPageHook(hook: () => Promise<void>): D1Database {
    let fired = false;
    return {
      prepare(sql: string) {
        const stmt = db.prepare(sql);
        if (!sql.includes("rowid AS rid")) return stmt;
        return {
          bind(...args: unknown[]) {
            const bound = stmt.bind(...args);
            return {
              async all() {
                const res = await bound.all();
                if (!fired) {
                  fired = true;
                  await hook();
                }
                return res;
              },
            };
          },
        };
      },
      batch: (stmts: D1PreparedStatement[]) => db.batch(stmts),
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

  function makeEnv(over: { CHUNKS?: Bucket; DB?: D1Database; aiDown?: boolean } = {}): Env {
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
        async upsert(vs: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>) {
          for (const v of vs) vectors.set(v.id, v);
          return { mutationId: "m" };
        },
        async deleteByIds(ids: string[]) {
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

  async function addOrg(id: string, extra: { deletedAt?: string } = {}) {
    await db.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)").bind(id, id).run();
    if (extra.deletedAt) {
      await db.prepare("UPDATE organizations SET deleted_at = ? WHERE id = ?").bind(extra.deletedAt, id).run();
    }
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

  /** An org with one conversation and `n` messages saved through the real path. */
  async function seed(org: string, conv: string, n: number, word: string, env = makeEnv()) {
    await addOrg(org);
    await addConversation(org, conv);
    return appendMessages(env, org, conv, msgs(n, word));
  }

  type Row = { id: string; conversation_id: string; chunk_text: string; chunk_encoding: string | null };
  async function chunkRows(conv: string): Promise<Row[]> {
    const res = await db
      .prepare(
        "SELECT id, conversation_id, chunk_text, chunk_encoding FROM conversation_chunks WHERE conversation_id = ? ORDER BY start_sequence, id",
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

  /** What stage 2 will do to a row once its copy is verified. */
  async function clearRow(id: string) {
    await db
      .prepare("UPDATE conversation_chunks SET chunk_text = '', chunk_encoding = 'r2:raw' WHERE id = ?")
      .bind(id)
      .run();
  }

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

  // ── Schema and query plans ──────────────────────────────────────────────

  it("0047 adds chunk_encoding, and a save leaves it NULL with the text inline", async () => {
    const cols = await db.prepare("PRAGMA table_info(conversation_chunks)").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).toContain("chunk_encoding");

    await seed("org_schema", "conv_schema", 3, "anchor");
    const rows = await chunkRows("conv_schema");
    expect(rows.length).toBe(1);
    expect(rows[0].chunk_encoding).toBeNull();
    expect(rows[0].chunk_text).toContain("anchor message number 1");
  });

  it("the mover's statements are bounded index reads, never a scan or a sort", async () => {
    const plan = async (sql: string, binds: unknown[]) => {
      const res = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      return res.results.map((r) => r.detail).join(" | ");
    };

    const seen: string[] = [];
    const rec = recordingDb(seen);
    await getChunkCopyPage(rec, 0, 100);
    await getChunkCopyPage(rec, 0, 100, "org_schema");
    await getChunkTextsByIds(rec, ["a", "b"]);
    const [whole, byOrg, byIds] = seen;

    const wholePlan = await plan(whole, [0, 100]);
    expect(wholePlan).toMatch(/SEARCH conversation_chunks USING INTEGER PRIMARY KEY \(rowid>\?\)/);

    const orgPlan = await plan(byOrg, ["org_schema", 0, 100]);
    expect(orgPlan).toMatch(/USING INDEX idx_chunks_org \(organization_id=\? AND rowid>\?\)/);

    const idsPlan = await plan(byIds, ["a", "b"]);
    expect(idsPlan).toMatch(/SEARCH conversation_chunks USING INDEX sqlite_autoindex_conversation_chunks_1 \(id=\?\)/);

    for (const p of [wholePlan, orgPlan, idsPlan]) {
      expect(p).not.toMatch(/TEMP B-TREE/);
      expect(p).not.toMatch(/\bSCAN\b/);
    }
  });

  // ── The save path ───────────────────────────────────────────────────────

  it("a save writes one checksummed object per chunk, identical to the row", async () => {
    await seed("org_save", "conv_save", 8, "beacon");
    const rows = await chunkRows("conv_save");
    expect(rows.length).toBe(3);

    expect(await objectKeys("conv_save/")).toEqual(rows.map((r) => `conv_save/${r.id}`).sort());
    for (const r of rows) {
      const key = chunkObjectKey("conv_save", r.id);
      expect(await objectText(key)).toBe(r.chunk_text);
      const head = await chunks.head(key);
      const sha = Buffer.from(new Uint8Array(head!.checksums.sha256 as ArrayBuffer)).toString("hex");
      expect(sha).toBe(await sha256Hex(r.chunk_text));
      expect(head!.httpMetadata?.contentType).toBe("text/plain; charset=utf-8");
    }
  });

  it("R2 refuses a put whose bytes do not match the checksum sent with it", async () => {
    await expect(
      chunks.put("conv_x/chk_x", "the text that arrived", { sha256: await sha256Hex("the text that was sent") }),
    ).rejects.toThrow();
    expect(await chunks.head("conv_x/chk_x")).toBeNull();
  });

  it("a save whose copies fail still stores everything in D1; verify finds the gap and repair closes it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = makeEnv({ CHUNKS: bucketWith({ put: () => Promise.reject(new Error("r2 down (test)")) }) });
      const saved = await seed("org_putfail", "conv_putfail", 8, "cormorant", failing);
      expect(saved.length).toBe(8);
      expect(errors.mock.calls.some((c) => String(c[0]).includes("chunk copies failed for conv_putfail"))).toBe(true);
    } finally {
      errors.mockRestore();
    }

    const rows = await chunkRows("conv_putfail");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.chunk_text.includes("cormorant") && r.chunk_encoding === null)).toBe(true);
    const msgCount = await db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .bind("conv_putfail")
      .first<{ n: number }>();
    expect(msgCount?.n).toBe(8);
    expect(await objectKeys("conv_putfail/")).toEqual([]);

    const env = makeEnv();
    const found = await runAll(env, { mode: "verify", org: "org_putfail" });
    expect(found).toMatchObject({ scanned: 3, ok: 0, missing: 3, repaired: 0 });
    expect(found.problems.sort()).toEqual(rows.map((r) => r.id).sort());
    expect(await objectKeys("conv_putfail/")).toEqual([]); // verify alone writes nothing

    const fixed = await runAll(env, { mode: "verify", org: "org_putfail", repair: true });
    expect(fixed).toMatchObject({ missing: 3, repaired: 3, putFailed: 0 });

    const again = await runAll(env, { mode: "verify", org: "org_putfail" });
    expect(again).toMatchObject({ scanned: 3, ok: 3, missing: 0, mismatched: 0 });
    for (const r of rows) expect(await objectText(`conv_putfail/${r.id}`)).toBe(r.chunk_text);
  });

  // ── The mover ───────────────────────────────────────────────────────────

  it("copy pages through one org and copies every row; verify then finds them all identical", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = makeEnv({ CHUNKS: bucketWith({ put: () => Promise.reject(new Error("r2 down (test)")) }) });
      await seed("org_copy", "conv_copy", 11, "dunlin", failing);
    } finally {
      errors.mockRestore();
    }
    const rows = await chunkRows("conv_copy");
    expect(rows.length).toBe(4);
    const before = rows.map((r) => r.chunk_text);

    const env = makeEnv();
    const copied = await runAll(env, { mode: "copy", org: "org_copy", limit: 2 });
    expect(copied).toMatchObject({ scanned: 4, copied: 4, putFailed: 0, raced: 0, orphansRemoved: 0 });
    expect(copied.pages).toBe(3); // two full pages, then an empty one that ends the walk

    const verified = await runAll(env, { mode: "verify", org: "org_copy", limit: 2 });
    expect(verified).toMatchObject({ scanned: 4, ok: 4, missing: 0, mismatched: 0 });
    expect(verified.problems).toEqual([]);

    // Stage 1 never writes to D1.
    expect((await chunkRows("conv_copy")).map((r) => r.chunk_text)).toEqual(before);
    expect((await chunkRows("conv_copy")).every((r) => r.chunk_encoding === null)).toBe(true);
  });

  it("verify reports a corrupted and a missing copy without touching D1, and repair rewrites both", async () => {
    await seed("org_corrupt", "conv_corrupt", 8, "eider");
    const rows = await chunkRows("conv_corrupt");
    await chunks.put(`conv_corrupt/${rows[0].id}`, "something else entirely");
    await chunks.delete(`conv_corrupt/${rows[1].id}`);

    const env = makeEnv();
    const found = await runAll(env, { mode: "verify", org: "org_corrupt" });
    expect(found).toMatchObject({ scanned: 3, ok: 1, mismatched: 1, missing: 1, repaired: 0 });
    expect(found.problems.sort()).toEqual([rows[0].id, rows[1].id].sort());
    expect(await chunkRows("conv_corrupt")).toEqual(rows);
    expect(await objectText(`conv_corrupt/${rows[0].id}`)).toBe("something else entirely");

    const fixed = await runAll(env, { mode: "verify", org: "org_corrupt", repair: true });
    expect(fixed).toMatchObject({ mismatched: 1, missing: 1, repaired: 2 });
    const again = await runAll(env, { mode: "verify", org: "org_corrupt" });
    expect(again).toMatchObject({ ok: 3, mismatched: 0, missing: 0 });
    for (const r of rows) expect(await objectText(`conv_corrupt/${r.id}`)).toBe(r.chunk_text);
  });

  it("a run scoped to one org reads and writes nothing of another's", async () => {
    await seed("org_scopea", "conv_scopea", 3, "fulmar");
    await seed("org_scopeb", "conv_scopeb", 3, "gannet");
    await chunks.delete(await objectKeys("conv_scopea/"));
    await chunks.delete(await objectKeys("conv_scopeb/"));

    const res = await runAll(makeEnv(), { mode: "copy", org: "org_scopea" });
    expect(res).toMatchObject({ scanned: 1, copied: 1 });
    expect((await objectKeys("conv_scopea/")).length).toBe(1);
    expect(await objectKeys("conv_scopeb/")).toEqual([]);
  });

  it("a row rewritten or deleted while its page is in flight leaves no stale or orphaned copy", async () => {
    await seed("org_race", "conv_race", 8, "heron");
    const rows = await chunkRows("conv_race");
    expect(rows.length).toBe(3);
    await chunks.delete(await objectKeys("conv_race/"));

    const [rewritten, deleted] = [rows[0], rows[1]];
    const env = makeEnv({
      DB: dbWithPageHook(async () => {
        await db
          .prepare("UPDATE conversation_chunks SET chunk_text = ? WHERE id = ?")
          .bind("the edited wording", rewritten.id)
          .run();
        await db.prepare("DELETE FROM conversation_chunks WHERE id = ?").bind(deleted.id).run();
      }),
    });
    const res = await runAll(env, { mode: "copy", org: "org_race" });
    expect(res).toMatchObject({ scanned: 3, copied: 3, raced: 1, orphansRemoved: 1, putFailed: 0 });

    expect(await objectText(`conv_race/${rewritten.id}`)).toBe("the edited wording");
    expect(await objectText(`conv_race/${deleted.id}`)).toBeNull();
    expect(await objectText(`conv_race/${rows[2].id}`)).toBe(rows[2].chunk_text);
  });

  it("a cleared row is checked, never overwritten, and reported lost when its copy is gone", async () => {
    await seed("org_cleared", "conv_cleared", 8, "ibis");
    const rows = await chunkRows("conv_cleared");
    const target = rows[0];
    await clearRow(target.id);
    const env = makeEnv();

    const copied = await runAll(env, { mode: "copy", org: "org_cleared" });
    expect(copied).toMatchObject({ scanned: 3, copied: 2, clearedOk: 1, lost: 0 });
    expect(await objectText(`conv_cleared/${target.id}`)).toBe(target.chunk_text); // not ''

    const verified = await runAll(env, { mode: "verify", org: "org_cleared" });
    expect(verified).toMatchObject({ ok: 2, clearedOk: 1, lost: 0, missing: 0 });

    await chunks.delete(`conv_cleared/${target.id}`);
    const lost = await runAll(env, { mode: "verify", org: "org_cleared", repair: true });
    expect(lost).toMatchObject({ ok: 2, clearedOk: 0, lost: 1, repaired: 0 });
    expect(lost.problems).toEqual([target.id]);
    expect(await objectText(`conv_cleared/${target.id}`)).toBeNull(); // nothing to repair it from
  });

  // ── Edits and deletes ───────────────────────────────────────────────────

  it("an edit replaces the copies: the old wording survives in no object", async () => {
    const saved = await seed("org_edit", "conv_edit", 8, "jacana");
    const target = saved[1];
    await updateMessage(makeEnv(), "org_edit", "conv_edit", target.id, "rewritten with kestrel only");

    const rows = await chunkRows("conv_edit");
    expect(await objectKeys("conv_edit/")).toEqual(rows.map((r) => `conv_edit/${r.id}`).sort());
    for (const r of rows) {
      const text = await objectText(`conv_edit/${r.id}`);
      expect(text).toBe(r.chunk_text);
      expect(text).not.toContain("jacana message number 2 ");
    }
    expect(rows.some((r) => r.chunk_text.includes("kestrel"))).toBe(true);
  });

  it("deleting a message drops the copies of the windows it was in, which change ids", async () => {
    const saved = await seed("org_msgdel", "conv_msgdel", 8, "knot");
    const before = await chunkRows("conv_msgdel");
    const last = saved[7];
    expect(await deleteMessage(makeEnv(), "org_msgdel", "conv_msgdel", last.id)).toBe(true);

    const rows = await chunkRows("conv_msgdel");
    // The windows that held the last message end earlier now, so their ids
    // changed: the old keys must be gone, not just overwritten.
    const replaced = before.filter((b) => !rows.some((r) => r.id === b.id));
    expect(replaced.length).toBeGreaterThan(0);
    expect(await objectKeys("conv_msgdel/")).toEqual(rows.map((r) => `conv_msgdel/${r.id}`).sort());
    for (const r of rows) {
      const text = await objectText(`conv_msgdel/${r.id}`);
      expect(text).toBe(r.chunk_text);
      expect(text).not.toContain("number 8 about");
    }
  });

  it("deleting a conversation removes every copy under its prefix, and nothing under a lookalike", async () => {
    await seed("org_del", "conv_del", 8, "kittiwake");
    await addConversation("org_del", "conv_del_more");
    await appendMessages(makeEnv(), "org_del", "conv_del_more", msgs(3, "lapwing"));
    await chunks.put("conv_del/stray_no_row", "a copy no row points at");
    expect((await objectKeys("conv_del/")).length).toBe(4);
    const neighbour = await objectKeys("conv_del_more/");
    expect(neighbour.length).toBe(1);

    expect(await deleteConversation(makeEnv(), "org_del", "conv_del")).toBe(true);
    expect(await objectKeys("conv_del/")).toEqual([]);
    expect(await objectKeys("conv_del_more/")).toEqual(neighbour);
  });

  it.each([
    ["listing", { list: () => Promise.reject(new Error("r2 list down (test)")) }],
    ["deleting", { delete: () => Promise.reject(new Error("r2 delete down (test)")) }],
  ])("a conversation delete whose chunk sweep fails while %s aborts with everything intact", async (_what, over) => {
    const conv = `conv_delfail_${_what}`;
    const org = `org_delfail_${_what}`;
    const saved = await seed(org, conv, 8, "merlin");
    const rowsBefore = await chunkRows(conv);
    const keysBefore = await objectKeys(`${conv}/`);

    await expect(deleteConversation(makeEnv({ CHUNKS: bucketWith(over) }), org, conv)).rejects.toThrow(/down \(test\)/);

    expect(await db.prepare("SELECT id FROM conversations WHERE id = ?").bind(conv).first()).not.toBeNull();
    const msgCount = await db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?")
      .bind(conv)
      .first<{ n: number }>();
    expect(msgCount?.n).toBe(8);
    expect(await chunkRows(conv)).toEqual(rowsBefore);
    expect(await objectKeys(`${conv}/`)).toEqual(keysBefore);
    for (const m of saved) expect(await content.head(`content/${m.id}`)).not.toBeNull();
  });

  it("the erasure purge removes a deleted org's copies and no one else's", async () => {
    await addOrg("org_gone", { deletedAt: "2020-01-01 00:00:00" });
    await addConversation("org_gone", "conv_gone");
    await appendMessages(makeEnv(), "org_gone", "conv_gone", msgs(8, "nightjar"));
    await seed("org_stays", "conv_stays", 3, "oriole");
    expect((await objectKeys("conv_gone/")).length).toBe(3);
    const kept = await objectKeys("conv_stays/");

    const failures: Array<{ id: string; error: string }> = [];
    const purged = await purgeDeletedOrganizations(makeEnv(), failures);
    expect(failures).toEqual([]);
    expect(purged).toBe(1);

    expect(await objectKeys("conv_gone/")).toEqual([]);
    expect(await chunkRows("conv_gone")).toEqual([]);
    expect(await db.prepare("SELECT id FROM organizations WHERE id = 'org_gone'").first()).toBeNull();
    expect(await objectKeys("conv_stays/")).toEqual(kept);
  });

  // ── Readers of a cleared row ────────────────────────────────────────────

  it("search serves a cleared row's snippet from R2, and the summary if the copy is gone", async () => {
    await seed("org_search", "conv_search", 3, "plover");
    const [row] = await chunkRows("conv_search");
    await clearRow(row.id);
    const env = makeEnv({ aiDown: true }); // keyword search only: no vectors involved

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hits = await searchConversations(env, "org_search", "plover", 5, undefined, undefined, 2000, 0);
      expect(hits.map((h) => h.chunk_id)).toEqual([row.id]);
      expect(hits[0].chunk_text).toBe(row.chunk_text);

      await chunks.delete(`conv_search/${row.id}`);
      const degraded = await searchConversations(env, "org_search", "plover", 5, undefined, undefined, 2000, 0);
      expect(degraded.map((h) => h.chunk_id)).toEqual([row.id]);
      const summary = await db
        .prepare("SELECT chunk_summary FROM conversation_chunks WHERE id = ?")
        .bind(row.id)
        .first<{ chunk_summary: string | null }>();
      expect(degraded[0].chunk_text).toBe(summary?.chunk_summary ?? "");
    } finally {
      errors.mockRestore();
    }
  });

  it("the content repair rebuilds a lost body from a cleared chunk's copy, and refuses without one", async () => {
    const saved = await seed("org_integrity", "conv_integrity", 3, "quail");
    const [row] = await chunkRows("conv_integrity");
    await clearRow(row.id);
    const victim = saved[1];
    await content.delete(`content/${victim.id}`);
    const env = makeEnv();

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await scanContentIntegrity(env, {
        organizationId: "org_integrity",
        conversationId: "conv_integrity",
        repair: true,
      });
      expect(res.unrecoverable).toEqual([]);
      expect(res.repaired.map((r) => [r.id, r.source_chunk])).toEqual([[victim.id, row.id]]);
      const restored = await content.get(`content/${victim.id}`);
      expect(restored).not.toBeNull();

      // Lose the body again, and this time the chunk's copy too.
      await content.delete(`content/${victim.id}`);
      await chunks.delete(`conv_integrity/${row.id}`);
      const res2 = await scanContentIntegrity(env, {
        organizationId: "org_integrity",
        conversationId: "conv_integrity",
        repair: true,
      });
      expect(res2.repaired).toEqual([]);
      expect(res2.unrecoverable.map((u) => u.id)).toEqual([victim.id]);
      expect(res2.unrecoverable[0].reason).toContain("chunk text unavailable for 1 piece");
      expect(await content.head(`content/${victim.id}`)).toBeNull(); // nothing invented
    } finally {
      errors.mockRestore();
      logs.mockRestore();
    }
  });

  it("an org merge rebuilds keyword search for a cleared row from R2, and moves nothing if a copy is missing", async () => {
    await seed("org_mergefrom", "conv_merge", 3, "redshank");
    await addOrg("org_mergeto");
    const [row] = await chunkRows("conv_merge");
    await clearRow(row.id);
    const env = makeEnv();

    await moveConversation(env, "conv_merge", "org_mergefrom", "org_mergeto");
    const inTo = await searchChunksFts(db, "redshank", "org_mergeto", 10);
    expect(inTo.results.map((r) => r.chunk_id)).toEqual([row.id]);
    const inFrom = await searchChunksFts(db, "redshank", "org_mergefrom", 10);
    expect(inFrom.results).toEqual([]);

    // Second conversation, its cleared row's copy gone: refused before any change.
    await seed("org_mergefrom2", "conv_merge2", 3, "sanderling");
    const [row2] = await chunkRows("conv_merge2");
    await clearRow(row2.id);
    await chunks.delete(`conv_merge2/${row2.id}`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(moveConversation(env, "conv_merge2", "org_mergefrom2", "org_mergeto")).rejects.toThrow(
        /nothing moved/,
      );
    } finally {
      errors.mockRestore();
    }
    const orgs = await db
      .prepare(
        `SELECT (SELECT organization_id FROM conversations WHERE id = 'conv_merge2') AS conv,
                (SELECT COUNT(*) FROM conversation_chunks WHERE conversation_id = 'conv_merge2' AND organization_id <> 'org_mergefrom2') AS chunks_moved,
                (SELECT COUNT(*) FROM messages WHERE conversation_id = 'conv_merge2' AND organization_id <> 'org_mergefrom2') AS msgs_moved`,
      )
      .first<{ conv: string; chunks_moved: number; msgs_moved: number }>();
    expect(orgs).toEqual({ conv: "org_mergefrom2", chunks_moved: 0, msgs_moved: 0 });
    const still = await searchChunksFts(db, "sanderling", "org_mergefrom2", 10);
    expect(still.results.map((r) => r.chunk_id)).toEqual([row2.id]);
  });

  it("the FTS backfill indexes a cleared row from R2 and leaves an unreadable one for a later run", async () => {
    await seed("org_backfill", "conv_backfill", 11, "turnstone");
    const rows = await chunkRows("conv_backfill");
    expect(rows.length).toBe(4);
    const [readable, unreadable] = [rows[0], rows[1]];
    await clearRow(readable.id);
    await clearRow(unreadable.id);
    await chunks.delete(`conv_backfill/${unreadable.id}`);

    // Drop this conversation from the index, as a lost or rebuilt index would.
    const fts = await db
      .prepare("SELECT fts_rowid FROM conversation_chunks WHERE conversation_id = 'conv_backfill'")
      .all<{ fts_rowid: number }>();
    for (const { fts_rowid } of fts.results) {
      await db.prepare("DELETE FROM chunks_fts_v2 WHERE rowid = ?").bind(fts_rowid).run();
    }
    await db.prepare("UPDATE conversation_chunks SET fts_rowid = NULL WHERE conversation_id = 'conv_backfill'").run();
    const pending = await db
      .prepare("SELECT COUNT(*) AS n FROM conversation_chunks WHERE fts_rowid IS NULL")
      .first<{ n: number }>();
    expect(pending?.n).toBe(4); // only this conversation's rows are unindexed

    const app = new Hono<{ Bindings: Env }>();
    app.route("/admin", admin);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let body: { indexed: number; unavailable: number };
    try {
      const res = await app.request("/admin/backfill-fts?batch=50&after=0", { method: "POST" }, makeEnv());
      expect(res.status).toBe(200);
      body = (await res.json()) as typeof body;
    } finally {
      errors.mockRestore();
    }
    expect(body).toMatchObject({ indexed: 3, unavailable: 1 });

    const after = await db
      .prepare("SELECT id, fts_rowid FROM conversation_chunks WHERE conversation_id = 'conv_backfill'")
      .all<{ id: string; fts_rowid: number | null }>();
    for (const r of after.results) {
      if (r.id === unreadable.id) expect(r.fts_rowid).toBeNull();
      else expect(r.fts_rowid).not.toBeNull();
    }
    const hits = await searchChunksFts(db, "turnstone", "org_backfill", 10);
    expect(hits.results.map((r) => r.chunk_id).sort()).toEqual(
      rows.filter((r) => r.id !== unreadable.id).map((r) => r.id).sort(),
    );
  });
});
