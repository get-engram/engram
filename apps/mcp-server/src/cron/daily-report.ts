import type { Env } from "../types.js";

/**
 * Generates a daily ops report and POSTs it to the website API which
 * formats and emails it. Called by the Workers cron trigger (daily at 03:00 UTC).
 */
export async function sendDailyReport(env: Env): Promise<boolean> {
  const appUrl = env.APP_URL;
  const adminSecret = (env as Env & { ADMIN_SECRET: string }).ADMIN_SECRET;
  if (!appUrl || !adminSecret) {
    console.error("[daily-report] APP_URL or ADMIN_SECRET not configured");
    return false;
  }

  const [orgTotals, tiers, totals, last24h, newSignups, referrals, topOrgs] = await Promise.all([
    env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN stripe_subscription_id IS NOT NULL THEN 1 ELSE 0 END) as paying
      FROM organizations WHERE deleted_at IS NULL
    `).first<{ total: number; paying: number }>(),

    env.DB.prepare(`
      SELECT COALESCE(tier, 'free') as tier, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY tier
    `).all<{ tier: string; count: number }>(),

    env.DB.prepare(`
      SELECT
        COUNT(*) as conversations,
        COALESCE(SUM(message_count), 0) as messages
      FROM conversations
    `).first<{ conversations: number; messages: number }>(),

    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM organizations
         WHERE created_at >= datetime('now', '-1 days') AND deleted_at IS NULL) as signups,
        (SELECT COALESCE(SUM(message_count), 0) FROM conversations
         WHERE created_at >= datetime('now', '-1 days')) as messages_stored,
        (SELECT COUNT(*) FROM conversations
         WHERE created_at >= datetime('now', '-1 days')) as conversations_created,
        (SELECT COUNT(DISTINCT o.id) FROM organizations o
         JOIN conversations c ON c.organization_id = o.id
         WHERE c.updated_at >= datetime('now', '-1 days')
           AND c.message_count > 0
           AND o.deleted_at IS NULL) as active_orgs
    `).first<{
      signups: number;
      messages_stored: number;
      conversations_created: number;
      active_orgs: number;
    }>(),

    env.DB.prepare(`
      SELECT name, email, tier, referral_source
      FROM organizations
      WHERE created_at >= datetime('now', '-1 days') AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all<{
      name: string;
      email: string | null;
      tier: string;
      referral_source: string | null;
    }>(),

    env.DB.prepare(`
      SELECT COALESCE(referral_source, 'unknown') as source, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY referral_source
      ORDER BY count DESC
    `).all<{ source: string; count: number }>(),

    env.DB.prepare(`
      SELECT o.name, o.email, o.tier,
        COALESCE(SUM(c.message_count), 0) as messages_7d
      FROM organizations o
      JOIN conversations c ON c.organization_id = o.id
      WHERE c.updated_at >= datetime('now', '-7 days')
        AND o.deleted_at IS NULL
      GROUP BY o.id
      ORDER BY messages_7d DESC
      LIMIT 10
    `).all<{
      name: string;
      email: string | null;
      tier: string;
      messages_7d: number;
    }>(),
  ]);

  const byTier: Record<string, number> = {};
  for (const row of tiers?.results ?? []) {
    byTier[row.tier] = row.count;
  }

  const referralMap: Record<string, number> = {};
  for (const row of referrals?.results ?? []) {
    referralMap[row.source] = row.count;
  }

  const payload = {
    generated_at: new Date().toISOString(),
    totals: {
      organizations: orgTotals?.total ?? 0,
      by_tier: byTier,
      paying: orgTotals?.paying ?? 0,
      messages: totals?.messages ?? 0,
      conversations: totals?.conversations ?? 0,
    },
    last_24h: {
      signups: last24h?.signups ?? 0,
      messages_stored: last24h?.messages_stored ?? 0,
      conversations_created: last24h?.conversations_created ?? 0,
      active_orgs: last24h?.active_orgs ?? 0,
      new_signups: newSignups?.results ?? [],
    },
    referrals_all_time: referralMap,
    top_orgs_7d: topOrgs?.results ?? [],
  };

  const res = await fetch(`${appUrl}/api/reports/daily`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminSecret}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error(`[daily-report] Failed to send: ${res.status} ${await res.text().catch(() => "")}`);
    return false;
  }

  console.log("[daily-report] Sent successfully");
  return true;
}
