import { Hono } from "hono";
import { getAuditLogs } from "@getengram/db";
import { compressContent, ENCODING_GZIP } from "../utils/compress.js";
import type { Env } from "../types.js";
import { sendDailyReport } from "../services/daily-report.js";

type AdminEnv = { Bindings: Env };

export const admin = new Hono<AdminEnv>();

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
      WHERE date(created_at) = date('now') AND deleted_at IS NULL
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
  const mrr = { total_cents: 0, external_cents: 0, subscriptions: 0, external_subscriptions: 0 };
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
              "SELECT stripe_customer_id FROM organizations WHERE stripe_customer_id IS NOT NULL AND (referral_source = 'internal' OR email IN ('maryjanis@yahoo.com', 'debragailinc@gmail.com', 'deb@27c1ub.com'))",
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
// GET /admin/users — List all orgs with usage stats
// ---------------------------------------------------------------------------
admin.get("/users", async (c) => {
  const sort = c.req.query("sort") || "created_at";
  const order = c.req.query("order") === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Number(c.req.query("limit") || "100"), 500);
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

  return c.json({
    users: result.results,
    total: total?.count ?? 0,
    limit,
    offset,
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
    "SELECT id, tier, stripe_customer_id FROM organizations WHERE id = ?"
  ).bind(id).first<{ id: string; tier: string; stripe_customer_id: string | null }>();
  if (!org) return c.json({ error: "not_found" }, 404);
  if (!org.stripe_customer_id) return c.json({ error: "no_stripe_customer" }, 400);

  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&status=all&limit=10`,
    { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
  );
  if (!subsRes.ok) return c.json({ error: "stripe_api_error" }, 502);

  const subs = await subsRes.json() as {
    data: Array<{
      id: string; status: string;
      items: { data: Array<{ price: { id: string }; quantity: number }> };
      cancel_at_period_end: boolean;
      cancel_at: number | null;
      canceled_at: number | null;
    }>;
  };

  const activeSub = subs.data.find((s) => s.status === "active" || s.status === "trialing");
  if (!activeSub) {
    // No live subscription. A canceled sub in the history (status=all) or a
    // currently-paid tier means this org churned — stamp churned_at (with
    // Stripe's canceled_at when available, keeping any earlier stamp) so the
    // admin shows "cancelled" instead of plain free. Backfills cancellations
    // the webhook never saw, including orgs already downgraded to free.
    const canceled = subs.data
      .filter((s) => s.canceled_at)
      .sort((a, b) => (b.canceled_at ?? 0) - (a.canceled_at ?? 0))[0];
    const churnedAt = canceled?.canceled_at
      ? new Date(canceled.canceled_at * 1000).toISOString().slice(0, 19).replace("T", " ")
      : null;
    const isChurn = Boolean(churnedAt) || org.tier !== "free";
    await c.env.DB.prepare(
      `UPDATE organizations SET
         churned_at = CASE WHEN ? THEN COALESCE(churned_at, COALESCE(?, datetime('now'))) ELSE churned_at END,
         cancel_at_period_end = 0,
         tier = 'free', stripe_subscription_id = NULL, seat_limit = 1
       WHERE id = ?`
    ).bind(isChurn ? 1 : 0, churnedAt, id).run();
    return c.json({ synced: true, tier: "free", subscription: null, churned_at: isChurn ? (churnedAt ?? "now") : null });
  }

  const priceId = activeSub.items?.data?.[0]?.price?.id;
  const quantity = activeSub.items?.data?.[0]?.quantity ?? 1;
  let tier: string = "pro";
  if (priceId === c.env.STRIPE_PRICE_ID_TEAM) tier = "team";
  const seatLimit = tier === "team" ? quantity : 1;

  // Both of Stripe's scheduled-cancel mechanisms count (see billing.ts
  // webhook note): the bool AND the cancel_at timestamp.
  const cancelling = Boolean(activeSub.cancel_at_period_end) || (typeof activeSub.cancel_at === "number" && activeSub.cancel_at > 0);
  await c.env.DB.prepare(
    "UPDATE organizations SET tier = ?, stripe_subscription_id = ?, seat_limit = ?, cancel_at_period_end = ?, churned_at = CASE WHEN ? = 0 THEN NULL ELSE churned_at END WHERE id = ?"
  ).bind(
    tier,
    activeSub.id,
    seatLimit,
    cancelling ? 1 : 0,
    cancelling ? 1 : 0,
    id,
  ).run();

  return c.json({
    synced: true,
    tier,
    subscription_id: activeSub.id,
    status: activeSub.status,
    cancel_at_period_end: cancelling,
    cancel_at: activeSub.cancel_at ? new Date(activeSub.cancel_at * 1000).toISOString() : null,
    seat_limit: seatLimit,
  });
});

// POST /admin/daily-report/send — manually trigger the daily ops email
// (same path the 13:00 UTC cron takes). Useful for testing delivery.
admin.post("/daily-report/send", async (c) => {
  await sendDailyReport(c.env);
  return c.json({ sent: true });
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
