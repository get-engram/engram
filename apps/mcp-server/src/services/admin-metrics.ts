import { createTtlMemo } from "../utils/ttl-memo.js";

/**
 * The queries behind GET /admin/metrics, split by cost (engram#551).
 *
 * Measured on production D1 (2026-11-05): the activation funnel is ~1.7 s
 * and ~5.5M rows read per run, the chunk count reads another ~1M rows, and
 * the other seven statements together take ~50 ms and ~50k rows. The admin
 * page polls the endpoint every 30 s. Firing all of that as eight parallel
 * statements is what pushed D1 into "requests queued for too long", which
 * the worker reports as 503 and which blanked the admin page
 * (engram-web#274).
 *
 * So: the cheap group goes to D1 as ONE batch (one request, one queue
 * slot), and the expensive group is cached per isolate for ten minutes and
 * served stale when D1 refuses the recompute. The funnel counts are
 * lifetime cohorts that move by single digits a day; the chunk count is a
 * capacity figure. Neither needs to be live.
 */

/**
 * The admin dashboard reports days in the operator's timezone, not UTC.
 *
 * Timestamps are stored in UTC; SQLite's bare `date('now')` is also UTC, so
 * "today" used to roll over at 18:00 local. Between 6pm and midnight the
 * board showed "0 signups today" while people were signing up during the
 * operator's actual day.
 *
 * Mexico abolished DST in October 2022, so America/Mexico_City is a fixed
 * UTC-6 year-round and a constant offset is exact — no tz database needed
 * (D1/SQLite has no timezone support beyond fixed modifiers anyway). If the
 * operator ever moves to a zone that observes DST, this must become a real
 * timezone conversion rather than a fixed offset.
 */
export const ADMIN_TZ_OFFSET = "-6 hours";

/** How long the funnel and chunk count are served before being recomputed. */
export const SLOW_METRICS_TTL_MS = 10 * 60_000;
/** After a failed recompute, how long the stale figures are served before trying D1 again. */
export const SLOW_METRICS_ERROR_BACKOFF_MS = 60_000;

export interface AdminActivation {
  connected: number;
  first_memory_saved: number;
  first_search: number;
  first_successful_recall: number;
  second_session: number;
  returned_after_7_days: number;
}

export interface TodaySignup {
  id: string;
  name: string;
  email: string | null;
  tier: string;
  referral_source: string | null;
  created_at: string;
}

export interface FastMetrics {
  signups: { total: number; last_1d: number; last_7d: number; last_30d: number };
  active_users_30d: number;
  tiers: Record<string, number>;
  referrals: Record<string, number>;
  conversations: number;
  messages: number;
  api_keys: number;
  today_signups: TodaySignup[];
}

export interface SlowMetrics {
  activation: AdminActivation;
  chunks: number;
  /** When these figures were computed (ISO 8601). */
  computed_at: string;
}

function rows<T>(result: D1Result<unknown> | undefined): T[] {
  return (result?.results ?? []) as T[];
}

