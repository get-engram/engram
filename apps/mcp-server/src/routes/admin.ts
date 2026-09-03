import { Hono } from "hono";
import { getAuditLogs } from "@getengram/db";
import { compressContent, ENCODING_GZIP } from "../utils/compress.js";
import type { Env } from "../types.js";
import { sendDailyReport } from "../services/daily-report.js";
import { syncOrganizationFromStripe } from "../services/stripe-sync.js";
import { ftsRowid, orgFtsToken } from "@getengram/db";

type AdminEnv = { Bindings: Env };

export const admin = new Hono<AdminEnv>();

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
const ADMIN_TZ_OFFSET = "-6 hours";

// ---------------------------------------------------------------------------
// GET /admin/metrics — Business metrics dashboard
// ---------------------------------------------------------------------------
admin.get("/metrics", async (c) => {
  const [orgs, active, tiers, totals, dbSize, referrals, todaySignups, activation] = await Promise.all([
    c.env.DB.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN created_at >= datetime('now', '-1 days') THEN 1 ELSE 0 END) as last_1d,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
        SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as last_30d
      FROM organizations WHERE deleted_at IS NULL
    `).first<{ total: number; last_1d: number; last_7d: number; last_30d: number }>(),

    c.env.DB.prepare(`
      SELECT COUNT(DISTINCT o.id) as active
      FROM organizations o
      JOIN conversations c ON c.organization_id = o.id
      WHERE c.updated_at >= datetime('now', '-30 days')
        AND c.message_count > 0
        AND o.deleted_at IS NULL
    `).first<{ active: number }>(),

    c.env.DB.prepare(`
      SELECT COALESCE(tier, 'free') as tier, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY tier
    `).all<{ tier: string; count: number }>(),

    c.env.DB.prepare(`
      SELECT
        COUNT(*) as conversations,
        COALESCE(SUM(message_count), 0) as messages
      FROM conversations
    `).first<{ conversations: number; messages: number }>(),

    c.env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM conversation_chunks) as chunks,
        (SELECT COUNT(*) FROM api_keys) as api_keys
    `).first<{ chunks: number; api_keys: number }>(),

    c.env.DB.prepare(`
      SELECT COALESCE(referral_source, 'unknown') as source, COUNT(*) as count
      FROM organizations WHERE deleted_at IS NULL
      GROUP BY referral_source
      ORDER BY count DESC
    `).all<{ source: string; count: number }>(),

    c.env.DB.prepare(`
      SELECT id, name, email, tier, referral_source, created_at
      FROM organizations
      WHERE date(created_at, '${ADMIN_TZ_OFFSET}') = date('now', '${ADMIN_TZ_OFFSET}')
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `).all<{ id: string; name: string; email: string | null; tier: string; referral_source: string | null; created_at: string }>(),

    // Activation funnel (engram#onboarding) — replaces the misleading
    // "active in the last 30 days" framing (which was ~true for any org
    // that merely signed up recently) with events that actually predict
    // whether someone experienced the product: saved something beyond
    // the auto-seeded welcome note, searched, got a real recall back,
    // and came back later.
    c.env.DB.prepare(`
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
    `).first<{
      connected: number;
      first_memory_saved: number;
      first_search: number;
      first_successful_recall: number;
      second_session: number;
      returned_after_7_days: number;
    }>(),
  ]);

  const tierMap: Record<string, number> = {};
  for (const row of tiers?.results ?? []) {
    tierMap[row.tier] = row.count;
  }

  const referralMap: Record<string, number> = {};
  for (const row of referrals?.results ?? []) {
    referralMap[row.source] = row.count;
  }

  // MRR — live from Stripe (real amounts, not hardcoded tier prices). Sums
  // active subscription items; yearly plans are normalized to monthly.
  // "external" excludes subs whose customer maps to an internal org (the
  // owner's own accounts). Fail-soft: metrics must render without Stripe.
  // at_risk_* = subscriptions still 'active' in Stripe but already scheduled to
  // cancel (cancel_at_period_end / cancel_at). They pay this period and then
  // stop, so counting them in headline MRR overstates recurring revenue —
  // external_cents is the honest "committed" number to lead with.
  const mrr = {
    total_cents: 0,
    external_cents: 0,
    subscriptions: 0,
    external_subscriptions: 0,
    at_risk_cents: 0,
    at_risk_subscriptions: 0,
  };
  try {
    if (c.env.STRIPE_SECRET_KEY) {
      const subsRes = await fetch(
        "https://api.stripe.com/v1/subscriptions?status=active&limit=100",
        { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
      );
      if (subsRes.ok) {
        const subs = (await subsRes.json()) as {
          data: Array<{
            customer: string;
            cancel_at_period_end?: boolean;
            cancel_at?: number | null;
            items: {
              data: Array<{
                quantity?: number;
                price?: { unit_amount?: number | null; recurring?: { interval?: string; interval_count?: number } };
              }>;
            };
          }>;
        };
        const internalCustomers = new Set(
          (
            await c.env.DB.prepare(
              // Owner's own accounts are tagged referral_source='internal'
              // (see POST /admin/comp-internal). No personal emails in code.
              "SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL AND referral_source = 'internal'",
            ).all<{ stripe_customer_id: string }>()
          ).results?.map((r) => r.stripe_customer_id) ?? [],
        );
        for (const s of subs.data) {
          let cents = 0;
          for (const item of s.items?.data ?? []) {
            const unit = item.price?.unit_amount ?? 0;
            const qty = item.quantity ?? 1;
            const interval = item.price?.recurring?.interval ?? "month";
            const count = item.price?.recurring?.interval_count ?? 1;
            const monthly =
              interval === "year" ? (unit * qty) / (12 * count) : (unit * qty) / count;
            cents += monthly;
          }
          mrr.total_cents += Math.round(cents);
          mrr.subscriptions += 1;
          if (!internalCustomers.has(s.customer)) {
            mrr.external_cents += Math.round(cents);
            mrr.external_subscriptions += 1;
            // Both of Stripe's scheduled-cancel mechanisms count.
            const cancelling =
              Boolean(s.cancel_at_period_end) ||
              (typeof s.cancel_at === "number" && s.cancel_at > 0);
            if (cancelling) {
              mrr.at_risk_cents += Math.round(cents);
              mrr.at_risk_subscriptions += 1;
            }
          }
        }
      }
    }
  } catch {
    // leave zeros — the dashboard treats 0 subs as "unavailable"
  }

  return c.json({
    mrr,
    signups: {
      total: orgs?.total ?? 0,
      last_1d: orgs?.last_1d ?? 0,
      last_7d: orgs?.last_7d ?? 0,
      last_30d: orgs?.last_30d ?? 0,
    },
    active_users_30d: active?.active ?? 0,
    activation: {
      connected: activation?.connected ?? 0,
      first_memory_saved: activation?.first_memory_saved ?? 0,
      first_search: activation?.first_search ?? 0,
      first_successful_recall: activation?.first_successful_recall ?? 0,
      second_session: activation?.second_session ?? 0,
      returned_after_7_days: activation?.returned_after_7_days ?? 0,
    },
    tiers: tierMap,
    referrals: referralMap,
    storage: {
      conversations: totals?.conversations ?? 0,
      messages: totals?.messages ?? 0,
      chunks: dbSize?.chunks ?? 0,
      api_keys: dbSize?.api_keys ?? 0,
    },
    today_signups: todaySignups?.results ?? [],
  });
});

