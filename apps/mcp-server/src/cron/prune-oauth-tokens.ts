import type { Env } from "../types.js";

/**
 * Nightly prune of expired OAuth tokens (engram#469, D1 findings 2026-10-09).
 *
 * Nothing ever deleted these. On the day this was written 68,781 of the
 * 68,877 access tokens in the table — 99.9% — were expired, plus ~69k refresh
 * tokens, all of them dead weight: an expired token cannot authenticate
 * (getAccessTokenWithOrg checks expires_at), so removing it changes nothing
 * for any client. On D1 a DELETE actually frees pages, so this is one of the
 * few cleanups that reclaims space rather than just hiding rows.
 *
 * Bounded and resumable, same shape as the org purge: fixed bites per run,
 * the backlog drains over a few nights, steady state is a few hundred rows.
 * Refresh tokens are pruned on expiry only — a revoked-but-unexpired refresh
 * token is kept because `rotated_to` reuse detection still reads it.
 */
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 50; // 25k rows/night per table — clears the backlog in ~3 nights

export async function pruneExpiredOAuthTokens(env: Env): Promise<number> {
  let total = 0;
  for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"] as const) {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const page = await env.DB.prepare(
        `SELECT token_hash FROM ${table} WHERE expires_at < datetime('now') LIMIT ?`,
      )
        .bind(BATCH)
        .all<{ token_hash: string }>();
      const hashes = (page.results ?? []).map((r) => r.token_hash);
      if (hashes.length === 0) break;
      const ph = hashes.map(() => "?").join(",");
      const r = await env.DB.prepare(`DELETE FROM ${table} WHERE token_hash IN (${ph})`)
        .bind(...hashes)
        .run();
      total += r.meta?.changes ?? hashes.length;
      if (hashes.length < BATCH) break;
    }
  }
  return total;
}
