// Daily ops report (engram#226): computed here (the worker owns the data),
// emailed by engram-web (which owns SMTP). The scheduled handler POSTs the
// JSON to `${APP_URL}/api/reports/daily` authenticated with ADMIN_SECRET.
import type { Env } from "../types.js";
import { computeMrr, committedCents, committedSubscriptions } from "./mrr.js";

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
  /** Milliseconds for a simple indexed D1 point-read at report time. Normal is
   *  <500ms; sustained values in the seconds mean D1 is under pressure (see
   *  the Aug 2026 "D1 overloaded" incident) and is the early-warning signal. */
  d1_latency_ms?: number;
  /** Emails of team/enterprise orgs — engram-web flags support-inbox mail
   *  from these as PRIORITY (only paid team tiers get priority support). */
  priority_support_emails: string[];
  /** Live revenue from Stripe, same source as the admin dashboard.
   *  Replaces the old top_orgs_7d "biggest users by message count" list —
   *  message volume tracked neither revenue nor engagement (the heaviest
   *  storers were frequently the ones who had never run a search). */
  revenue: {
    /** External minus already-cancelling: what will still be here next month. */
    committed_cents: number;
    committed_subscriptions: number;
    at_risk_cents: number;
    at_risk_subscriptions: number;
    external_cents: number;
  };
}

export async function buildDailyReport(env: Env): Promise<DailyReport> {
  const db = env.DB;

  // D1 health probe: time one simple indexed point-read BEFORE the heavy
  // batch below, so the number reflects baseline latency, not contention
  // with our own report queries.
  const probeStart = Date.now();
  await db.prepare("SELECT id FROM organizations LIMIT 1").first();
  const d1LatencyMs = Date.now() - probeStart;

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
    teamEmails,
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
    // Total messages via the maintained per-conversation counter (3.1k rows),
    // NOT COUNT(*) over the 3.2M-row messages table — that full scan grows
    // every day and was timing the worker out (the report stopped sending
    // around Aug 4). This mirrors how /admin/metrics stays fast.
    db
      .prepare("SELECT COALESCE(SUM(message_count), 0) AS n FROM conversations")
      .first<{ n: number }>(),
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
        "SELECT email FROM organizations WHERE tier IN ('team','enterprise') AND email IS NOT NULL AND deleted_at IS NULL",
      )
      .all<{ email: string }>(),
  ]);

  // Fetched after the DB batch rather than inside it — it is an HTTP call to
  // Stripe, not a D1 query, and must not fail the whole report if Stripe is
  // down (computeMrr returns zeros on failure).
  const mrr = await computeMrr(env);

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
    d1_latency_ms: d1LatencyMs,
    priority_support_emails: (teamEmails.results ?? []).map((r) => r.email.toLowerCase()),
    // Revenue, from the same source the admin dashboard uses. Leads with
    // committed (external minus already-cancelling) because that is the
    // number that will still be here next month.
    revenue: {
      committed_cents: committedCents(mrr),
      committed_subscriptions: committedSubscriptions(mrr),
      at_risk_cents: mrr.at_risk_cents,
      at_risk_subscriptions: mrr.at_risk_subscriptions,
      external_cents: mrr.external_cents,
    },
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
