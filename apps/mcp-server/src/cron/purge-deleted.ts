import {
  getExpiredOrganizations,
  getChunkPurgeBatch,
  deleteChunkRowsAndFts,
  getMessagePurgeBatch,
  deleteMessageRowsByIds,
  countOrgHeavyData,
  deleteOrganizationById,
} from "@getengram/db";
import { deleteContent } from "../services/content-store.js";
import type { Env } from "../types.js";

// Rows fetched+deleted per IN(...) statement. Kept at a value D1 handles
// comfortably as bound parameters, and Vectorize/R2 accept per call.
const BATCH = 1000;
// Ceiling on rows drained PER STORE, PER ORG, PER RUN. This is the bound that
// makes a huge deleted org safe: instead of attempting the whole thing in one
// invocation (which threw and got skipped forever for ~6k-message orgs), each
// run takes a fixed bite and the org resumes next run until it's empty. Sized
// so a typical large org (a few thousand messages) fully drains in one run,
// while a pathological one (100k+) still completes over a bounded number of
// nights without ever exceeding the worker's CPU/subrequest budget.
const MAX_PER_STORE_PER_RUN = 10_000;

/**
 * Permanently deletes organizations whose deleted_at is older than 30 days.
 * Called by the Workers cron trigger (daily). This is the right-to-erasure
 * path, so correctness and completeness matter more than speed.
 *
 * Resumable + bounded: an org's chunks (and their Vectorize vectors + FTS
 * rows) and messages (and their R2 bodies) are drained in bounded batches;
 * the org row is dropped ONLY once no heavy data remains. Every step is
 * idempotent, so a partial run simply continues next run — a failure or a
 * giant org can never again wedge the purge or strand other orgs.
 *
 * Returns the number of orgs FULLY purged this run (orgs still draining are
 * counted separately in the logs).
 */
export async function purgeDeletedOrganizations(env: Env): Promise<number> {
  const expired = await getExpiredOrganizations(env.DB, 25);
  let purged = 0;
  let draining = 0;

  for (const { id } of expired.results) {
    try {
      // ── Drain chunks: Vectorize vectors + FTS rows + chunk rows ──────────
      // Vectors and FTS go before the chunk rows so a mid-batch failure just
      // retries next run (deleting an already-gone vector/row is a no-op).
      let chunkDone = 0;
      while (chunkDone < MAX_PER_STORE_PER_RUN) {
        const batch = await getChunkPurgeBatch(env.DB, id, BATCH);
        const rows = batch.results ?? [];
        if (rows.length === 0) break;
        const vectorIds = rows.map((r) => r.vectorize_id).filter((v): v is string => !!v);
        if (vectorIds.length > 0) await env.VECTORIZE.deleteByIds(vectorIds);
        await deleteChunkRowsAndFts(
          env.DB,
          rows.map((r) => r.id),
          rows.map((r) => r.fts_rowid).filter((n): n is number => n != null),
        );
        chunkDone += rows.length;
        if (rows.length < BATCH) break;
      }

      // ── Drain messages: R2 bodies + message rows ────────────────────────
      // R2 before the D1 rows — the message id IS the R2 key, so once the row
      // is gone the object can't be found. R2 delete throwing aborts this org
      // (caught below) and leaves it intact for retry rather than reporting an
      // erasure we didn't perform.
      let msgDone = 0;
      while (msgDone < MAX_PER_STORE_PER_RUN) {
        const batch = await getMessagePurgeBatch(env.DB, id, BATCH);
        const rows = batch.results ?? [];
        if (rows.length === 0) break;
        const r2Ids = rows.filter((r) => (r.content_encoding ?? "").startsWith("r2:")).map((r) => r.id);
        if (r2Ids.length > 0) await deleteContent(env, r2Ids);
        await deleteMessageRowsByIds(env.DB, rows.map((r) => r.id));
        msgDone += rows.length;
        if (rows.length < BATCH) break;
      }

      // ── Finalize only when empty ────────────────────────────────────────
      const remaining = await countOrgHeavyData(env.DB, id);
      if ((remaining?.messages ?? 0) === 0 && (remaining?.chunks ?? 0) === 0) {
        // Drops conversations, tags, api_keys, usage, audit_log, email_log,
        // oauth tokens (cascade), and the org row — all now-small.
        await deleteOrganizationById(env.DB, id);
        purged++;
        console.log(`[purge] Fully erased org ${id}`);
      } else {
        draining++;
        console.log(
          `[purge] org ${id} draining — ${remaining?.messages ?? "?"} messages, ${remaining?.chunks ?? "?"} chunks left; continues next run`,
        );
      }
    } catch (err) {
      // Per-org isolation: leave this org intact (deleted_at set) for the next
      // run; every other expired org still gets processed this run.
      console.error(
        `[purge] org ${id} FAILED — left intact for retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }
  }

  if (draining > 0) console.log(`[purge] ${draining} org(s) still draining after this run`);
  return purged;
}
