import type { Env } from "../types.js";

/**
 * Import-first onboarding, email leg (engram#253): orgs that signed up
 * 1–2 days ago and still have an essentially empty memory (only the
 * seeded welcome note) get one nudge to import their ChatGPT history —
 * the single action that fills their account with value. The 24h–48h
 * window means the daily cron fires it exactly once per org.
 */
export async function sendImportNudges(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;

  const idle = await env.DB.prepare(
    `SELECT id, name, email FROM organizations
     WHERE deleted_at IS NULL
       AND email IS NOT NULL
       AND messages_stored_total <= 1
       AND created_at <= datetime('now', '-1 day')
       AND created_at > datetime('now', '-2 days')
     LIMIT 100`,
  ).all<{ id: string; name: string; email: string }>();

  let sent = 0;
  for (const org of idle.results ?? []) {
    try {
      const res = await fetch(`${env.APP_URL}/api/email/import-nudge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${(env as Env & { ADMIN_SECRET: string }).ADMIN_SECRET}`,
        },
        body: JSON.stringify({ to: org.email, name: org.name }),
      });
      if (res.ok) sent++;
    } catch (err) {
      console.error(`[import-nudge] Failed for ${org.email}:`, err);
    }
  }
  return sent;
}
