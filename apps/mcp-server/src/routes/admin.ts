import { Hono } from "hono";
import { getAuditLogs } from "@getengram/db";
import { compressContent, ENCODING_GZIP } from "../utils/compress.js";
import type { Env } from "../types.js";

type AdminEnv = { Bindings: Env };

export const admin = new Hono<AdminEnv>();

// ---------------------------------------------------------------------------
// GET /admin/metrics — Business metrics dashboard
// ---------------------------------------------------------------------------
admin.get("/metrics", async (c) => {
  const [orgs, active, tiers, totals, dbSize, referrals, todaySignups] = await Promise.all([
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
  const body = await c.req.json<{ tier?: string }>().catch(() => ({}));

  if (body.tier && ["free", "pro", "team", "enterprise"].includes(body.tier)) {
    await c.env.DB.prepare(
      "UPDATE organizations SET tier = ? WHERE id = ?"
    ).bind(body.tier, id).run();
    return c.json({ updated: true, id, tier: body.tier });
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
