import type { Env } from "../types.js";
import { lifecycleMail } from "../services/secrets.js";

/**
 * Weekly memory digest (engram#256), sent Mondays from the 13:00 cron.
 * Only orgs that were ACTIVE this week (stored at least one message) and
 * haven't opted out get one — a quiet week sends nothing, so the digest
 * can't become spam. engram-web renders and sends the branded email.
 */

interface WeeklyRow {
  id: string;
  name: string;
  email: string;
  saved: number;
}

export async function sendWeeklyDigests(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;
  const mail = lifecycleMail(env);
  if (!mail) return 0;

  // Orgs with activity in the last 7 days, an email, and no opt-out. The
  // week's messages are counted per org first, read through
  // idx_messages_created, and only then joined to organizations. Joined
  // directly, SQLite with statistics read each org's messages through
  // idx_messages_org, which is every message ever stored (engram#743).
  // message-window-plans.d1.test.ts checks the plan with and without
  // statistics.
  const active = await env.DB.prepare(
    `SELECT o.id, o.name, o.email, w.saved
     FROM (SELECT organization_id, COUNT(*) AS saved
           FROM messages INDEXED BY idx_messages_created
           WHERE created_at >= datetime('now', '-7 days')
           GROUP BY organization_id) w
     JOIN organizations o ON o.id = w.organization_id
     WHERE o.deleted_at IS NULL
       AND o.email IS NOT NULL
       AND o.digest_opt_out = 0
     LIMIT 500`,
  ).all<WeeklyRow>();

  let sent = 0;
  for (const org of active.results ?? []) {
    try {
      const [searches, titles] = await Promise.all([
        env.DB.prepare(
          `SELECT COUNT(*) AS n FROM audit_log
           WHERE organization_id = ? AND action = 'search'
             AND created_at >= datetime('now', '-7 days')`,
        )
          .bind(org.id)
          .first<{ n: number }>(),
        env.DB.prepare(
          `SELECT title FROM conversations
           WHERE organization_id = ? AND updated_at >= datetime('now', '-7 days')
             AND title IS NOT NULL AND title != ''
           ORDER BY updated_at DESC LIMIT 3`,
        )
          .bind(org.id)
          .all<{ title: string }>(),
      ]);

      const unsubscribeUrl = await mail.unsubscribeUrl(org.id);
      const res = await fetch(`${env.APP_URL}/api/email/weekly-digest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${mail.bearer}`,
        },
        body: JSON.stringify({
          to: org.email,
          name: org.name,
          saved: org.saved,
          searches: searches?.n ?? 0,
          highlights: (titles.results ?? []).map((t) => t.title),
          unsubscribe_url: unsubscribeUrl,
        }),
      });
      if (res.ok) sent++;
    } catch (err) {
      console.error(`[digest] Failed for org ${org.id}:`, err);
    }
  }
  return sent;
}
