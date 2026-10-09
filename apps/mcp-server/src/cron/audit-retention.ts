import type { Env } from "../types.js";

/**
 * audit_log retention (engram#469 / #475 audit, finding R5).
 *
 * Every request writes an audit row — 15.4k/day as of 2026-10-09, 385k rows
 * since August, and the identity hardening (#476) added more. There was no
 * retention policy at all: the only path that ever removed rows was
 * /admin/reclaim-space, an unfiltered `DELETE FROM audit_log`. A stated
 * retention window is what a SOC 2 reviewer asks for; an emergency wipe is
 * the opposite of one.
 *
 * AUDIT_RETENTION_DAYS is a FLOOR. Rows younger than it are never removed by
 * any automated path. 90 days keeps every incident this product has had
 * reconstructible; raise it before any enterprise deal that asks for more
 * (a longer floor for auth events only is a reasonable later refinement).
 *
 * The per-run cap must exceed daily inflow or retention never catches up:
 * 15.4k/day inflow vs 30k/night cap. Nothing in the table is older than the
 * floor yet (oldest row 2026-08-15), so this deletes nothing until
 * mid-November and then holds the table at a steady ~90 days.
 */
export const AUDIT_RETENTION_DAYS = 90;
const BATCH = 500;
const MAX_BATCHES_PER_RUN = 60; // 30k rows/night, ~2× inflow

export async function enforceAuditRetention(env: Env): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES_PER_RUN; i++) {
    const page = await env.DB.prepare(
      `SELECT id FROM audit_log WHERE created_at < datetime('now', ?) LIMIT ?`,
    )
      .bind(`-${AUDIT_RETENTION_DAYS} days`, BATCH)
      .all<{ id: string }>();
    const ids = (page.results ?? []).map((r) => r.id);
    if (ids.length === 0) break;
    const ph = ids.map(() => "?").join(",");
    const r = await env.DB.prepare(`DELETE FROM audit_log WHERE id IN (${ph})`)
      .bind(...ids)
      .run();
    total += r.meta?.changes ?? ids.length;
    if (ids.length < BATCH) break;
  }
  return total;
}
