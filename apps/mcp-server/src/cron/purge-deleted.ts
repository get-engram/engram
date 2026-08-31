import {
  getExpiredOrganizations,
  getVectorizeIdsByOrganization,
  getR2MessageIdsByOrganization,
  deleteOrganizationById,
} from "@getengram/db";
import { deleteContent } from "../services/content-store.js";
import type { Env } from "../types.js";

/**
 * Permanently deletes organizations whose deleted_at is older than 30 days.
 * Called by the Workers cron trigger (daily).
 */
export async function purgeDeletedOrganizations(env: Env): Promise<number> {
  const expired = await getExpiredOrganizations(env.DB);
  let purged = 0;

  for (const { id } of expired.results) {
    // Delete vectors from Vectorize
    const vectorResult = await getVectorizeIdsByOrganization(env.DB, id);
    const vectorizeIds = vectorResult.results.map((r) => r.vectorize_id);

    if (vectorizeIds.length > 0) {
      for (let i = 0; i < vectorizeIds.length; i += 1000) {
        const batch = vectorizeIds.slice(i, i + 1000);
        await env.VECTORIZE.deleteByIds(batch);
      }
    }

    // Purge verbatim bodies from R2 BEFORE the D1 rows go — the message ids
    // are the R2 keys, so afterwards the objects cannot be found at all.
    // This is the path an erasure request runs through, so a failure must
    // abort this org rather than report a deletion we did not perform; the
    // org keeps its deleted_at and is retried on the next run.
    let r2Purged = 0;
    try {
      const r2Rows = await getR2MessageIdsByOrganization(env.DB, id);
      r2Purged = await deleteContent(env, r2Rows.results.map((r) => r.id));
    } catch (err) {
      console.error(
        `[purge] R2 purge FAILED for org ${id} — leaving org intact for retry: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      continue;
    }

    // Hard-delete from D1
    await deleteOrganizationById(env.DB, id);
    purged++;
    console.log(
      `[purge] Hard-deleted org ${id} (${vectorizeIds.length} vectors, ${r2Purged} R2 objects)`,
    );
  }

  return purged;
}
