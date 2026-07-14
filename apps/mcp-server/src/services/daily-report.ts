// Daily ops report (engram#226): computed here (the worker owns the data),
// emailed by engram-web (which owns SMTP). The scheduled handler POSTs the
// JSON to `${APP_URL}/api/reports/daily` authenticated with ADMIN_SECRET.
import type { Env } from "../types.js";

export interface DailyReport {
  generated_at: string;
  totals: {
    organizations: number;
    by_tier: Record<string, number>;
    paying: number;
    messages: number;
    conversations: number;
  };
  last_24h: {
    signups: number;
    messages_stored: number;
    conversations_created: number;
    active_orgs: number;
    new_signups: Array<{
      email: string | null;
      name: string;
      tier: string;
      referral_source: string | null;
    }>;
  };
  referrals_all_time: Record<string, number>;
  top_orgs_7d: Array<{
    email: string | null;
    name: string;
    tier: string;
    messages_7d: number;
  }>;
}

export async function buildDailyReport(env: Env): Promise<DailyReport> {
  const db = env.DB;

  const [
    tiers,
    paying,
    msgTotal,
    convTotal,
    signups24,
    msgs24,
    convs24,
    activeOrgs24,
    newSignups,
    referrals,
    topOrgs,
  ] = await Promise.all([
    db
      .prepare(
        "SELECT tier, COUNT(*) AS n FROM organizations WHERE deleted_at IS NULL GROUP BY tier",
      )
      .all<{ tier: string; n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM organizations WHERE deleted_at IS NULL AND stripe_subscription_id IS NOT NULL",
      )
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM conversations").first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM organizations WHERE deleted_at IS NULL AND created_at >= datetime('now','-1 day')",
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE created_at >= datetime('now','-1 day')",
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM conversations WHERE created_at >= datetime('now','-1 day')",
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT organization_id) AS n FROM messages WHERE created_at >= datetime('now','-1 day')",
      )
      .first<{ n: number }>(),
    db
      .prepare(
        "SELECT email, name, tier, referral_source FROM organizations WHERE deleted_at IS NULL AND created_at >= datetime('now','-1 day') ORDER BY created_at DESC LIMIT 50",
      )
      .all<{ email: string | null; name: string; tier: string; referral_source: string | null }>(),
    db
      .prepare(
        "SELECT COALESCE(referral_source,'unknown') AS ref, COUNT(*) AS n FROM organizations WHERE deleted_at IS NULL GROUP BY ref ORDER BY n DESC",
      )
      .all<{ ref: string; n: number }>(),
    db
      .prepare(
        `SELECT o.email, o.name, o.tier, COUNT(m.id) AS messages_7d
         FROM messages m JOIN organizations o ON o.id = m.organization_id
         WHERE m.created_at >= datetime('now','-7 day') AND o.deleted_at IS NULL
         GROUP BY o.id ORDER BY messages_7d DESC LIMIT 5`,
      )
      .all<{ email: string | null; name: string; tier: string; messages_7d: number }>(),
  ]);

  const byTier: Record<string, number> = {};
  for (const r of tiers.results ?? []) byTier[r.tier] = r.n;

  const refs: Record<string, number> = {};
  for (const r of referrals.results ?? []) refs[r.ref] = r.n;

  return {
    generated_at: new Date().toISOString(),
    totals: {
      organizations: Object.values(byTier).reduce((a, b) => a + b, 0),
      by_tier: byTier,
      paying: paying?.n ?? 0,
      messages: msgTotal?.n ?? 0,
      conversations: convTotal?.n ?? 0,
    },
    last_24h: {
      signups: signups24?.n ?? 0,
      messages_stored: msgs24?.n ?? 0,
      conversations_created: convs24?.n ?? 0,
      active_orgs: activeOrgs24?.n ?? 0,
      new_signups: newSignups.results ?? [],
    },
    referrals_all_time: refs,
    top_orgs_7d: topOrgs.results ?? [],
  };
}

/** Build the report and hand it to engram-web for delivery. */
export async function sendDailyReport(env: Env): Promise<void> {
  const report = await buildDailyReport(env);
  const res = await fetch(`${env.APP_URL}/api/reports/daily`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${env.ADMIN_SECRET}`,
    },
    body: JSON.stringify(report),
  });
  if (!res.ok) {
    throw new Error(`daily report delivery failed: ${res.status} ${await res.text()}`);
  }
  console.log("[cron] daily report sent");
}
