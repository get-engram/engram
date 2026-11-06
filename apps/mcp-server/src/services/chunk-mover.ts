import { getChunkCopyPage, getChunkTextsByIds, type ChunkCopyRow } from "@getengram/db";
import {
  chunkObjectKey,
  deleteChunkObjects,
  isTextInR2Only,
  putChunkTexts,
  type ChunkCopy,
} from "./chunk-store.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import type { Env } from "../types.js";

/**
 * One page of the engram#384 chunk job: copy chunk text to R2, or verify
 * the copies against D1. Driven by ChunkMoverDO; see chunk-store.ts for the
 * plan. Nothing here writes to D1.
 *
 *   copy   — put every row's text to R2 (an existing object is overwritten
 *            with the same bytes).
 *   verify — read every object back and compare it with the row exactly;
 *            with repair, rewrite the missing and mismatched ones.
 *
 * A row whose text has already been cleared to R2 (stage 2 onward) has no
 * other copy: both modes check its object is there and report it as `lost`
 * if not. Counts and chunk ids only — no text leaves this function.
 */

export type ChunkMoverMode = "copy" | "verify";

/** Rows per page: one bounded rowid-range read of D1. */
export const MOVER_PAGE = 100;
/** R2 requests in flight at once. */
const R2_CONCURRENCY = 25;

export interface ChunkMoverCounts {
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
  /** Row rewritten while its page was in flight; object rewritten from the row as it is now. */
  raced: number;
  /** Row deleted while its page was in flight; its object removed. */
  orphansRemoved: number;
  /** Cleared row whose object is there. */
  clearedOk: number;
  /** Cleared row whose object is NOT there: the text exists nowhere. */
  lost: number;
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
  };
}

const keyOf = (r: { conversation_id: string; id: string }) => chunkObjectKey(r.conversation_id, r.id);

export async function runChunkMoverBatch(
  env: Env,
  opts: {
    mode: ChunkMoverMode;
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
