import type { Env } from "../types.js";

/**
 * Student re-verification reminders (engram#471).
 *
 * A verification is good for 12 months. Without this the discount is
 * permanent in practice — which is the one failure mode a domain check
 * genuinely cannot defend against, since an alumni address keeps working
 * forever.
 *
 * This job only ever *asks*. It does not change anyone's price: silently
 * moving a paying customer from $3 to $9 because a cron fired is a support
 * incident, not a billing strategy. Expiry is recorded and surfaced; acting
 * on it is a deliberate, separate decision.
 */
export async function sendStudentReverifyReminders(env: Env): Promise<number> {
  if (!env.APP_URL) return 0;
  const secret = (env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET;
  if (!secret) return 0;

  // Fires once per org: the 14-days-out window is one day wide.
  const due = await env.DB.prepare(
    `SELECT id, email, student_email, student_expires_at
       FROM organizations
      WHERE deleted_at IS NULL
        AND tier = 'student'
        AND student_expires_at IS NOT NULL
        AND student_expires_at <= datetime('now', '+14 days')
        AND student_expires_at >  datetime('now', '+13 days')
      LIMIT 100`,
  ).all<{
    id: string;
    email: string | null;
    student_email: string | null;
    student_expires_at: string;
  }>();

  let sent = 0;
  for (const org of due.results ?? []) {
    const to = org.student_email ?? org.email;
    if (!to) continue;
    try {
      const res = await fetch(`${env.APP_URL}/api/email/student-reverify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ to, expires_at: org.student_expires_at }),
      });
      if (res.ok) sent++;
      else console.error(`[student-reverify] ${org.id}: HTTP ${res.status}`);
    } catch (err) {
      console.error(
        `[student-reverify] ${org.id}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return sent;
}