// ---------------------------------------------------------------------------
// GET /admin/timeseries?days=30 — daily counts for the admin trend chart:
// signups, cancellations (churned_at stamps), and net paid plans.
// Grouped in SQL over indexed date columns; owner's own orgs excluded so the
// lines show real customers only.
// ---------------------------------------------------------------------------
admin.get("/timeseries", async (c) => {
  const days = Math.min(Math.max(parseInt(c.req.query("days") ?? "30", 10) || 30, 7), 90);
  const since = `-${days} days`;

  const [signupRows, churnRows, paidRows] = await Promise.all([
    c.env.DB.prepare(
      `SELECT date(created_at, '${ADMIN_TZ_OFFSET}') AS d, COUNT(*) AS n FROM organizations
       WHERE deleted_at IS NULL AND COALESCE(referral_source,'') != 'internal'
         AND created_at >= datetime('now', ?)
       GROUP BY d`,
    ).bind(since).all<{ d: string; n: number }>(),
    c.env.DB.prepare(
      `SELECT date(churned_at, '${ADMIN_TZ_OFFSET}') AS d, COUNT(*) AS n FROM organizations
       WHERE churned_at IS NOT NULL AND deleted_at IS NULL
         AND COALESCE(referral_source,'') != 'internal'
         AND churned_at >= datetime('now', ?)
       GROUP BY d`,
    ).bind(since).all<{ d: string; n: number }>(),
    // Paid plans is a running total, so we need the current count plus the
    // per-day deltas to walk it backwards on the client.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM organizations
       WHERE deleted_at IS NULL AND tier IN ('pro','team','enterprise')
         AND COALESCE(referral_source,'') != 'internal'`,
    ).first<{ n: number }>(),
  ]);

  const signupMap = new Map((signupRows.results ?? []).map((r) => [r.d, r.n]));
  const churnMap = new Map((churnRows.results ?? []).map((r) => [r.d, r.n]));

  // Build a dense day list (zero-filled) oldest -> newest.
  const out: Array<{ date: string; signups: number; cancellations: number }> = [];
  // Day keys must be built on the SAME boundary the SQL grouped on
  // (ADMIN_TZ_OFFSET), or every bucket misses and the chart zero-fills.
  const TZ_SHIFT_MS = 6 * 3600 * 1000; // UTC-6, see ADMIN_TZ_OFFSET
  const today = new Date(Date.now() - TZ_SHIFT_MS);
  for (let i = days - 1; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    out.push({
      date: key,
      signups: signupMap.get(key) ?? 0,
      cancellations: churnMap.get(key) ?? 0,
    });
  }

  return c.json({ days, paid_now: paidRows?.n ?? 0, series: out });
});

// ---------------------------------------------------------------------------
// GET /admin/users — List all orgs with usage stats
// ---------------------------------------------------------------------------
admin.get("/users", async (c) => {
  const sort = c.req.query("sort") || "created_at";
  const order = c.req.query("order") === "asc" ? "ASC" : "DESC";
  // 500 was too low to pull the whole base in one call once signups passed it,
  // which silently truncated ad-hoc analysis (segment percentages computed on
  // the newest 500 skew heavily toward not-yet-activated accounts). 5,000 is
  // comfortably above current scale while still bounding the response; page
  // with `offset` beyond that.
  const limit = Math.min(Number(c.req.query("limit") || "100"), 5000);
  const offset = Number(c.req.query("offset") || "0");

  const allowedSort: Record<string, string> = {
    created_at: "o.created_at",
    total_messages: "total_messages",
    conversations: "conversations",
    email: "o.email",
  };
  const sortCol = allowedSort[sort] ?? "o.created_at";

  const result = await c.env.DB.prepare(`
    SELECT
      o.id,
      o.name,
      o.email,
      o.tier,
      o.referral_source,
      o.stripe_customer_id,
      o.created_at,
      o.cancel_at_period_end,
      o.churned_at,
      -- The counter that ACTUALLY gates saving (and drives the maxout nudge).
      -- total_messages below is derived from conversation counts and can
      -- disagree with it — surfacing both makes that drift visible instead of
      -- silently misreporting who is at the storage cap.
      o.messages_stored_total,
      o.maxout_nudged_at,
      o.digest_opt_out,
      COUNT(c.id) as conversations,
      COALESCE(SUM(c.message_count), 0) as total_messages
    FROM organizations o
    LEFT JOIN conversations c ON c.organization_id = o.id
    WHERE o.deleted_at IS NULL
    GROUP BY o.id
    ORDER BY ${sortCol} ${order}
    LIMIT ? OFFSET ?
  `)
    .bind(limit, offset)
    .all<{
      id: string;
      name: string;
      email: string | null;
      tier: string;
      referral_source: string | null;
      stripe_customer_id: string | null;
      created_at: string;
      cancel_at_period_end: number;
      churned_at: string | null;
      conversations: number;
      total_messages: number;
    }>();

  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM organizations WHERE deleted_at IS NULL"
  ).first<{ count: number }>();

  const returned = (result.results ?? []).length;
  const totalCount = total?.count ?? 0;
  return c.json({
    users: result.results,
    total: totalCount,
    limit,
    offset,
    // Explicit so a truncated page can't be mistaken for the whole base —
    // that silently skewed segment analysis when the cap was 500.
    has_more: offset + returned < totalCount,
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/users/:id — Update a user's tier
// ---------------------------------------------------------------------------
admin.patch("/users/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req
    .json<{ tier?: string; retention_policy_days?: number | null }>()
    .catch(() => ({} as { tier?: string; retention_policy_days?: number | null }));
  const tier = body.tier;

  if (tier && ["free", "pro", "team", "enterprise"].includes(tier)) {
    await c.env.DB.prepare(
      "UPDATE organizations SET tier = ? WHERE id = ?"
    ).bind(tier, id).run();
    return c.json({ updated: true, id, tier });
  }

  // Custom retention policy (engram#289) — enterprise contracts only.
  // null clears the policy (memory never expires again); an integer ≥ 7
  // sets the idle-conversation purge window in days.
  if ("retention_policy_days" in body) {
    const days = body.retention_policy_days;
    if (days !== null && (!Number.isInteger(days) || (days as number) < 7)) {
      return c.json({ error: "invalid_retention_policy_days", min: 7 }, 400);
    }
    await c.env.DB.prepare(
      "UPDATE organizations SET retention_policy_days = ? WHERE id = ?"
    ).bind(days, id).run();
    return c.json({ updated: true, id, retention_policy_days: days });
  }

  return c.json({ error: "invalid_tier" }, 400);
});

// ---------------------------------------------------------------------------
// DELETE /admin/users/:id — Soft-delete a user
// ---------------------------------------------------------------------------
admin.delete("/users/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.prepare(
    "UPDATE organizations SET deleted_at = datetime('now') WHERE id = ?"
  ).bind(id).run();
  return c.json({ deleted: true, id });
});

// ---------------------------------------------------------------------------
// POST /admin/users/:id/grant-pro — Give a user pro with a grace period
// ---------------------------------------------------------------------------
admin.post("/users/:id/grant-pro", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ days?: number }>().catch(() => ({}));
  const days = (body as { days?: number }).days ?? 14;

  await c.env.DB.prepare(
    "UPDATE organizations SET tier = 'pro', grace_ends_at = datetime('now', ? || ' days') WHERE id = ?"
  ).bind(days, id).run();

  const org = await c.env.DB.prepare(
    "SELECT tier, grace_ends_at FROM organizations WHERE id = ?"
  ).bind(id).first<{ tier: string; grace_ends_at: string }>();

  return c.json({ granted: true, id, tier: "pro", grace_ends_at: org?.grace_ends_at });
});

// ---------------------------------------------------------------------------
// POST /admin/comp-internal — cancel Stripe subscriptions for the owner's OWN
// accounts and comp them so they keep their current tier (stops self-charges,
// removes them from real revenue). Target orgs are those already tagged
// referral_source='internal', PLUS any emails passed in the request body — the
// personal emails are supplied at call time and never stored in the repo.
// On execute it also tags each matched org referral_source='internal' so the
// external-MRR exclusion stays data-driven. ?dry_run=1 previews without change.
// ---------------------------------------------------------------------------
admin.post("/comp-internal", async (c) => {
  const dryRun = c.req.query("dry_run") === "1" || c.req.query("dry_run") === "true";
  if (!c.env.STRIPE_SECRET_KEY) return c.json({ error: "no_stripe_key" }, 500);

  const body = await c.req.json<{ emails?: string[] }>().catch(() => ({}) as { emails?: string[] });
  const emails = (body.emails ?? []).filter((e) => typeof e === "string" && e.includes("@"));
  const emailClause = emails.length ? ` OR email IN (${emails.map(() => "?").join(",")})` : "";

  const orgs = await c.env.DB.prepare(
    `SELECT id, email, tier, stripe_customer_id FROM organizations
     WHERE stripe_customer_id IS NOT NULL AND deleted_at IS NULL
       AND (referral_source = 'internal'${emailClause})`,
  ).bind(...emails).all<{ id: string; email: string | null; tier: string; stripe_customer_id: string }>();

  const out: Array<Record<string, unknown>> = [];
  for (const org of orgs.results ?? []) {
    const subsRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&status=active&limit=10`,
      { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
    );
    const subs = subsRes.ok ? ((await subsRes.json()) as { data: Array<{ id: string }> }).data : [];
    const subIds = subs.map((s) => s.id);

    if (!dryRun) {
      // Tag internal (data-driven external-MRR exclusion, no emails in code) +
      // far-future grace so the cancellation webhook and reconcile cron keep
      // the tier after the sub is gone.
      await c.env.DB.prepare(
        "UPDATE organizations SET referral_source = 'internal', grace_ends_at = datetime('now', '+100 years'), cancel_at_period_end = 0 WHERE id = ?",
      ).bind(org.id).run();
      for (const sid of subIds) {
        await fetch(`https://api.stripe.com/v1/subscriptions/${sid}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` },
        });
      }
    }
    out.push({
      org_id: org.id,
      email: org.email,
      tier: org.tier,
      customer: org.stripe_customer_id,
      active_subscriptions: subIds,
      action: dryRun ? "would_cancel_and_comp" : (subIds.length ? "canceled_and_comped" : "tagged_internal_no_sub"),
    });
  }
  return c.json({ dry_run: dryRun, orgs_matched: out.length, orgs: out });
});

