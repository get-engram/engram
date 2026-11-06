import {
  getChunkCopyPage,
  getChunkOwnersByIds,
  getChunkTextsByIds,
  type ChunkCopyRow,
} from "@getengram/db";
import {
  chunkObjectKey,
  deleteChunkObjects,
  isTextInR2Only,
  parseChunkObjectKey,
  putChunkTexts,
  type ChunkCopy,
} from "./chunk-store.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import type { Env } from "../types.js";

/**
 * One page of the engram#384 chunk job: copy chunk text to R2, verify the
 * copies against D1, or sweep the copies no row points at. Driven by
 * ChunkMoverDO; see chunk-store.ts for the plan. Nothing here writes to D1.
 *
 *   copy    — put every row's text to R2 (an existing object is overwritten
 *             with the same bytes).
 *   verify  — read every object back and compare it with the row exactly;
 *             with repair, rewrite the missing and mismatched ones.
 *   orphans — list the bucket and find the objects whose row is gone
 *             (engram#557); with delete, remove them. See runOrphanSweepBatch.
 *
 * A row whose text has already been cleared to R2 (stage 2 onward) has no
 * other copy: copy and verify both check its object is there and report it
 * as `lost` if not. Counts, chunk ids and object keys only — no text leaves
 * this module.
 */

/** The modes that walk conversation_chunks by rowid. */
export type ChunkRowMode = "copy" | "verify";
export type ChunkMoverMode = ChunkRowMode | "orphans";

/** Rows per page: one bounded rowid-range read of D1. */
export const MOVER_PAGE = 100;
/** R2 requests in flight at once. */
const R2_CONCURRENCY = 25;

export interface ChunkMoverCounts {
  /** Rows read (copy, verify) or objects listed (orphans). */
  scanned: number;
  /** copy: objects written. */
  copied: number;
  /** Puts that failed twice; the row is untouched and still holds the text. */
  putFailed: number;
  /** verify: object identical to the row. */
  ok: number;
  /** verify: no object for a row. */
  missing: number;
  /** verify: object differs from the row. */
  mismatched: number;
  /** verify + repair: missing or mismatched objects rewritten. */
  repaired: number;
  /**
   * copy, verify: row rewritten while its page was in flight; object
   * rewritten from the row as it is now.
   * orphans: orphan whose row came back, or whose object changed, before the
   * delete; kept.
   */
  raced: number;
  /**
   * copy, verify: row deleted while its page was in flight; its object removed.
   * orphans: orphaned object deleted.
   */
  orphansRemoved: number;
  /** Cleared row whose object is there. */
  clearedOk: number;
  /** Cleared row whose object is NOT there: the text exists nowhere. */
  lost: number;
  /** orphans: object a row still points at. */
  live: number;
  /** orphans: object written inside the settle window, so not judged this run. */
  young: number;
  /** orphans: object no row points at. Deleted only when the run deletes. */
  orphans: number;
  /** orphans: key the save path would not have made. Never touched. */
  unrecognized: number;
  /** orphans: the chunk's row belongs to another conversation. Reported, never touched. */
  misfiled: number;
}

export interface ChunkMoverBatch extends ChunkMoverCounts {
  /** Rowid to resume after. */
  nextAfter: number;
  /** The page was short: nothing after it when it was read. */
  done: boolean;
  /** Chunk ids with a problem (missing, mismatched, failed, lost). */
  problems: string[];
}

export function emptyCounts(): ChunkMoverCounts {
  return {
    scanned: 0,
    copied: 0,
    putFailed: 0,
    ok: 0,
    missing: 0,
    mismatched: 0,
    repaired: 0,
    raced: 0,
    orphansRemoved: 0,
    clearedOk: 0,
    lost: 0,
    live: 0,
    young: 0,
    orphans: 0,
    unrecognized: 0,
    misfiled: 0,
  };
}

const keyOf = (r: { conversation_id: string; id: string }) => chunkObjectKey(r.conversation_id, r.id);

