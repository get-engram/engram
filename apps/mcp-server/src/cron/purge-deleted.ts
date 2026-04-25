import {
  getExpiredOrganizations,
  getVectorizeIdsByOrganization,
  deleteOrganizationById,
} from "@getengram/db";
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

    // Hard-delete from D1
    await deleteOrganizationById(env.DB, id);
    purged++;
    console.log(`[purge] Hard-deleted org ${id} (${vectorizeIds.length} vectors)`);
  }

  return purged;
}
