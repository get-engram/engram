import type { Env } from "../types.js";

/**
 * Serverless parallel drain: move legacy inline message content from D1 into
 * R2 (Step 2 of the content->R2 migration), entirely on Cloudflare — no
 * external driver. Runs every minute via cron until drained, then no-ops.
 *
 * A single invocation is capped at ~20-30 R2 writes/sec (per-invocation
 * connection budget), so one tick fans out through the SELF service binding:
 * WINDOWS parallel sub-invocations of /admin/backfill-content-to-r2, each
 * draining its own rowid window with its own budget. The endpoint itself is
 * verify-before-swap (content is durably in R2 before the D1 row is cleared)
 * and idempotent, so overlapping ticks, retries, or an external driver
 * running at the same time are all safe.
 *
 * Error handling: a window whose sub-request fails just retries the same
 * cursor next round; a window that reports no rows (processed=0) or crosses
 * into the next window is finished for this tick. When the whole table is
 * drained every window reports no rows immediately and the tick is a no-op.
 */
const WINDOWS = 10;
const BATCH = 120;
const TICK_BUDGET_MS = 50_000;
const SPAN = 4_000_000; // > max messages rowid; empty windows finish instantly

interface BackfillResp {
  processed?: number;
  verified_and_swapped?: number;
  next_after?: number;
  done?: boolean;
  error?: string;
}

export async function drainContentToR2(env: Env): Promise<number> {
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!secret) return 0;

  const started = Date.now();
  const step = Math.floor(SPAN / WINDOWS);
  const cursors = Array.from({ length: WINDOWS }, (_, i) => i * step);
  const finished = new Array<boolean>(WINDOWS).fill(false);
  let moved = 0;

  while (Date.now() - started < TICK_BUDGET_MS && finished.some((f) => !f)) {
    const results = await Promise.all(
      cursors.map(async (cur, i): Promise<BackfillResp | null> => {
        if (finished[i]) return null;
        try {
          const res = await env.SELF.fetch(
            `https://self.internal/admin/backfill-content-to-r2?after=${cur}&batch=${BATCH}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${secret}`,
                "User-Agent": "engram-drain-cron/1.0",
              },
            },
          );
          return (await res.json()) as BackfillResp;
        } catch {
          return null; // transient — retry same cursor next round
        }
      }),
    );

    results.forEach((r, i) => {
      if (finished[i] || r === null) return;
      if (r.error !== undefined || typeof r.next_after !== "number") return; // retry
      moved += r.verified_and_swapped ?? 0;
      if (r.done || (r.processed ?? 0) === 0) {
        finished[i] = true; // nothing left past this cursor
        return;
      }
      if (r.next_after <= cursors[i] || r.next_after >= (i + 1) * step) {
        finished[i] = true; // window complete (next window owns the rest)
        return;
      }
      cursors[i] = r.next_after;
    });
  }

  return moved;
}
