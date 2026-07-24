import { TIER_LIMITS } from "@getengram/shared";
import type { Env } from "../types.js";

/**
 * Maxout upgrade nudge: free orgs that have filled their lifetime memory
 * (messages_stored_total ≥ the free tier's 10,000-message storage cap) get
 * one email letting them know they're full and offering Pro. The /pricing
 * link carries ?ref=maxout for attribution, and we stamp maxout_nudged_at so
 * the org is never emailed twice — and so we can later measure conversions.
 *
 * Runs on the daily cron alongside the import nudge. Respects the same
 * digest_opt_out unsubscribe flag as the other lifecycle emails.
 */
export async function sendMaxoutNudges(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!secret) return 0;

  const freeLimit = TIER_LIMITS.free.storage_messages;

  const maxed = await env.DB.prepare(
    `SELECT id, name, email FROM organizations
     WHERE deleted_at IS NULL
       AND email IS NOT NULL
       AND tier = 'free'
       AND messages_stored_total >= ?
       AND maxout_nudged_at IS NULL
       AND digest_opt_out = 0
     LIMIT 100`,
  )
    .bind(freeLimit)
    .all<{ id: string; name: string; email: string }>();

  const { unsubscribeSig } = await import("./weekly-digest.js");

  let sent = 0;
  for (const org of maxed.results ?? []) {
    try {
      const sig = await unsubscribeSig(org.id, secret);
      const res = await fetch(`${env.APP_URL}/api/email/maxout-nudge`, {
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
        // Stamp only after a successful send so a transient failure retries
        // on the next daily run instead of silently skipping the org.
        await env.DB.prepare(
          "UPDATE organizations SET maxout_nudged_at = datetime('now') WHERE id = ?",
        )
          .bind(org.id)
          .run();
        sent++;
      }
    } catch (err) {
      console.error(`[maxout-nudge] Failed for ${org.email}:`, err);
    }
  }
  return sent;
}
