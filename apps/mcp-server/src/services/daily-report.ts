// Daily ops report (engram#226): computed here (the worker owns the data),
// emailed by engram-web (which owns SMTP). The scheduled handler POSTs the
// JSON to `${APP_URL}/api/reports/daily` authenticated with INTERNAL_CRON_SECRET
// (ADMIN_SECRET until that is set; services/secrets.ts).
import type { Env } from "../types.js";
import { computeMrr, committedCents, committedSubscriptions } from "./mrr.js";
import { websiteBearer } from "./secrets.js";
import { PRIORITY_SUPPORT_TIERS, sqlTierList } from "@getengram/shared";

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
   *  storers were frequently the ones who had never run a search).
   *  Null when Stripe did not answer: zeros in its place were printed as
   *  "$0/mo committed from 0 customers" (engram#569). */
  revenue: {
    /** External minus already-cancelling: what will still be here next month. */
    committed_cents: number;
    committed_subscriptions: number;
    at_risk_cents: number;
    at_risk_subscriptions: number;
    external_cents: number;
  } | null;
  /** Why revenue is null, in a few words. Absent when Stripe answered. */
  revenue_unavailable?: string;
  /** Where totals.paying came from: Stripe, or the D1 fallback on a run
   *  Stripe did not answer, which counts rows rather than payments. */
  paying_source: "stripe" | "database";
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
        // Fallback only — used when Stripe is unreachable. Two corrections
        // against the original: exclude the owner's internal accounts (the
        // same data-driven rule computeMrr uses, tagged by
        // POST /admin/comp-internal), and note that a non-null
        // stripe_subscription_id outlives the subscription — comping an
        // account deletes the Stripe sub but leaves this column set, so the
        // old query counted a comped owner account as a paying customer.
        `SELECT COUNT(*) AS n FROM organizations
         WHERE deleted_at IS NULL
           AND stripe_subscription_id IS NOT NULL
           AND COALESCE(referral_source, '') != 'internal'`,
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
        `SELECT email FROM organizations WHERE tier IN (${sqlTierList(PRIORITY_SUPPORT_TIERS)}) AND email IS NOT NULL AND deleted_at IS NULL`,
      )
      .all<{ email: string }>(),
  ]);

  // Fetched after the DB batch rather than inside it — it is an HTTP call to
  // Stripe, not a D1 query, and must not fail the whole report if Stripe is
  // down (computeMrr never throws; it reports available: false).
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
      // One source of truth with the Revenue line below. The same email was
      // reporting "14 paying" beside "$96/mo from 12 customers", because
      // this number came from a D1 column and that one came from Stripe
      // with internal accounts excluded. Stripe is authoritative when it
      // answers, zero included; when it does not, this falls back to the
      // (now also corrected) D1 count and paying_source says so.
      paying: mrr.available ? mrr.external_subscriptions : (paying?.n ?? 0),
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
    paying_source: mrr.available ? "stripe" : "database",
    // Revenue, from the same source the admin dashboard uses. Leads with
    // committed (external minus already-cancelling) because that is the
    // number that will still be here next month.
    revenue: mrr.available
      ? {
          committed_cents: committedCents(mrr),
          committed_subscriptions: committedSubscriptions(mrr),
          at_risk_cents: mrr.at_risk_cents,
          at_risk_subscriptions: mrr.at_risk_subscriptions,
          external_cents: mrr.external_cents,
        }
      : null,
    ...(mrr.available ? {} : { revenue_unavailable: mrr.error ?? "Stripe did not answer" }),
  };
}

/**
 * Wait before each attempt to build and deliver the report: now, then twice
 * more over the next four minutes, well inside a cron run's 15-minute limit.
 * The report used to make one attempt and log a failure to the worker
 * console, which is not kept: three reports in a row went missing without a
 * trace (engram#569).
 */
export const REPORT_ATTEMPT_DELAYS_MS = [0, 60_000, 180_000];
/** Bounds a hung delivery. engram-web reads the inbox (15 s cap), then sends. */
const DELIVERY_TIMEOUT_MS = 30_000;
/** Each error carried into the failure notice is cut to this length. */
const MAX_ERROR_CHARS = 300;

export interface SendReportOptions {
  /** Wait before each attempt, in ms: one entry per attempt. */
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** Email a failure notice when every attempt fails. Default true. */
  notifyOnFailure?: boolean;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class DeliveryError extends Error {
  /** False for a refusal (401, 400): it is the same answer every time. */
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

/** POST to engram-web, which owns SMTP. Throws a DeliveryError. */
async function deliver(env: Env, body: unknown): Promise<void> {
  const bearer = websiteBearer(env);
  // Not retried: it is the same answer every time.
  if (!bearer) {
    throw new DeliveryError(
      "delivery failed: neither INTERNAL_CRON_SECRET nor ADMIN_SECRET is set",
      false,
    );
  }
  let res: Response;
  try {
    res = await fetch(`${env.APP_URL}/api/reports/daily`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeliveryError(`delivery failed: ${describe(err)}`, true);
  }
  if (res.ok) return;
  const text = (await res.text().catch(() => "")).slice(0, 200);
  throw new DeliveryError(
    `delivery failed: ${res.status} ${text}`,
    res.status === 429 || res.status >= 500,
  );
}

/**
 * Build the report and hand it to engram-web for delivery, retrying a failed
 * attempt over the next few minutes. When every attempt fails, delivers a
 * short failure notice instead, so a missing report arrives as an email that
 * names the error rather than as silence. Throws after that, for the
 * caller's log.
 *
 * A retried delivery can repeat an email that was sent but not acknowledged.
 * A duplicate report is the better failure.
 */
export async function sendDailyReport(env: Env, opts: SendReportOptions = {}): Promise<void> {
  const delays = opts.delays ?? REPORT_ATTEMPT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const errors: string[] = [];
  let attempts = 0;
  const failed = (what: string) => {
    errors.push(what.slice(0, MAX_ERROR_CHARS));
    console.error(`[daily-report] attempt ${attempts}/${delays.length} failed: ${what}`);
  };

  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    attempts += 1;
    let report: DailyReport;
    try {
      report = await buildDailyReport(env);
    } catch (err) {
      failed(`building the report: ${describe(err)}`);
      continue;
    }
    try {
      await deliver(env, report);
      console.log(`[daily-report] sent (attempt ${attempts})`);
      return;
    } catch (err) {
      failed(describe(err));
      if (err instanceof DeliveryError && !err.retryable) break;
    }
  }

  if (opts.notifyOnFailure ?? true) {
    try {
      await deliver(env, {
        generated_at: new Date().toISOString(),
        failure: { attempts, errors },
      });
      console.error(`[daily-report] FAILED after ${attempts} attempt(s); failure notice sent`);
    } catch (err) {
      console.error(`[daily-report] FAILED after ${attempts} attempt(s); the failure notice failed too: ${describe(err)}`);
    }
  }
  throw new Error(`daily report failed after ${attempts} attempt(s): ${errors[errors.length - 1] ?? "no attempts"}`);
}
