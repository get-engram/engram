import type { Env } from "../types.js";

/**
 * Recall nudge: the save -> recall gap is the funnel's biggest measured leak.
 * As of 2026-08, 177 orgs had saved a real memory but only 50 had ever seen a
 * search return a hit — two-thirds did the work of saving and never got the
 * payoff that makes Engram click.
 *
 * Targets orgs that saved something real (messages_stored_total > 1) at least
 * a day ago but have NO successful recall (an audit_log 'search' row whose
 * metadata.results > 0 — the same definition the admin activation funnel
 * uses). One email, showing the 10-second way to see memory come back.
 *
 * Day 1 (not day 7 like the activation nudge) because this cohort is warm:
 * they already engaged, they just haven't closed the loop. Capped at 100/run,
 * stamped after a successful send, respects digest_opt_out, signed unsubscribe
 * link — same contract as every other lifecycle email.
 */
export async function sendRecallNudges(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!secret) return 0;

  const targets = await env.DB.prepare(
    `SELECT o.id, o.name, o.email FROM organizations o
     WHERE o.deleted_at IS NULL
       AND o.email IS NOT NULL
       AND o.messages_stored_total > 1
       AND o.recall_nudged_at IS NULL
       AND o.digest_opt_out = 0
       AND COALESCE(o.referral_source,'') != 'internal'
       AND o.created_at <= datetime('now', '-1 day')
       AND NOT EXISTS (
         SELECT 1 FROM audit_log a
         WHERE a.organization_id = o.id
           AND a.action = 'search'
           AND CAST(json_extract(a.metadata, '$.results') AS INTEGER) > 0
       )
     LIMIT 100`,
  ).all<{ id: string; name: string; email: string }>();

  const { unsubscribeSig } = await import("./weekly-digest.js");

  let sent = 0;
  for (const org of targets.results ?? []) {
    try {
      const sig = await unsubscribeSig(org.id, secret);
      const res = await fetch(`${env.APP_URL}/api/email/recall-nudge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          to: org.email,
          name: org.name,
          unsubscribe_url: `https://mcp.getengram.app/email/unsubscribe?org=${encodeURIComponent(org.id)}&sig=${sig}`,
        }),
      });
      if (res.ok) {
        await env.DB.prepare(
          "UPDATE organizations SET recall_nudged_at = datetime('now') WHERE id = ?",
        )
          .bind(org.id)
          .run();
        sent++;
      }
    } catch (err) {
      console.error(`[recall-nudge] Failed for ${org.email}:`, err);
    }
  }
  return sent;
}