function row<T>(result: D1Result<unknown> | undefined): T | undefined {
  return rows<T>(result)[0];
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The cheap figures, as one D1 batch. Always live. */
export async function loadFastMetrics(db: D1Database): Promise<FastMetrics> {
  const [orgs, active, tiers, totals, keys, referrals, today] = await db.batch([
    db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN created_at >= datetime('now', '-1 days') THEN 1 ELSE 0 END) as last_1d,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
        SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as last_30d
      FROM organizations WHERE deleted_at IS NULL
    `),

    db.prepare(`
      SELECT COUNT(DISTINCT o.id) as active
      FROM organizations o
      JOIN conversations c ON c.organization_id = o.id
      WHERE c.updated_at >= datetime('now', '-30 days')
        AND c.message_count > 0
        AND o.deleted_at IS NULL
    `),

    db.prepare(`
      SELECT COALESCE(tier, 'free') as tier, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY tier
    `),

    db.prepare(`
      SELECT
        COUNT(*) as conversations,
        COALESCE(SUM(message_count), 0) as messages
      FROM conversations
    `),

    db.prepare(`SELECT COUNT(*) as api_keys FROM api_keys`),

    db.prepare(`
      SELECT COALESCE(referral_source, 'unknown') as source, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY referral_source
      ORDER BY count DESC
    `),

    db.prepare(`
      SELECT id, name, email, tier, referral_source, created_at
      FROM organizations
      WHERE date(created_at, '${ADMIN_TZ_OFFSET}') = date('now', '${ADMIN_TZ_OFFSET}')
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `),
  ]);

  const o = row<{ total: number; last_1d: number; last_7d: number; last_30d: number }>(orgs);

  const tierMap: Record<string, number> = {};
  for (const r of rows<{ tier: string; count: number }>(tiers)) tierMap[r.tier] = r.count;

  const referralMap: Record<string, number> = {};
  for (const r of rows<{ source: string; count: number }>(referrals)) referralMap[r.source] = r.count;

  const t = row<{ conversations: number; messages: number }>(totals);

  return {
    signups: {
      total: o?.total ?? 0,
      last_1d: o?.last_1d ?? 0,
      last_7d: o?.last_7d ?? 0,
      last_30d: o?.last_30d ?? 0,
    },
    active_users_30d: row<{ active: number }>(active)?.active ?? 0,
    tiers: tierMap,
    referrals: referralMap,
    conversations: t?.conversations ?? 0,
    messages: t?.messages ?? 0,
    api_keys: row<{ api_keys: number }>(keys)?.api_keys ?? 0,
    today_signups: rows<TodaySignup>(today),
  };
}

const slowMemo = createTtlMemo<SlowMetrics>({
  ttlMs: SLOW_METRICS_TTL_MS,
  errorBackoffMs: SLOW_METRICS_ERROR_BACKOFF_MS,
  onStale: (err, ageMs) =>
    console.warn(
      `[admin] metrics: funnel recompute failed, serving figures from ${Math.round(ageMs / 1000)}s ago — ${errorMessage(err)}`,
    ),
});

/**
 * The expensive figures, from the per-isolate cache. Computed at most once
 * per SLOW_METRICS_TTL_MS; the last good figures are served while D1 is
 * refusing the recompute. A cold isolate with a failing D1 throws, exactly
 * as the uncached code did.
 */
export function loadSlowMetrics(db: D1Database): Promise<SlowMetrics> {
  return slowMemo.get(async () => {
    const [funnel, chunks] = await db.batch([
      // Activation funnel (engram#onboarding) — replaces the misleading
      // "active in the last 30 days" framing (which was ~true for any org
      // that merely signed up recently) with events that actually predict
      // whether someone experienced the product: saved something beyond
      // the auto-seeded welcome note, searched, got a real recall back,
      // and came back later.
      db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM organizations
             WHERE deleted_at IS NULL AND COALESCE(referral_source,'') != 'internal') AS connected,
          (SELECT COUNT(*) FROM organizations
             WHERE deleted_at IS NULL AND COALESCE(referral_source,'') != 'internal'
               AND messages_stored_total > 1) AS first_memory_saved,
          (SELECT COUNT(DISTINCT a.organization_id) FROM audit_log a
             JOIN organizations o ON o.id = a.organization_id
             WHERE a.action = 'search' AND o.deleted_at IS NULL
               AND COALESCE(o.referral_source,'') != 'internal') AS first_search,
          (SELECT COUNT(DISTINCT a.organization_id) FROM audit_log a
             JOIN organizations o ON o.id = a.organization_id
             WHERE a.action = 'search'
               AND CAST(json_extract(a.metadata, '$.results') AS INTEGER) > 0
               AND o.deleted_at IS NULL
               AND COALESCE(o.referral_source,'') != 'internal') AS first_successful_recall,
          (SELECT COUNT(*) FROM (
             SELECT a.organization_id FROM audit_log a
               JOIN organizations o ON o.id = a.organization_id
               WHERE o.deleted_at IS NULL AND COALESCE(o.referral_source,'') != 'internal'
               GROUP BY a.organization_id
               HAVING COUNT(DISTINCT date(a.created_at)) >= 2
           )) AS second_session,
          (SELECT COUNT(DISTINCT a.organization_id) FROM audit_log a
             JOIN organizations o ON o.id = a.organization_id
             WHERE o.deleted_at IS NULL AND COALESCE(o.referral_source,'') != 'internal'
               AND a.created_at >= datetime(o.created_at, '+7 days')) AS returned_after_7_days
      `),
      db.prepare(`SELECT COUNT(*) as chunks FROM conversation_chunks`),
    ]);

    const f = row<AdminActivation>(funnel);
    return {
      activation: {
        connected: f?.connected ?? 0,
        first_memory_saved: f?.first_memory_saved ?? 0,
        first_search: f?.first_search ?? 0,
        first_successful_recall: f?.first_successful_recall ?? 0,
        second_session: f?.second_session ?? 0,
        returned_after_7_days: f?.returned_after_7_days ?? 0,
      },
      chunks: row<{ chunks: number }>(chunks)?.chunks ?? 0,
      computed_at: new Date().toISOString(),
    };
  });
}

/** Tests share one isolate; let each start cold. */
export function resetAdminMetricsCacheForTests(): void {
  slowMemo.reset();
}
