import type { Env } from "../types.js";

/**
 * Import-first onboarding, email leg (engram#253): orgs that signed up
 * 1–2 days ago and still have an essentially empty memory (only the
 * seeded welcome note) get one nudge to import their ChatGPT history —
 * the single action that fills their account with value.
 *
 * Fires on the 3rd day (72h–96h window = once per org). OpenAI's data
 * export can take "a few days" to arrive, so a 24h nudge would land
 * before the user even has their conversations.json — this waits until
 * the export realistically would have shown up.
 */
export async function sendImportNudges(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;

  const idle = await env.DB.prepare(
    `SELECT id, name, email FROM organizations
     WHERE deleted_at IS NULL
       AND email IS NOT NULL
       AND messages_stored_total <= 1
       AND created_at <= datetime('now', '-3 days')
       AND created_at > datetime('now', '-4 days')
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
