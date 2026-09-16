import {
  getExpiredOrganizations,
  getVectorizeIdsByOrganizationPage,
  getR2MessageIdsByOrganizationPage,
  deleteOrganizationById,
} from "@getengram/db";
import { deleteContent } from "../services/content-store.js";
import type { Env } from "../types.js";

// Page size for streaming an org's ids out of D1. Small enough that even a
// multi-million-row org never holds more than this many ids in the 128MB
// isolate at once; large enough that a normal org finishes in one page.
const PAGE = 1000;

/**
 * Permanently deletes organizations whose deleted_at is older than 30 days.
 * Called by the Workers cron trigger (daily).
 *
 * Two resilience properties matter here, because this is the path a
 * right-to-erasure request runs through:
 *
 * 1. Per-org isolation. The whole body for one org is wrapped so a single
 *    failure (a huge org, a transient R2/Vectorize error, a bad row) leaves
 *    that org intact for the next run and does NOT strand every other deleted
 *    org behind it. Previously only the R2 step was guarded.
 * 2. Streaming, not slurping. Vector ids and R2 keys are paged out of D1 by
 *    rowid instead of loaded all at once, so erasing a multi-million-message
 *    org can't OOM the isolate and take the whole purge down with it.
 */
export async function purgeDeletedOrganizations(env: Env): Promise<number> {
  const expired = await getExpiredOrganizations(env.DB, 50);
  let purged = 0;

  for (const { id } of expired.results) {
    try {
      // --- Vectors: page by rowid, delete in batches ---------------------
      let cursor = 0;
      for (;;) {
        const page = await getVectorizeIdsByOrganizationPage(env.DB, id, cursor, PAGE);
        const rows = page.results ?? [];
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.vectorize_id).filter(Boolean);
        if (ids.length > 0) await env.VECTORIZE.deleteByIds(ids);
        cursor = rows[rows.length - 1].rid;
        if (rows.length < PAGE) break;
      }

      // --- R2 bodies: page by rowid, delete in batches -------------------
      // Must complete BEFORE the D1 rows go — the message ids ARE the R2
      // keys, so once the rows are deleted the objects can't be found. A
      // failure here throws out to the per-org catch below, leaving the org's
      // deleted_at intact for retry rather than reporting a deletion we did
      // not perform.
      let r2Purged = 0;
      cursor = 0;
      for (;;) {
        const page = await getR2MessageIdsByOrganizationPage(env.DB, id, cursor, PAGE);
        const rows = page.results ?? [];
        if (rows.length === 0) break;
        r2Purged += await deleteContent(env, rows.map((r) => r.id));
        cursor = rows[rows.length - 1].rid;
        if (rows.length < PAGE) break;
      }

      // --- D1: hard-delete (cascade handles children) --------------------
      await deleteOrganizationById(env.DB, id);
      purged++;
      console.log(`[purge] Hard-deleted org ${id} (${r2Purged} R2 objects)`);
    } catch (err) {
      // Isolate: this org stays intact (deleted_at set) and is retried next
      // run; every other expired org still gets processed this run.
      console.error(
        `[purge] org ${id} FAILED — left intact for retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
  }

  return purged;
}
