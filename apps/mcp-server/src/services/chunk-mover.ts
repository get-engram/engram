import {
  CHUNK_CLEAR_MAX_ROWS,
  clearChunkTexts,
  getChunkClearPage,
  getChunkCopyPage,
  getChunkOwnersByIds,
  getChunkTextsByIds,
  restoreChunkTexts,
  type ChunkCopyRow,
} from "@getengram/db";
import {
  CHUNK_R2_ENCODING,
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
 * copies against D1, clear the column once its copy is verified, or sweep
 * the copies no row points at. Driven by ChunkMoverDO; see chunk-store.ts
 * for the plan. Only clear writes to D1.
 *
 *   copy    — put every row's text to R2 (an existing object is overwritten
 *             with the same bytes).
 *   verify  — read every object back and compare it with the row exactly;
 *             with repair, rewrite the missing and mismatched ones.
 *   clear   — read every settled row's object back, and empty the column of
 *             each row whose object matches it exactly. See
 *             runChunkClearBatch.
 *   orphans — list the bucket and find the objects whose row is gone
 *             (engram#557); with delete, remove them. See runOrphanSweepBatch.
 *
 * A row whose text has already been cleared to R2 has no other copy: every
 * mode that walks rows checks its object is there and reports it as `lost`
 * if not. Counts, chunk ids and object keys only — no text leaves this
 * module.
 */

/** The modes that copy or compare, walking conversation_chunks by rowid. */
export type ChunkRowMode = "copy" | "verify";
export type ChunkMoverMode = ChunkRowMode | "clear" | "orphans";

/** Rows per page: one bounded rowid-range read of D1. */
export const MOVER_PAGE = 100;
/**
 * Rows per clear page: as many as one clear transaction takes, so a page's
 * clear either committed or did not (clearChunkTexts).
 */
export const CLEAR_PAGE = CHUNK_CLEAR_MAX_ROWS;
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
  /** verify: no object for a row. clear: the same, so the row was not cleared. */
  missing: number;
  /** verify: object differs from the row. clear: the same, so the row was not cleared. */
  mismatched: number;
  /** verify + repair: missing or mismatched objects rewritten. */
  repaired: number;
  /**
   * copy, verify: row rewritten while its page was in flight; object
   * rewritten from the row as it is now.
   * clear: row rewritten or deleted between the read and the clear, so not
   * cleared; or cleared, then rewritten or deleted before a restore.
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
  /** clear: column emptied; the row's text is now in R2 only. */
  cleared: number;
  /**
   * clear: emptied, then the object was gone or different when checked
   * again straight after; the column was given back the text just verified.
   */
  restored: number;
  /** clear: nothing to clear (empty text) or an encoding it does not know. */
  skipped: number;
  /** orphans: object a row still points at. */
  live: number;
  /**
   * orphans: object written inside the settle window, so not judged this run.
   * clear: row written inside the settle window, so not cleared this run.
   */
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
    cleared: 0,
    restored: 0,
    skipped: 0,
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

  await checkClearedRows(env, rows.filter(isTextInR2Only), out);
  const inline = rows.filter((r) => !isTextInR2Only(r));

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

/** A cleared row's object is its only copy: count whether each is there. */
async function checkClearedRows(
  env: Env,
  cleared: Array<{ id: string; conversation_id: string }>,
  out: ChunkMoverBatch,
): Promise<void> {
  if (cleared.length === 0) return;
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

/**
 * Rows last written less recently than this are cleared; newer ones wait for
 * a later run. Chunk ids are deterministic and R2 is last-writer-wins, so a
 * rewrite racing the clear could pair a new row with an older object; every
 * rewrite resets created_at (INSERT OR REPLACE) and puts its object in the
 * same request, so a row unchanged for a whole day has no put in flight. A
 * day is far longer than any request.
 */
export const CLEAR_SETTLE_SECONDS = 24 * 60 * 60;

/** Tries at giving a row its text back (see runChunkClearBatch), and the pause before each retry. */
const RESTORE_ATTEMPTS = 3;
const RESTORE_RETRY_MS = 250;

/**
 * A clear page could not give rows their text back after their objects went
 * missing or changed. Those rows may now have their text nowhere, so the
 * run stops rather than clear more; the message names the chunk ids.
 */
export class ChunkRestoreError extends Error {
  constructor(
    readonly chunkIds: string[],
    cause: unknown,
  ) {
    super(
      `could not restore ${chunkIds.length} cleared chunks whose objects went missing or changed: ${chunkIds.join(",")}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ChunkRestoreError";
  }
}

/**
 * One page of the clear (engram#384 stage 2): the step that leaves a row's
 * text in R2 only. A row is cleared only when every one of these holds:
 *  - it is inline (chunk_encoding NULL), its text is not empty, and it was
 *    last written more than CLEAR_SETTLE_SECONDS ago;
 *  - its object, read back now, holds exactly the row's text — read the way
 *    every reader reads it (loadChunkTexts: obj.text()), so what a reader
 *    gets after the clear is the column's text, character for character;
 *  - at the moment of the update the row still holds that text, is still
 *    unmarked, and is still settled (clearChunkTexts' guard).
 * Then each cleared object is checked once more. One gone or changed since
 * it was read means a delete or reindex of that chunk raced the clear; were
 * that request to stop halfway, the row would be left with its text
 * nowhere, so the row gets back the text just verified.
 *
 * A page clears in one transaction. If the write fails, the rows are read
 * back to learn whether it committed: if none was cleared the page throws
 * and runs again; if they cannot be read back, every row it tried is
 * checked as above (a restore touches only a row that is still cleared)
 * and then the page throws. A restore that keeps failing throws
 * ChunkRestoreError, which stops the run.
 *
 * Bounded by `upto`, the highest rowid when the run started: a cleared row
 * moves above it (see clearChunkTexts). Rows already cleared are checked as
 * in copy and verify. Reads text from D1 and R2; writes only the column.
 */
export async function runChunkClearBatch(
  env: Env,
  opts: {
    after: number;
    upto: number;
    org?: string | null;
    limit?: number;
    settleSeconds?: number;
  },
): Promise<ChunkMoverBatch> {
  const limit = Math.min(opts.limit ?? CLEAR_PAGE, CLEAR_PAGE);
  const settleSeconds = opts.settleSeconds ?? CLEAR_SETTLE_SECONDS;
  const page = await getChunkClearPage(env.DB, {
    after: opts.after,
    upto: opts.upto,
    limit,
    settleSeconds,
    organizationId: opts.org ?? null,
  });
  const rows = page.results ?? [];
  const out: ChunkMoverBatch = {
    ...emptyCounts(),
    scanned: rows.length,
    nextAfter: rows.length > 0 ? rows[rows.length - 1].rid : opts.after,
    done: rows.length < limit,
    problems: [],
  };

  await checkClearedRows(env, rows.filter(isTextInR2Only), out);

  const candidates: ChunkCopyRow[] = [];
  for (const r of rows) {
    if (isTextInR2Only(r)) continue;
    if (r.chunk_encoding !== null) {
      // Text in the column but an encoding set: nothing writes this, so it
      // is not this job's to guess at.
      out.skipped++;
      out.problems.push(r.id);
    } else if (r.chunk_text === "") {
      out.skipped++;
    } else if (r.settled !== 1) {
      out.young++;
    } else {
      candidates.push(r);
    }
  }

  const reads = await mapConcurrent(candidates, R2_CONCURRENCY, async (r) => {
    const obj = await env.CHUNKS.get(keyOf(r));
    if (!obj) return null;
    return { text: await obj.text(), etag: obj.etag };
  });
  const matched: Array<{ row: ChunkCopyRow; etag: string }> = [];
  candidates.forEach((r, i) => {
    const read = reads[i];
    if (read === null) {
      out.missing++;
      out.problems.push(r.id);
    } else if (read.text !== r.chunk_text) {
      out.mismatched++;
      out.problems.push(r.id);
    } else {
      matched.push({ row: r, etag: read.etag });
    }
  });
  if (matched.length === 0) return out;

  const toClear = matched.map((m) => ({ id: m.row.id, text: m.row.chunk_text }));
  let changed: boolean[] | null;
  let writeError: unknown = null;
  try {
    changed = await clearChunkTexts(env.DB, toClear, { encoding: CHUNK_R2_ENCODING, settleSeconds });
  } catch (err) {
    // One transaction, but a failure can still have committed with its
    // reply lost. The rows know: one inline at the page read and cleared
    // now was cleared here.
    writeError = err;
    console.error(
      `[chunk-mover] clear write failed after rowid ${opts.after}; reading the rows back: ${errText(err)}`,
    );
    try {
      const now = new Map(
        (await getChunkTextsByIds(env.DB, toClear.map((r) => r.id))).map((r) => [r.id, r]),
      );
      changed = toClear.map((r) => {
        const cur = now.get(r.id);
        return cur !== undefined && isTextInR2Only(cur);
      });
    } catch (readErr) {
      console.error(
        `[chunk-mover] could not read them back either; checking the object of every row tried: ${errText(readErr)}`,
      );
      changed = null;
    }
    // Nothing cleared: nothing to check, and the page runs again.
    if (changed !== null && !changed.includes(true)) throw err;
  }

  // The rows this page may have cleared: those that changed, or every row it
  // tried when that cannot be known.
  const known = changed;
  const justCleared = known === null ? matched : matched.filter((_, i) => known[i]);
  if (known !== null) out.raced += matched.length - justCleared.length;
  if (justCleared.length === 0) return out;

  // Look once more. An object deleted or replaced since it was read leaves
  // the row with no text anywhere, so put the text back in the column. A
  // check that fails counts as gone: restoring a row that did not need it
  // only delays its clear to a later run.
  const stayed = await mapConcurrent(justCleared, R2_CONCURRENCY, async (m) => {
    try {
      const head = await env.CHUNKS.head(keyOf(m.row));
      return head !== null && head.etag === m.etag;
    } catch {
      return false;
    }
  });
  const undo = justCleared.filter((_, i) => !stayed[i]);
  if (known !== null) out.cleared += justCleared.length - undo.length;

  if (undo.length > 0) {
    const restored = await restoreWithRetry(
      env,
      undo.map((m) => ({ id: m.row.id, text: m.row.chunk_text })),
    );
    undo.forEach((m, i) => {
      out.problems.push(m.row.id);
      if (restored[i]) out.restored++;
      else out.raced++;
    });
  }
  // The write's outcome is unknown, so this page's counts would be guesses:
  // fail it. Its rows that were cleared have moved past the cursor and been
  // checked above; the rest are read again.
  if (known === null) {
    console.error(
      `[chunk-mover] clear outcome unknown after rowid ${opts.after}: checked the objects of ${justCleared.length} rows, ` +
        `${undo.length} gone or changed, ${out.restored} given their text back; failing the page`,
    );
    throw writeError;
  }
  return out;
}

/**
 * restoreChunkTexts, retried: its guard makes a second run harmless (a row
 * an earlier, lost-reply attempt restored just reports false, counted as
 * raced). Throws ChunkRestoreError once every try has failed.
 */
async function restoreWithRetry(env: Env, rows: Array<{ id: string; text: string }>): Promise<boolean[]> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    try {
      return await restoreChunkTexts(env.DB, rows, CHUNK_R2_ENCODING);
    } catch (err) {
      lastError = err;
      if (attempt < RESTORE_ATTEMPTS) await new Promise((r) => setTimeout(r, RESTORE_RETRY_MS * attempt));
    }
  }
  const failure = new ChunkRestoreError(
    rows.map((r) => r.id),
    lastError,
  );
  console.error(`[chunk-mover] ${failure.message}`);
  throw failure;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
