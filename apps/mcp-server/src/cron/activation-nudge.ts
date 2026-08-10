import type { Env } from "../types.js";

/**
 * Activation nudge: orgs that signed up a week ago but still have an
 * essentially empty memory (only the seeded welcome note) get one email
 * showing them the "aha" — say "remember this" in ChatGPT/Claude, or import
 * their history — so a paid-for signup doesn't stall forever. Activation is
 * the funnel's biggest leak, so this is the highest-leverage lifecycle mail.
 *
 * Fires from the 7-day mark onward (created_at <= now-7d) for any org that
 * hasn't been nudged yet — so the first run drains the dormant backlog
 * (capped at 100/run so the send stays gentle on domain reputation) and
 * later runs catch new orgs as they hit day 7. activation_nudged_at is
 * stamped after a successful send (never emailed twice; lets us measure
 * conversions). Respects the same digest_opt_out unsubscribe flag as every
 * other lifecycle email, and every send carries a signed unsubscribe link.
 *
 * Complements the day-3 import nudge (same dormant orgs, different angle a
 * week apart): import-nudge = "import your history"; this = "here's how to
 * actually use it across apps".
 */
export async function sendActivationNudges(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!secret) return 0;

  const dormant = await env.DB.prepare(
    `SELECT id, name, email FROM organizations
     WHERE deleted_at IS NULL
       AND email IS NOT NULL
       AND messages_stored_total <= 1
       AND activation_nudged_at IS NULL
       AND digest_opt_out = 0
       AND created_at <= datetime('now', '-7 days')
     LIMIT 100`,
  ).all<{ id: string; name: string; email: string }>();

  const { unsubscribeSig } = await import("./weekly-digest.js");

  let sent = 0;
  for (const org of dormant.results ?? []) {
    try {
      const sig = await unsubscribeSig(org.id, secret);
      const res = await fetch(`${env.APP_URL}/api/email/activation-nudge`, {
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
          "UPDATE organizations SET activation_nudged_at = datetime('now') WHERE id = ?",
        )
          .bind(org.id)
          .run();
        sent++;
      }
    } catch (err) {
      console.error(`[activation-nudge] Failed for ${org.email}:`, err);
    }
  }
  return sent;
}