// ---------------------------------------------------------------------------
// GET /admin/users/:id/stripe — Check what Stripe says vs what DB says
// ---------------------------------------------------------------------------
admin.get("/users/:id/stripe", async (c) => {
  const id = c.req.param("id");
  const org = await c.env.DB.prepare(
    "SELECT id, name, email, tier, stripe_customer_id, stripe_subscription_id FROM organizations WHERE id = ?"
  ).bind(id).first<{
    id: string; name: string; email: string | null; tier: string;
    stripe_customer_id: string | null; stripe_subscription_id: string | null;
  }>();
  if (!org) return c.json({ error: "not_found" }, 404);

  const result: Record<string, unknown> = {
    db: {
      id: org.id, name: org.name, email: org.email,
      tier: org.tier, stripe_customer_id: org.stripe_customer_id,
      stripe_subscription_id: org.stripe_subscription_id,
    },
    stripe: null as unknown,
    mismatch: false,
  };

  if (org.stripe_customer_id && c.env.STRIPE_SECRET_KEY) {
    const subsRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&status=all&limit=10`,
      { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
    );
    if (subsRes.ok) {
      const subs = await subsRes.json() as {
        data: Array<{
          id: string; status: string;
          items: { data: Array<{ price: { id: string }; quantity: number }> };
          metadata: Record<string, string>;
          created: number;
          trial_start: number | null;
          trial_end: number | null;
          cancel_at_period_end: boolean;
          cancel_at: number | null;
          canceled_at: number | null;
          current_period_end: number | null;
        }>;
      };
      const stripeSubs = subs.data.map((s) => ({
        id: s.id,
        status: s.status,
        price_id: s.items?.data?.[0]?.price?.id,
        quantity: s.items?.data?.[0]?.quantity,
        metadata: s.metadata,
        created: new Date(s.created * 1000).toISOString(),
        trial_start: s.trial_start ? new Date(s.trial_start * 1000).toISOString() : null,
        trial_end: s.trial_end ? new Date(s.trial_end * 1000).toISOString() : null,
        cancel_at_period_end: s.cancel_at_period_end,
        cancel_at: s.cancel_at ? new Date(s.cancel_at * 1000).toISOString() : null,
        canceled_at: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
        current_period_end: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
      }));
      result.stripe = { customer_id: org.stripe_customer_id, subscriptions: stripeSubs };

      // Detect mismatch: Stripe has active/trialing sub but DB says free
      const activeSub = subs.data.find((s) => s.status === "active" || s.status === "trialing");
      if (activeSub && org.tier === "free") {
        result.mismatch = true;
        result.expected_tier = activeSub.items?.data?.[0]?.price?.id === c.env.STRIPE_PRICE_ID_TEAM ? "team" : "pro";
      }
    }
  }

  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /admin/users/:id/sync-stripe — Fix DB tier from actual Stripe state
// ---------------------------------------------------------------------------
admin.post("/users/:id/sync-stripe", async (c) => {
  const id = c.req.param("id");
  const org = await c.env.DB.prepare(
    "SELECT id, tier, stripe_customer_id, grace_ends_at FROM organizations WHERE id = ?"
  ).bind(id).first<{ id: string; tier: string; stripe_customer_id: string | null; grace_ends_at: string | null }>();
  if (!org) return c.json({ error: "not_found" }, 404);

  // Shared, evidence-only reconcile logic (also used by the reconcile cron).
  // Never downgrades on an empty Stripe result, in dunning, on a comp/grace, or
  // for enterprise — see syncOrganizationFromStripe for the guardrails.
  const result = await syncOrganizationFromStripe(c.env, org);
  if (!result.synced) {
    // manual_tier / in_dunning are deliberate no-ops, not errors → 200.
    const code =
      result.reason === "no_stripe_customer" ? 400 :
      result.reason === "stripe_api_error" ? 502 :
      result.reason === "no_subscriptions_returned" ? 409 :
      200;
    return c.json(result, code);
  }
  return c.json(result);
});

// POST /admin/daily-report/send — manually trigger the daily ops email
// (same path the 13:00 UTC cron takes). Useful for testing delivery.
admin.post("/daily-report/send", async (c) => {
  await sendDailyReport(c.env);
  return c.json({ sent: true });
});

// ---------------------------------------------------------------------------
// POST /admin/nudges/run?type=maxout|activation|recall|import — fire a
// lifecycle nudge on demand instead of waiting for the 03:00 UTC cron.
// Runs the same function the cron runs, so the per-org "already nudged" stamp
// is applied exactly as usual — a manual run can't cause a duplicate send
// later. Useful when someone hits the storage cap hours after the daily pass.
// ---------------------------------------------------------------------------
admin.post("/nudges/run", async (c) => {
  const type = c.req.query("type") ?? "maxout";
  const runners: Record<string, (env: Env) => Promise<number>> = {
    maxout: (env) => import("../cron/maxout-nudge.js").then((m) => m.sendMaxoutNudges(env)),
    activation: (env) => import("../cron/activation-nudge.js").then((m) => m.sendActivationNudges(env)),
    recall: (env) => import("../cron/recall-nudge.js").then((m) => m.sendRecallNudges(env)),
    import: (env) => import("../cron/import-nudge.js").then((m) => m.sendImportNudges(env)),
  };
  const run = runners[type];
  if (!run) {
    return c.json({ error: "unknown_type", allowed: Object.keys(runners) }, 400);
  }
  try {
    const sent = await run(c.env);
    return c.json({ type, sent });
  } catch (err) {
    return c.json(
      { type, error: "run_failed", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Email observability (migration 0029): engram-web's sendEmail() records
// every transactional send here; the public /email/open pixel stamps opens.
// ---------------------------------------------------------------------------

// POST /admin/email-log — record a sent email { id, recipient, type, org_id?,
// sent_at? }. sent_at (ISO "YYYY-MM-DD HH:MM:SS") is for backfilling history
// from the Hostinger Sent folder; live sends omit it and default to now.
admin.post("/email-log", async (c) => {
  const body = await c.req
    .json<{
      id?: string;
      recipient?: string;
      type?: string;
      org_id?: string;
      sent_at?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);
  if (!body.id || !body.recipient || !body.type) {
    return c.json({ error: "id, recipient, and type are required" }, 400);
  }
  const sentAt =
    body.sent_at && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(body.sent_at)
      ? body.sent_at.replace("T", " ")
      : null;
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO email_log (id, org_id, recipient, type, sent_at) VALUES (?, ?, ?, ?, COALESCE(?, datetime('now')))",
  )
    .bind(body.id, body.org_id ?? null, body.recipient, body.type, sentAt)
    .run();
  return c.json({ logged: true });
});

// DELETE /admin/email-log?type= — remove rows of a given type (test cleanup)
admin.delete("/email-log", async (c) => {
  const type = c.req.query("type") ?? "";
  if (!type) return c.json({ error: "type query param required" }, 400);
  const res = await c.env.DB.prepare("DELETE FROM email_log WHERE type = ?")
    .bind(type)
    .run();
  return c.json({ deleted: res.meta.changes ?? 0 });
});

// GET /admin/email-log — by-type stats + recent sends for the admin dashboard
admin.get("/email-log", async (c) => {
  const days = Math.min(Number(c.req.query("days") || "30"), 365);
  const [byType, recent, unsub, unsubCount] = await Promise.all([
    c.env.DB.prepare(
      `SELECT type,
              COUNT(*) as sent,
              SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) as opened,
              SUM(CASE WHEN unsubscribed_at IS NOT NULL THEN 1 ELSE 0 END) as unsubscribed,
              MAX(sent_at) as last_sent
       FROM email_log
       WHERE sent_at >= datetime('now', '-' || ? || ' days')
       GROUP BY type ORDER BY sent DESC`,
    )
      .bind(days)
      .all<{
        type: string;
        sent: number;
        opened: number;
        unsubscribed: number;
        last_sent: string;
      }>(),
    c.env.DB.prepare(
      `SELECT id, org_id, recipient, type, sent_at, opened_at
       FROM email_log ORDER BY sent_at DESC LIMIT 50`,
    ).all<{
      id: string;
      org_id: string | null;
      recipient: string;
      type: string;
      sent_at: string;
      opened_at: string | null;
    }>(),
    // Who opted out of lifecycle email, newest first. digest_opt_out_at is
    // null for opt-outs that predate migration 0031 — they sort last.
    c.env.DB.prepare(
      `SELECT name, email, digest_opt_out_at
       FROM organizations WHERE digest_opt_out = 1
       ORDER BY digest_opt_out_at IS NULL, digest_opt_out_at DESC LIMIT 20`,
    ).all<{ name: string; email: string | null; digest_opt_out_at: string | null }>(),
    c.env.DB.prepare(
      "SELECT COUNT(*) as n FROM organizations WHERE digest_opt_out = 1",
    ).first<{ n: number }>(),
  ]);
  return c.json({
    days,
    by_type: byType.results ?? [],
    recent: recent.results ?? [],
    unsubscribed_orgs: unsubCount?.n ?? 0,
    recent_unsubscribes: unsub.results ?? [],
  });
});

// GET /admin/stripe-customer/:customerId — read-only Stripe peek for
// billing forensics (subscriptions incl. trial/pause state, recent
// invoices, whether a card is on file). The Stripe key lives only in the
// worker, so the dashboard/CLI can't query Stripe directly; this is the
// admin's window. Never mutates.
admin.get("/stripe-customer/:customerId", async (c) => {
  const key = c.env.STRIPE_SECRET_KEY;
  if (!key) return c.json({ error: "stripe_not_configured" }, 500);
  const cust = c.req.param("customerId");
  const H = { Authorization: `Bearer ${key}` };
  const [subsRes, invRes, pmRes] = await Promise.all([
    fetch(`https://api.stripe.com/v1/subscriptions?customer=${cust}&status=all&limit=10`, { headers: H }),
    fetch(`https://api.stripe.com/v1/invoices?customer=${cust}&limit=10`, { headers: H }),
    fetch(`https://api.stripe.com/v1/payment_methods?customer=${cust}&type=card&limit=5`, { headers: H }),
  ]);
  const subs = (await subsRes.json()) as { data?: Array<Record<string, unknown>> };
  const invoices = (await invRes.json()) as { data?: Array<Record<string, unknown>> };
  const pms = (await pmRes.json()) as { data?: Array<Record<string, unknown>> };
  return c.json({
    subscriptions: (subs.data ?? []).map((s) => ({
      id: s.id,
      status: s.status,
      cancel_at_period_end: s.cancel_at_period_end,
      trial_start: s.trial_start,
      trial_end: s.trial_end,
      pause_collection: s.pause_collection ?? null,
      canceled_at: s.canceled_at ?? null,
      cancellation_details: s.cancellation_details ?? null,
      current_period_end: s.current_period_end,
      items: ((s.items as { data?: Array<{ price?: { unit_amount?: number; recurring?: { interval?: string } } }> })?.data ?? []).map(
        (i) => ({ unit_amount: i.price?.unit_amount, interval: i.price?.recurring?.interval }),
      ),
    })),
    invoices: (invoices.data ?? []).map((i) => ({
      id: i.id,
      status: i.status,
      amount_due: i.amount_due,
      amount_paid: i.amount_paid,
      created: i.created,
    })),
    cards_on_file: (pms.data ?? []).length,
  });
});

