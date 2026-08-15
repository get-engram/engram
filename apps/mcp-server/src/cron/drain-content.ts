import type { Env } from "../types.js";

/**
 * Background drain: move legacy inline message content from D1 into R2
 * (Step 2 of the content->R2 migration). Runs every minute via cron until
 * the table is fully drained, then becomes a cheap no-op.
 *
 * Each tick: loop small batches for up to ~45s. Per row: PUT the stored
 * bytes to R2 (put resolves only on a durable write), then — only for rows
 * whose put succeeded — shrink the D1 row to a pointer
 * (content='', content_encoding='r2:<original encoding>'). Content is never
 * deleted before its R2 copy is confirmed; a crash mid-batch just re-drains
 * the same rows next tick (same deterministic key -> idempotent overwrite).
 *
 * The cursor restarts from 0 each tick — already-drained rows are excluded
 * by the WHERE clause, so scanning forward always lands on the first
 * un-drained row. No cursor state to persist or corrupt.
 */
const BATCH = 100; // completes well inside limits (~20 R2 writes/s/invocation)
const TICK_BUDGET_MS = 45_000;

export async function drainContentToR2(env: Env): Promise<number> {
  const started = Date.now();
  let moved = 0;
  let after = 0;

  while (Date.now() - started < TICK_BUDGET_MS) {
    const rows = await env.DB.prepare(
      `SELECT rowid AS rid, id, content, content_encoding FROM messages
       WHERE rowid > ? AND content != ''
         AND (content_encoding IS NULL OR content_encoding NOT LIKE 'r2:%')
       ORDER BY rowid LIMIT ?`,
    )
      .bind(after, BATCH)
      .all<{ rid: number; id: string; content: string; content_encoding: string | null }>();

    const list = rows.results ?? [];
    if (list.length === 0) break; // fully drained — future ticks are no-ops

    const outcomes = await Promise.all(
      list.map(async (r) => {
        try {
          await env.CONTENT.put(`content/${r.id}`, r.content);
          return { id: r.id, enc: `r2:${r.content_encoding ?? "raw"}`, ok: true };
        } catch {
          return { id: r.id, enc: "", ok: false };
        }
      }),
    );
    const swap = outcomes.filter((o) => o.ok);
    if (swap.length > 0) {
      await env.DB.batch(
        swap.map((sw) =>
          env.DB
            .prepare("UPDATE messages SET content = '', content_encoding = ? WHERE id = ?")
            .bind(sw.enc, sw.id),
        ),
      );
      moved += swap.length;
    }
    // Advance past this batch even if some puts failed — failed rows stay
    // inline and are retried next tick when the scan restarts from 0.
    after = list[list.length - 1].rid;
  }

  return moved;
}
