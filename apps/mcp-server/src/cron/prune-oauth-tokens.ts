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
 * The first version of this job never deleted a single row. It paged ids with
 * a SELECT and then issued `DELETE ... WHERE token_hash IN (?,?,… ×500)` —
 * but **D1 caps a statement at 100 bound parameters**, so every DELETE threw
 * `D1_ERROR: too many SQL variables`. The scheduled runner catches per-job
 * failures so the rest of the night still runs, which meant it failed
 * silently every night: by 2026-10-11 expired access tokens had GROWN to
 * 72,466 and tokens that expired on 2026-06-30 were still present. The unit
 * test passed throughout, because its stub D1 accepted any number of binds.
 *
 * The fix is to stop binding a list at all: the LIMIT lives inside the
 * statement, so one round trip deletes a whole batch with ZERO parameters and
 * the parameter cap cannot be reached no matter how large BATCH grows. It
 * also removes the select-then-delete race.
 *
 * Bounded and resumable: fixed bites per run, the backlog drains over a few
 * nights, steady state is a few hundred rows. Refresh tokens are pruned on
 * expiry only — a revoked-but-unexpired refresh token is kept because
 * `rotated_to` reuse detection still reads it.
 */
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 50; // 25k rows/night per table

export async function pruneExpiredOAuthTokens(env: Env): Promise<number> {
  let total = 0;
  for (const table of ["oauth_access_tokens", "oauth_refresh_tokens"] as const) {
    for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
      const r = await env.DB.prepare(
        `DELETE FROM ${table} WHERE token_hash IN (
           SELECT token_hash FROM ${table}
           WHERE expires_at < datetime('now')
           LIMIT ${BATCH}
         )`,
      ).run();
      const changes = r.meta?.changes ?? 0;
      total += changes;
      if (changes < BATCH) break;
    }
  }
  return total;
}