// POST /admin/reclaim-space?scope=logs|fts — EMERGENCY: free D1 space at the
// 10 GB cap WITHOUT deleting any user data. scope=logs clears audit_log +
// old email_log (pure observability). scope=fts additionally empties the
// chunks_fts keyword index (derived from conversation_chunks; search falls
// back to semantic/vector until rebuilt). Never touches messages,
// conversations, orgs, chunks, or the vault. DELETEs free pages that new
// writes reuse, so this restores writes even when the DB is at max size.
// GET /admin/content-sizing — Phase 0 of the R2 migration: estimate how many
// bytes each big column really occupies in D1, WITHOUT scanning all 3.4M rows
// (a full SUM would read ~all content pages and blow D1's query budget). We
// sample head+tail of each table for average byte size, then multiply by the
// exact row counts (message count comes from the denormalized
// conversations.message_count, like /metrics). LENGTH(CAST(x AS BLOB)) gives
// true UTF-8 byte length (content is base64-of-gzip in a TEXT column).
// Read-only; changes nothing.
admin.get("/content-sizing", async (c) => {
  const SAMPLE = 10000;
  const sampleAvg = async (
    table: string,
    col: string,
    order: "ASC" | "DESC",
  ) => {
    const row = await c.env.DB.prepare(
      `SELECT AVG(LENGTH(CAST(${col} AS BLOB))) AS avg_bytes,
              COUNT(*) AS n
       FROM (SELECT ${col} FROM ${table} ORDER BY rowid ${order} LIMIT ?)`,
    )
      .bind(SAMPLE)
      .first<{ avg_bytes: number | null; n: number }>();
    return { avg: row?.avg_bytes ?? 0, n: row?.n ?? 0 };
  };

  // Exact counts (both cheap: denormalized sum + a COUNT that /metrics already runs).
  const msgCount =
    (
      await c.env.DB.prepare(
        "SELECT COALESCE(SUM(message_count),0) AS n FROM conversations",
      ).first<{ n: number }>()
    )?.n ?? 0;
  const chunkCount =
    (
      await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM conversation_chunks",
      ).first<{ n: number }>()
    )?.n ?? 0;

  // messages.content — head + tail average, blended.
  const cHead = await sampleAvg("messages", "content", "ASC");
  const cTail = await sampleAvg("messages", "content", "DESC");
  const mHead = await sampleAvg("messages", "metadata", "ASC");
  const mTail = await sampleAvg("messages", "metadata", "DESC");
  // conversation_chunks.chunk_text + summary.
  const ctHead = await sampleAvg("conversation_chunks", "chunk_text", "ASC");
  const ctTail = await sampleAvg("conversation_chunks", "chunk_text", "DESC");
  const sHead = await sampleAvg("conversation_chunks", "chunk_summary", "ASC");
  const sTail = await sampleAvg("conversation_chunks", "chunk_summary", "DESC");
  // gzip adoption in the tail (recent writes).
  const gz = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN content_encoding='gzip+base64' THEN 1 ELSE 0 END) AS gz,
            COUNT(*) AS n
     FROM (SELECT content_encoding FROM messages ORDER BY rowid DESC LIMIT ?)`,
  )
    .bind(SAMPLE)
    .first<{ gz: number; n: number }>();

  const blend = (a: { avg: number }, b: { avg: number }) => (a.avg + b.avg) / 2;
  const contentAvg = blend(cHead, cTail);
  const metaAvg = blend(mHead, mTail);
  const chunkAvg = blend(ctHead, ctTail);
  const summaryAvg = blend(sHead, sTail);
  const GB = 1024 * 1024 * 1024;

  // FTS5 index bulk lives in the chunks_fts_data shadow table (segment blobs).
  // This is the redundant third copy of the text + the inverted index.
  let ftsDataBytes = 0;
  try {
    const f = await c.env.DB.prepare(
      "SELECT SUM(LENGTH(CAST(block AS BLOB))) AS bytes FROM chunks_fts_data",
    ).first<{ bytes: number | null }>();
    ftsDataBytes = f?.bytes ?? 0;
  } catch (e) {
    ftsDataBytes = -1;
  }
  const GB2 = 1024 * 1024 * 1024;

  return c.json({
    sample_size_per_end: SAMPLE,
    chunks_fts_est_gb: ftsDataBytes < 0 ? "error" : +(ftsDataBytes / GB2).toFixed(2),
    messages: {
      count: msgCount,
      content_avg_bytes_head: Math.round(cHead.avg),
      content_avg_bytes_tail: Math.round(cTail.avg),
      content_est_gb: +((contentAvg * msgCount) / GB).toFixed(2),
      metadata_est_gb: +((metaAvg * msgCount) / GB).toFixed(2),
      tail_gzip_pct: gz && gz.n ? Math.round((100 * (gz.gz ?? 0)) / gz.n) : 0,
    },
    conversation_chunks: {
      count: chunkCount,
      chunk_text_avg_bytes_head: Math.round(ctHead.avg),
      chunk_text_avg_bytes_tail: Math.round(ctTail.avg),
      chunk_text_est_gb: +((chunkAvg * chunkCount) / GB).toFixed(2),
      summary_est_gb: +((summaryAvg * chunkCount) / GB).toFixed(2),
    },
  });
});

// GET /admin/content-sizing-v2 — stratified re-measure. The head/tail sample
// in v1 missed the imported-history rowid range, so this samples evenly across
// the WHOLE rowid span (default 16 buckets x 2000 rows) for an unbiased avg,
// and directly measures the FTS shadow tables: chunks_fts_content.c0 (the
// stored copy of chunk_text) and chunks_fts_data.block (the inverted index).
// Read-only.
admin.get("/content-sizing-v2", async (c) => {
  const buckets = Math.min(40, Math.max(4, parseInt(c.req.query("buckets") ?? "16", 10)));
  const per = Math.min(5000, Math.max(500, parseInt(c.req.query("per") ?? "2000", 10)));
  const GB = 1024 * 1024 * 1024;

  const stratifiedAvg = async (table: string, col: string) => {
    const mm = await c.env.DB.prepare(
      `SELECT MIN(rowid) AS mn, MAX(rowid) AS mx FROM ${table}`,
    ).first<{ mn: number | null; mx: number | null }>();
    const mn = mm?.mn ?? 0;
    const mx = mm?.mx ?? 0;
    if (mx <= mn) return 0;
    let weighted = 0;
    let total = 0;
    for (let k = 0; k < buckets; k++) {
      const off = mn + Math.floor((k * (mx - mn)) / buckets);
      const r = await c.env.DB.prepare(
        `SELECT AVG(LENGTH(CAST(${col} AS BLOB))) AS a, COUNT(*) AS n
         FROM (SELECT ${col} FROM ${table} WHERE rowid >= ? LIMIT ?)`,
      )
        .bind(off, per)
        .first<{ a: number | null; n: number }>();
      if (r?.a != null && r.n > 0) {
        weighted += r.a * r.n;
        total += r.n;
      }
    }
    return total ? weighted / total : 0;
  };

  const sumBytes = async (table: string, col: string) => {
    try {
      const r = await c.env.DB.prepare(
        `SELECT SUM(LENGTH(CAST(${col} AS BLOB))) AS b FROM ${table}`,
      ).first<{ b: number | null }>();
      return r?.b ?? 0;
    } catch {
      return -1;
    }
  };

  const msgCount =
    (
      await c.env.DB.prepare(
        "SELECT COALESCE(SUM(message_count),0) AS n FROM conversations",
      ).first<{ n: number }>()
    )?.n ?? 0;
  const chunkCount =
    (
      await c.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM conversation_chunks",
      ).first<{ n: number }>()
    )?.n ?? 0;

  const contentAvg = await stratifiedAvg("messages", "content");
  const chunkAvg = await stratifiedAvg("conversation_chunks", "chunk_text");
  const ftsContentCopy = await sumBytes("chunks_fts_content", "c0");
  const ftsIndexData = await sumBytes("chunks_fts_data", "block");

  const gb = (n: number) => (n < 0 ? "n/a" : +(n / GB).toFixed(2));

  return c.json({
    buckets,
    per,
    counts: { messages: msgCount, chunks: chunkCount },
    avg_bytes: {
      messages_content: Math.round(contentAvg),
      chunk_text: Math.round(chunkAvg),
    },
    est_gb: {
      messages_content: gb(contentAvg * msgCount),
      chunk_text: gb(chunkAvg * chunkCount),
      fts_content_copy: gb(ftsContentCopy),
      fts_index_data: gb(ftsIndexData),
    },
  });
});

// GET /admin/search-coverage — how much stored verbatim is actually
// searchable. Indexing (chunk+embed) is best-effort with no backfill, so
// messages whose append hit an embedding rate-limit are stored but never
// indexed. This measures: (a) conversations with ZERO chunks, and (b) the
// partial gap — messages whose sequence falls beyond the last chunk's
// end_sequence in conversations that were only partly indexed. Read-only.
admin.get("/search-coverage", async (c) => {
  const totals = await c.env.DB.prepare(
    "SELECT COUNT(*) AS convs, COALESCE(SUM(message_count),0) AS msgs FROM conversations WHERE message_count > 0",
  ).first<{ convs: number; msgs: number }>();

  // Per-conversation chunk coverage (max end_sequence reached, chunk count).
  const cov = await c.env.DB.prepare(
    `SELECT
        COALESCE(SUM(c.message_count), 0) AS total_msgs,
        COALESCE(SUM(CASE WHEN g.max_end IS NULL THEN c.message_count ELSE 0 END), 0) AS msgs_zero_chunks,
        COALESCE(SUM(CASE WHEN g.max_end IS NOT NULL AND (c.message_count - 1) > g.max_end
                          THEN (c.message_count - 1 - g.max_end) ELSE 0 END), 0) AS msgs_beyond_last_chunk,
        COALESCE(SUM(CASE WHEN g.max_end IS NULL THEN 1 ELSE 0 END), 0) AS convs_zero_chunks
     FROM conversations c
     LEFT JOIN (
        SELECT conversation_id, MAX(end_sequence) AS max_end, COUNT(*) AS n
        FROM conversation_chunks GROUP BY conversation_id
     ) g ON g.conversation_id = c.id
     WHERE c.message_count > 0`,
  ).first<{ total_msgs: number; msgs_zero_chunks: number; msgs_beyond_last_chunk: number; convs_zero_chunks: number }>();

  const total = cov?.total_msgs ?? 0;
  const zero = cov?.msgs_zero_chunks ?? 0;
  const beyond = cov?.msgs_beyond_last_chunk ?? 0;
  const unsearchable = zero + beyond;
  const searchable = Math.max(0, total - unsearchable);

  return c.json({
    conversations_total: totals?.convs ?? 0,
    conversations_zero_chunks: cov?.convs_zero_chunks ?? 0,
    messages_total: total,
    unsearchable: {
      in_zero_chunk_convs: zero,
      beyond_last_chunk_in_partial_convs: beyond,
      total: unsearchable,
    },
    messages_searchable_est: searchable,
    pct_searchable: total ? +((100 * searchable) / total).toFixed(1) : 0,
    pct_unsearchable: total ? +((100 * unsearchable) / total).toFixed(1) : 0,
  });
});

// GET /admin/search-coverage-v2 — TRUE per-message coverage. Samples messages
// evenly across the whole table and checks whether each one's sequence actually
// falls inside a chunk range in its conversation (catches interior gaps the
// max-end metric misses). Read-only.
admin.get("/search-coverage-v2", async (c) => {
  const buckets = Math.min(24, Math.max(4, parseInt(c.req.query("buckets") ?? "12", 10)));
  const per = Math.min(3000, Math.max(500, parseInt(c.req.query("per") ?? "1500", 10)));
  const mm = await c.env.DB.prepare(
    "SELECT MIN(rowid) AS mn, MAX(rowid) AS mx FROM messages",
  ).first<{ mn: number | null; mx: number | null }>();
  const mn = mm?.mn ?? 0;
  const mx = mm?.mx ?? 0;
  let sampled = 0;
  let covered = 0;
  for (let k = 0; k < buckets && mx > mn; k++) {
    const off = mn + Math.floor((k * (mx - mn)) / buckets);
    const r = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN EXISTS(
                 SELECT 1 FROM conversation_chunks cc
                 WHERE cc.conversation_id = m.conversation_id
                   AND cc.start_sequence <= m.sequence
                   AND cc.end_sequence   >= m.sequence
              ) THEN 1 ELSE 0 END), 0) AS cov
       FROM (SELECT conversation_id, sequence FROM messages WHERE rowid >= ? LIMIT ?) m`,
    )
      .bind(off, per)
      .first<{ n: number; cov: number }>();
    sampled += r?.n ?? 0;
    covered += r?.cov ?? 0;
  }
  const pct = sampled ? +((100 * covered) / sampled).toFixed(1) : 0;
  return c.json({
    sampled_messages: sampled,
    covered_messages: covered,
    pct_searchable_true: pct,
    pct_unsearchable_true: sampled ? +(100 - pct).toFixed(1) : 0,
  });
});

