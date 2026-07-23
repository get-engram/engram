import type { Env } from "../types.js";

// Ascending storage thresholds worth celebrating (engram#256). The
// highest announced one is stored per org, so each fires exactly once
// and a bulk import that blows through several announces only the
// largest.
const THRESHOLDS = [100, 1_000, 10_000, 100_000, 1_000_000] as const;

function milestoneMessage(threshold: number): string {
  return `Milestone: your Engram memory just passed ${threshold.toLocaleString("en-US")} messages — all of it permanent and searchable from every AI you've connected.`;
}

/**
 * Returns a one-time milestone notice when this append pushed lifetime
 * storage across a threshold, else undefined. Best-effort: any DB
 * hiccup just skips the notice (never the append).
 */
export async function checkMilestone(
  env: Env,
  organizationId: string,
  storedTotal: number | undefined,
): Promise<string | undefined> {
  if (typeof storedTotal !== "number" || storedTotal < THRESHOLDS[0]) return undefined;

  const crossed = [...THRESHOLDS].reverse().find((t) => storedTotal >= t);
  if (!crossed) return undefined;

  try {
    // Atomic claim: only one concurrent append wins the announcement.
    const updated = await env.DB.prepare(
      `UPDATE organizations SET milestone_announced = ?
       WHERE id = ? AND milestone_announced < ?`,
    )
      .bind(crossed, organizationId, crossed)
      .run();
    if (updated.meta?.changes === 0) return undefined;
    return milestoneMessage(crossed);
  } catch {
    return undefined;
  }
}
