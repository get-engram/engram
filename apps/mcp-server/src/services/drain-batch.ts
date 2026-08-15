import type { Env } from "../types.js";

/**
 * One drain batch: move up to `batch` legacy inline message contents from D1
 * into R2, starting after rowid `after`. Verify-before-swap: R2 put resolves
 * only on a durable write; only rows whose put succeeded get their D1 row
 * shrunk to a pointer. Idempotent (deterministic key, WHERE excludes already-
 * drained rows) — safe under any concurrency. Shared by the admin backfill
 * endpoint and the DrainerDO alarm loop.
 */
export interface DrainBatchResult {
  processed: number;
  swapped: number;
  putFailed: number;
  nextAfter: number;
  done: boolean;
}

export async function drainBatch(
  env: Env,
  after: number,
  batch: number,
): Promise<DrainBatchResult> {
  const rows = await env.DB.prepare(
    `SELECT rowid AS rid, id, content, content_encoding FROM messages
     WHERE rowid > ? AND content != ''
       AND (content_encoding IS NULL OR content_encoding NOT LIKE 'r2:%')
     ORDER BY rowid LIMIT ?`,
  )
    .bind(after, batch)
    .all<{ rid: number; id: string; content: string; content_encoding: string | null }>();

  const list = rows.results ?? [];
  if (list.length === 0) {
    return { processed: 0, swapped: 0, putFailed: 0, nextAfter: after, done: true };
  }

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
  const toSwap = outcomes.filter((o) => o.ok);
  if (toSwap.length > 0) {
    await env.DB.batch(
      toSwap.map((sw) =>
        env.DB
          .prepare("UPDATE messages SET content = '', content_encoding = ? WHERE id = ?")
          .bind(sw.enc, sw.id),
      ),
    );
  }

  return {
    processed: list.length,
    swapped: toSwap.length,
    putFailed: outcomes.length - toSwap.length,
    nextAfter: list[list.length - 1].rid,
    done: false,
  };
}