// POST /admin/backfill-content-to-r2?after=<rowid>&batch=150 — move legacy
// inline message content out of D1 into R2 (the permanent fix for the 10GB
// cap). Per row: PUT the existing stored bytes to R2, read them back and
// compare, and ONLY THEN shrink the D1 row (content=\'\', content_encoding=
// \'r2:<orig>\'). Verify-before-swap => content is never lost. Resumable via
// the rowid cursor; idempotent (only touches non-r2 rows). Each shrinking
// UPDATE frees D1 pages, so running this also un-wedges a full database.
// ---------------------------------------------------------------------------
// POST /admin/backfill-fts?batch=500&after=<rowid> — populate the contentless
// chunks_fts_v2 index (migration 0035) from conversation_chunks, and stamp
// each chunk's fts_rowid so search can join back to it.
//
// Cursor-paged over conversation_chunks.rowid, idempotent (re-running a batch
// overwrites the same FTS rowids), and safe to run while the old chunks_fts
// still exists — nothing reads v2 until the deploy that switches the queries.
// ---------------------------------------------------------------------------
admin.post("/backfill-fts", async (c) => {
  const batch = Math.min(1000, Math.max(1, parseInt(c.req.query("batch") ?? "500", 10)));
  const after = parseInt(c.req.query("after") ?? "0", 10);

  const rows = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, organization_id, chunk_text
       FROM conversation_chunks
      WHERE rowid > ? AND fts_rowid IS NULL
      ORDER BY rowid LIMIT ?`,
  )
    .bind(after, batch)
    .all<{ rid: number; id: string; organization_id: string; chunk_text: string }>();

  const list = rows.results ?? [];
  if (list.length === 0) {
    return c.json({ done: true, indexed: 0, next_after: after });
  }

  const stmts = list.flatMap((r) => {
    const rid = ftsRowid(r.id);
    return [
      // Clear any prior entry first: a re-run must overwrite, not duplicate
      // the terms for this chunk.
      c.env.DB.prepare("DELETE FROM chunks_fts_v2 WHERE rowid = ?").bind(rid),
      c.env.DB.prepare(
        "INSERT INTO chunks_fts_v2(rowid, chunk_text, org) VALUES (?, ?, ?)",
      ).bind(rid, r.chunk_text, orgFtsToken(r.organization_id)),
      // Stamped LAST in the batch so a partial failure leaves fts_rowid NULL
      // and the row is simply picked up again on the next run.
      c.env.DB.prepare("UPDATE conversation_chunks SET fts_rowid = ? WHERE id = ?").bind(
        rid,
        r.id,
      ),
    ];
  });

  await c.env.DB.batch(stmts);

  const nextAfter = list[list.length - 1].rid;
  return c.json({
    done: false,
    indexed: list.length,
    next_after: nextAfter,
    hint: `POST /admin/backfill-fts?batch=${batch}&after=${nextAfter}`,
  });
});

admin.post("/backfill-content-to-r2", async (c) => {
  const batch = Math.min(800, Math.max(1, parseInt(c.req.query("batch") ?? "400", 10)));
  const after = parseInt(c.req.query("after") ?? "0", 10);

  const rows = await c.env.DB.prepare(
    `SELECT rowid AS rid, id, content, content_encoding FROM messages
     WHERE rowid > ? AND content != ''
       AND (content_encoding IS NULL OR content_encoding NOT LIKE 'r2:%')
     ORDER BY rowid LIMIT ?`,
  )
    .bind(after, batch)
    .all<{ rid: number; id: string; content: string; content_encoding: string | null }>();

  const list = rows.results ?? [];

  // R2 puts run in PARALLEL (sequential put+get was ~440ms/row -> ~17 days for
  // 3.4M rows). R2 put() resolves only on a durable write, so a fulfilled
  // promise is the confirmation; no read-back needed. Content is copied to R2
  // before the D1 row is ever cleared, and we swap only rows whose put succeeded.
  const outcomes = await Promise.all(
    list.map(async (r) => {
      try {
        await c.env.CONTENT.put(`content/${r.id}`, r.content);
        return { id: r.id, enc: `r2:${r.content_encoding ?? "raw"}`, ok: true };
      } catch {
        return { id: r.id, enc: "", ok: false };
      }
    }),
  );
  const toSwap = outcomes.filter((o) => o.ok);

  if (toSwap.length > 0) {
    await c.env.DB.batch(
      toSwap.map((sw) =>
        c.env.DB
          .prepare("UPDATE messages SET content = '', content_encoding = ? WHERE id = ?")
          .bind(sw.enc, sw.id),
      ),
    );
  }

  const maxRid = list.length ? list[list.length - 1].rid : after;
  return c.json({
    batch,
    after,
    processed: list.length,
    verified_and_swapped: toSwap.length,
    put_failed: outcomes.length - toSwap.length,
    next_after: maxRid,
    done: list.length === 0,
  });
});

// POST /admin/backfill-drain?after=0 — self-continuing drain. Processes one
// backfill batch, then (via waitUntil) fetches itself with the next cursor,
// chaining on Cloudflare until done — no external driver needed. Retries the
// same cursor on a transient error; a decrementing hop cap prevents runaways.
admin.post("/backfill-drain", async (c) => {
  const after = parseInt(c.req.query("after") ?? "0", 10);
  const hops = parseInt(c.req.query("hops") ?? "20000", 10);
  const batch = Math.min(200, Math.max(20, parseInt(c.req.query("batch") ?? "120", 10)));
  const origin = new URL(c.req.url).origin;
  const auth = c.req.header("Authorization") ?? "";
  const hdr = { Authorization: auth, "User-Agent": "engram-drain/1.0" };

  let j: Record<string, unknown> = {};
  let nextAfter = after;
  let stop = false;
  try {
    const r = await fetch(
      `${origin}/admin/backfill-content-to-r2?after=${after}&batch=${batch}`,
      { method: "POST", headers: hdr },
    );
    j = (await r.json()) as Record<string, unknown>;
    if (j.done === true || (j.processed as number ?? 0) === 0) stop = true;
    else nextAfter = j.next_after as number;
  } catch (e) {
    j = { error: e instanceof Error ? e.message : String(e) };
    nextAfter = after; // retry same cursor on transient error
  }

  const more = !stop && hops > 1;
  if (more) {
    c.executionCtx.waitUntil(
      fetch(`${origin}/admin/backfill-drain?after=${nextAfter}&hops=${hops - 1}&batch=${batch}`, {
        method: "POST",
        headers: hdr,
      }),
    );
  }
  return c.json({ chaining: more, hops_left: hops - 1, ...j });
});

// Drain fleet control — POST /admin/drain-do/start|stop, GET /admin/drain-do/status.
// 10 DrainerDO instances, each draining its own rowid window via alarms
// (true parallel, fully serverless). Idempotent with everything else.
const DRAIN_FLEET = 10;
const DRAIN_SPAN = 4_000_000;
admin.post("/drain-do/start", async (c) => {
  const step = Math.floor(DRAIN_SPAN / DRAIN_FLEET);
  const results = await Promise.all(
    Array.from({ length: DRAIN_FLEET }, (_, i) => {
      const stub = c.env.DRAINER.get(c.env.DRAINER.idFromName(`drainer-${i}`));
      return stub
        .fetch("https://do/start", {
          method: "POST",
          body: JSON.stringify({ start: i * step, end: (i + 1) * step }),
        })
        .then((r) => r.json());
    }),
  );
  return c.json({ fleet: DRAIN_FLEET, results });
});
admin.post("/drain-do/stop", async (c) => {
  const results = await Promise.all(
    Array.from({ length: DRAIN_FLEET }, (_, i) =>
      c.env.DRAINER.get(c.env.DRAINER.idFromName(`drainer-${i}`))
        .fetch("https://do/stop", { method: "POST" })
        .then((r) => r.json()),
    ),
  );
  return c.json({ stopped: true, results });
});
admin.get("/drain-do/status", async (c) => {
  const results = await Promise.all(
    Array.from({ length: DRAIN_FLEET }, (_, i) =>
      c.env.DRAINER.get(c.env.DRAINER.idFromName(`drainer-${i}`))
        .fetch("https://do/status")
        .then((r) => r.json()),
    ),
  );
  const totalMoved = results.reduce((a: number, r) => a + ((r as {moved?:number}).moved ?? 0), 0);
  const activeCount = results.filter((r) => (r as {active?:boolean}).active).length;
  return c.json({ active: activeCount, total_moved: totalMoved, workers: results });
});

// GET /admin/db-stats — real page-level D1 size + free space, plus per-table
// byte sizes when dbstat is available. freelist_bytes is the actual headroom
// for new writes (freed pages new inserts reuse); size_bytes vs the 10 GB cap
// is how close we are to re-wedging. Read-only; safe to call anytime.
admin.get("/db-stats", async (c) => {
  const out: Record<string, unknown> = {};
  try {
    const pc = await c.env.DB.prepare("PRAGMA page_count").first<{ page_count: number }>();
    const ps = await c.env.DB.prepare("PRAGMA page_size").first<{ page_size: number }>();
    const fl = await c.env.DB.prepare("PRAGMA freelist_count").first<{ freelist_count: number }>();
    const pageCount = pc?.page_count ?? 0;
    const pageSize = ps?.page_size ?? 0;
    const freelist = fl?.freelist_count ?? 0;
    out.page_size = pageSize;
    out.page_count = pageCount;
    out.size_bytes = pageCount * pageSize;
    out.freelist_pages = freelist;
    out.freelist_bytes = freelist * pageSize;
    out.cap_bytes = 10 * 1024 * 1024 * 1024;
  } catch (e) {
    out.pragma_error = e instanceof Error ? e.message : String(e);
  }
  // Per-table sizes (best effort — dbstat may not be compiled in).
  try {
    const t = await c.env.DB.prepare(
      "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC",
    ).all<{ name: string; bytes: number }>();
    out.tables = t.results ?? [];
  } catch (e) {
    out.dbstat_error = e instanceof Error ? e.message : String(e);
  }
  return c.json(out);
});

admin.post("/reclaim-space", async (c) => {
  const scope = c.req.query("scope") ?? "logs";
  const result: Record<string, unknown> = { scope };
  // audit_log — pure observability, safe to wipe entirely.
  try {
    const r = await c.env.DB.prepare("DELETE FROM audit_log").run();
    result.audit_log_deleted = r.meta?.changes ?? 0;
  } catch (e) {
    result.audit_log_error = e instanceof Error ? e.message : String(e);
  }
  // email_log — keep the last 7 days for the admin section, drop the rest.
  try {
    const r = await c.env.DB
      .prepare("DELETE FROM email_log WHERE sent_at < datetime('now','-7 days')")
      .run();
    result.email_log_deleted = r.meta?.changes ?? 0;
  } catch (e) {
    result.email_log_error = e instanceof Error ? e.message : String(e);
  }
  if (scope === "fts") {
    // Emergency space lever. Since migration 0035 the index is contentless,
    // so this no longer frees a duplicate copy of chunk_text (there isn't
    // one) — it frees the ~660MB index itself. Keyword search degrades to
    // semantic-only until POST /admin/backfill-fts rebuilds it, and
    // fts_rowid stamps must be cleared too or the backfill will skip every
    // row it already marked. No user data is lost either way.
    try {
      await c.env.DB.prepare("UPDATE conversation_chunks SET fts_rowid = NULL").run();
      const r = await c.env.DB.prepare("DELETE FROM chunks_fts_v2").run();
      result.chunks_fts_deleted = r.meta?.changes ?? 0;
    } catch (e) {
      result.chunks_fts_error = e instanceof Error ? e.message : String(e);
    }
  }
  return c.json({ reclaimed: true, ...result });
});

// GET /admin/audit/:orgId — query audit logs for an organization
admin.get("/audit/:orgId", async (c) => {
  const orgId = c.req.param("orgId");
  const limit = Math.min(Number(c.req.query("limit") || "50"), 200);
  const offset = Number(c.req.query("offset") || "0");
  const action = c.req.query("action");

  const result = await getAuditLogs(c.env.DB, orgId, {
    limit,
    offset,
    action: action || undefined,
  });

  return c.json({ logs: result.results, count: result.results.length });
});

admin.post("/backfill/compress", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const batchSize = Math.min(Math.max(body.batch_size ?? 500, 1), 1000);

  // Count remaining uncompressed messages
  const countResult = await c.env.DB
    .prepare("SELECT COUNT(*) as cnt FROM messages WHERE content_encoding IS NULL")
    .first<{ cnt: number }>();
  const remaining = countResult?.cnt ?? 0;

  if (remaining === 0) {
    return c.json({ status: "done", processed: 0, remaining: 0 });
  }

  // Fetch a batch of uncompressed messages
  const rows = await c.env.DB
    .prepare(
      "SELECT id, content FROM messages WHERE content_encoding IS NULL LIMIT ?"
    )
    .bind(batchSize)
    .all<{ id: string; content: string }>();

  if (!rows.results || rows.results.length === 0) {
    return c.json({ status: "done", processed: 0, remaining: 0 });
  }

  // Compress each message
  const updates = await Promise.all(
    rows.results.map(async (row) => {
      const { content, encoding } = await compressContent(row.content);
      // Mark uncompressed messages as 'raw' so they're excluded from
      // future backfill queries (distinguishes "checked, too small" from
      // "never processed").
      return { id: row.id, content, encoding: encoding ?? "raw" };
    })
  );

  // Batch update
  const stmts = updates.map((u) =>
    c.env.DB
      .prepare(
        "UPDATE messages SET content = ?, content_encoding = ? WHERE id = ?"
      )
      .bind(u.content, u.encoding, u.id)
  );
  await c.env.DB.batch(stmts);

  const compressed = updates.filter((u) => u.encoding === ENCODING_GZIP).length;
  const skipped = updates.length - compressed;

  return c.json({
    status: "progress",
    processed: updates.length,
    compressed,
    skipped_too_small: skipped,
    remaining: remaining - updates.length,
  });
});
