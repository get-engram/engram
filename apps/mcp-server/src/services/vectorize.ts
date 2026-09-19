import type { Env } from "../types.js";

// Vectorize's deleteByIds accepts at most 100 ids per call; passing more throws
// `VECTOR_DELETE_ERROR (code = 40007): too many ids in payload; max id count is
// 100`. Every caller that deletes a variable number of vectors (a conversation
// delete, a re-chunk, the GDPR purge) can exceed that, so they must go through
// this chunker. This was the silent cause of the purge never erasing any org
// with >100 vectors — it threw, was caught per-org, and skipped every night.
const VECTORIZE_DELETE_LIMIT = 100;

/** Delete vectors by id, chunked to Vectorize's 100-ids-per-call limit. */
export async function deleteVectorsByIds(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += VECTORIZE_DELETE_LIMIT) {
    const batch = ids.slice(i, i + VECTORIZE_DELETE_LIMIT);
    if (batch.length > 0) await env.VECTORIZE.deleteByIds(batch);
  }
}