export async function runChunkMoverBatch(
  env: Env,
  opts: {
    mode: ChunkRowMode;
    after: number;
    org?: string | null;
    repair?: boolean;
    limit?: number;
  },
): Promise<ChunkMoverBatch> {
  const limit = opts.limit ?? MOVER_PAGE;
  const page = await getChunkCopyPage(env.DB, opts.after, limit, opts.org ?? null);
  const rows = page.results ?? [];
  const out: ChunkMoverBatch = {
    ...emptyCounts(),
    scanned: rows.length,
    nextAfter: rows.length > 0 ? rows[rows.length - 1].rid : opts.after,
    done: rows.length < limit,
    problems: [],
  };

  const cleared = rows.filter(isTextInR2Only);
  const inline = rows.filter((r) => !isTextInR2Only(r));

  if (cleared.length > 0) {
    const present = await mapConcurrent(cleared, R2_CONCURRENCY, async (r) =>
      (await env.CHUNKS.head(keyOf(r))) !== null,
    );
    cleared.forEach((r, i) => {
      if (present[i]) out.clearedOk++;
      else {
        out.lost++;
        out.problems.push(r.id);
      }
    });
  }

  let toWrite: ChunkCopyRow[];
  if (opts.mode === "copy") {
    toWrite = inline;
  } else {
    const verdicts = await mapConcurrent(inline, R2_CONCURRENCY, async (r) => {
      const obj = await env.CHUNKS.get(keyOf(r));
      if (!obj) return "missing" as const;
      return (await obj.text()) === r.chunk_text ? ("ok" as const) : ("mismatched" as const);
    });
    toWrite = [];
    inline.forEach((r, i) => {
      const v = verdicts[i];
      out[v]++;
      if (v === "ok") return;
      out.problems.push(r.id);
      if (opts.repair) toWrite.push(r);
    });
  }

  if (toWrite.length > 0) {
    const failed = await putChunkTexts(
      env,
      toWrite.map((r) => ({ key: keyOf(r), text: r.chunk_text })),
      R2_CONCURRENCY,
    );
    const failedKeys = new Set(failed.map((f) => f.key));
    const written = toWrite.filter((r) => !failedKeys.has(keyOf(r)));
    out.putFailed += failed.length;
    for (const r of toWrite) if (failedKeys.has(keyOf(r))) out.problems.push(r.id);
    if (opts.mode === "copy") out.copied += written.length;
    else out.repaired += written.length;
    await reconcile(env, written, out);
  }

  return out;
}

/**
 * Check what was just written against the rows as they are now. The page
 * was read before the puts, and a save or delete may have landed since:
 *  - row gone: the conversation or message was deleted and its delete has
 *    already swept R2, so this put re-created text the user removed —
 *    delete it again;
 *  - row rewritten: the object holds the old text — rewrite it from the
 *    row, and if that fails remove it rather than leave stale text;
 *  - row cleared since: the clear verified its object; nothing to do.
 */
async function reconcile(env: Env, written: ChunkCopyRow[], out: ChunkMoverBatch): Promise<void> {
  if (written.length === 0) return;
  const now = new Map(
    (await getChunkTextsByIds(env.DB, written.map((r) => r.id))).map((r) => [r.id, r]),
  );
  const gone: string[] = [];
  const changed: ChunkCopy[] = [];
  for (const r of written) {
    const cur = now.get(r.id);
    if (!cur) gone.push(keyOf(r));
    else if (!isTextInR2Only(cur) && cur.chunk_text !== r.chunk_text) {
      changed.push({ key: keyOf(r), text: cur.chunk_text });
    }
  }
  if (gone.length > 0) {
    await deleteChunkObjects(env, gone);
    out.orphansRemoved += gone.length;
  }
  if (changed.length > 0) {
    out.raced += changed.length;
    const failed = await putChunkTexts(env, changed, R2_CONCURRENCY);
    if (failed.length > 0) {
      out.putFailed += failed.length;
      await deleteChunkObjects(env, failed.map((f) => f.key));
    }
  }
}

/** Keys per orphan-sweep page: the most one R2 list call returns. */
export const ORPHAN_PAGE = 1000;

/**
 * Objects written less than this long ago are not judged. A save writes its
 * rows before its objects, and a reindex re-creates a chunk under the same
 * deterministic id moments after deleting it, so a recent object with no row
 * is usually mid-request. A day is far longer than any request; an object
 * orphaned inside it is the next run's to remove.
 */
export const ORPHAN_SETTLE_MS = 24 * 60 * 60 * 1000;

export interface OrphanSweepBatch extends ChunkMoverCounts {
  /** Last key of this page; the next page lists after it. */
  nextAfterKey: string | null;
  /** The listing ended with this page. */
  done: boolean;
  /** This page's orphans would pass the run's delete cap, so none were deleted. */
  capped: boolean;
  /** Keys of the orphaned, misfiled and unrecognized objects (ids only). */
  problems: string[];
}

