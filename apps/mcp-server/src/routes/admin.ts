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

  return c.json({
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
  const body = await c.req.json<{ tier?: string }>().catch(() => ({} as { tier?: string }));
  const tier = body.tier;

  if (tier && ["free", "pro", "team", "enterprise"].includes(tier)) {
    await c.env.DB.prepare(
      "UPDATE organizations SET tier = ? WHERE id = ?"
    ).bind(tier, id).run();
    return c.json({ updated: true, id, tier });
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
      `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&limit=10`,
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
    "SELECT id, stripe_customer_id FROM organizations WHERE id = ?"
  ).bind(id).first<{ id: string; stripe_customer_id: string | null }>();
  if (!org) return c.json({ error: "not_found" }, 404);
  if (!org.stripe_customer_id) return c.json({ error: "no_stripe_customer" }, 400);

  const subsRes = await fetch(
    `https://api.stripe.com/v1/subscriptions?customer=${org.stripe_customer_id}&limit=10`,
    { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
  );
  if (!subsRes.ok) return c.json({ error: "stripe_api_error" }, 502);

  const subs = await subsRes.json() as {
    data: Array<{
      id: string; status: string;
      items: { data: Array<{ price: { id: string }; quantity: number }> };
    }>;
  };

  const activeSub = subs.data.find((s) => s.status === "active" || s.status === "trialing");
  if (!activeSub) {
    await c.env.DB.prepare(
      "UPDATE organizations SET tier = 'free', stripe_subscription_id = NULL, seat_limit = 1 WHERE id = ?"
    ).bind(id).run();
    return c.json({ synced: true, tier: "free", subscription: null });
  }

  const priceId = activeSub.items?.data?.[0]?.price?.id;
  const quantity = activeSub.items?.data?.[0]?.quantity ?? 1;
  let tier: string = "pro";
  if (priceId === c.env.STRIPE_PRICE_ID_TEAM) tier = "team";
  const seatLimit = tier === "team" ? quantity : 1;

  await c.env.DB.prepare(
    "UPDATE organizations SET tier = ?, stripe_subscription_id = ?, seat_limit = ? WHERE id = ?"
  ).bind(tier, activeSub.id, seatLimit, id).run();

  return c.json({
    synced: true,
    tier,
    subscription_id: activeSub.id,
    status: activeSub.status,
    seat_limit: seatLimit,
  });
});

// POST /admin/daily-report/send — manually trigger the daily ops email
// (same path the 13:00 UTC cron takes). Useful for testing delivery.
admin.post("/daily-report/send", async (c) => {
  await sendDailyReport(c.env);
  return c.json({ sent: true });
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