/**
 * One page of the orphan sweep (engram#557): list up to ORPHAN_PAGE keys of
 * the CHUNKS bucket after `after`, and find the objects no
 * conversation_chunks row points at — copies that outlived their row in one
 * of the narrow races a delete can lose to a save or to the copy job. None
 * of them can hold a memory's only copy: D1 holds every row's text in stage
 * 1, and a cleared row is a row, so its object is live. They matter for
 * erasure — text a user deleted or redacted should persist nowhere.
 *
 * An object is deleted only when every one of these holds:
 *  - the run deletes (report-only otherwise);
 *  - its key is `<conversation_id>/chk_…`, as the save path makes them;
 *  - it was written more than `settleMs` ago;
 *  - no row has its chunk id, read once to judge and again just before the
 *    delete — ids are deterministic, so a reindex can re-create the row;
 *  - the object is still the one listed (same etag and upload time), so a
 *    delete by key never removes a copy put since the listing;
 *  - the page's orphans fit in what is left of the run's delete cap. A page
 *    with more deletes nothing and stops the run (`capped`), so a mistake in
 *    any of the above can cost at most the cap, not the bucket.
 * A row in another conversation is reported as misfiled and left alone.
 *
 * Reads ids from D1 (a primary-key lookup per 90 keys), never text.
 */
export async function runOrphanSweepBatch(
  env: Env,
  opts: {
    after: string | null;
    deleteOrphans: boolean;
    /** Objects this page may still delete. */
    deleteBudget: number;
    limit?: number;
    settleMs?: number;
    now?: number;
  },
): Promise<OrphanSweepBatch> {
  const limit = opts.limit ?? ORPHAN_PAGE;
  const settleMs = opts.settleMs ?? ORPHAN_SETTLE_MS;
  const now = opts.now ?? Date.now();

  const listed = await env.CHUNKS.list({
    limit,
    ...(opts.after !== null ? { startAfter: opts.after } : {}),
  });
  const objects = listed.objects;
  // Paging is by the last key listed, so a page with no keys that says more
  // remain would list the same nothing forever. Fail it instead: the run
  // backs off and, if it keeps happening, stops with this as its lastError.
  if (objects.length === 0 && listed.truncated) {
    const at = opts.after === null ? "the start of the bucket" : `key ${opts.after}`;
    throw new Error(`the listing after ${at} returned no keys but says more remain`);
  }
  const out: OrphanSweepBatch = {
    ...emptyCounts(),
    scanned: objects.length,
    nextAfterKey: objects.length > 0 ? objects[objects.length - 1].key : opts.after,
    done: !listed.truncated,
    capped: false,
    problems: [],
  };

  const judged: Array<{
    key: string;
    conversationId: string;
    chunkId: string;
    etag: string;
    uploaded: number;
  }> = [];
  for (const o of objects) {
    const parts = parseChunkObjectKey(o.key);
    if (!parts) {
      out.unrecognized++;
      out.problems.push(o.key);
    } else if (now - o.uploaded.getTime() < settleMs) {
      out.young++;
    } else {
      judged.push({ key: o.key, ...parts, etag: o.etag, uploaded: o.uploaded.getTime() });
    }
  }
  if (judged.length === 0) return out;

  const owners = await chunkOwners(env, judged.map((j) => j.chunkId));
  const orphaned: typeof judged = [];
  for (const j of judged) {
    const owner = owners.get(j.chunkId);
    if (owner === undefined) orphaned.push(j);
    else if (owner === j.conversationId) out.live++;
    else {
      out.misfiled++;
      out.problems.push(j.key);
    }
  }
  out.orphans = orphaned.length;
  for (const j of orphaned) out.problems.push(j.key);
  if (!opts.deleteOrphans || orphaned.length === 0) return out;

  if (orphaned.length > opts.deleteBudget) {
    out.capped = true;
    out.done = false;
    out.nextAfterKey = opts.after;
    return out;
  }

  // Look again at the last moment and keep anything that moved since the
  // listing. First the object: a put since then (a reindex re-creates
  // chunks under the same key) is not what was judged. Then the row, last,
  // so it is the read nearest the delete.
  const unchanged = await mapConcurrent(orphaned, R2_CONCURRENCY, async (j) => {
    const head = await env.CHUNKS.head(j.key);
    return head !== null && head.etag === j.etag && head.uploaded.getTime() === j.uploaded;
  });
  const stillThere = orphaned.filter((_, i) => unchanged[i]);
  const again = await chunkOwners(env, stillThere.map((j) => j.chunkId));
  const doomed = stillThere.filter((j) => !again.has(j.chunkId));
  out.raced += orphaned.length - doomed.length;
  if (doomed.length > 0) {
    await deleteChunkObjects(env, doomed.map((j) => j.key));
    out.orphansRemoved += doomed.length;
  }
  return out;
}

/** chunk id → conversation id, for the ids that still have a row. */
async function chunkOwners(env: Env, chunkIds: string[]): Promise<Map<string, string>> {
  if (chunkIds.length === 0) return new Map();
  const unique = [...new Set(chunkIds)];
  const rows = await getChunkOwnersByIds(env.DB, unique);
  return new Map(rows.map((r) => [r.id, r.conversation_id]));
}
