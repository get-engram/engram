import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Env, AuthContext } from "../../types.js";

function adminGuard(auth: AuthContext) {
  if (!auth.isAdmin) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            error: "admin_required",
            message: "This tool requires admin access. Authenticate with the ADMIN_SECRET.",
          }),
        },
      ],
      isError: true as const,
    };
  }
  return null;
}

export function registerAdminMetrics(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "admin_metrics",
    "Business metrics dashboard — signups, active users, tier breakdown, storage stats. Requires admin authentication.",
    {},
    async () => {
      const denied = adminGuard(auth);
      if (denied) return denied;

      const [orgs, active, tiers, totals, dbSize] = await Promise.all([
        // Total orgs + recent signups
        env.DB.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) as last_7d,
            SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) as last_30d
          FROM organizations
        `).first<{ total: number; last_7d: number; last_30d: number }>(),

        // Active users (stored ≥1 message in last 30 days)
        env.DB.prepare(`
          SELECT COUNT(DISTINCT o.id) as active
          FROM organizations o
          JOIN conversations c ON c.organization_id = o.id
          WHERE c.updated_at >= datetime('now', '-30 days')
            AND c.message_count > 0
        `).first<{ active: number }>(),

        // Tier breakdown
        env.DB.prepare(`
          SELECT tier, COUNT(*) as count
          FROM organizations
          GROUP BY tier
        `).all<{ tier: string; count: number }>(),

        // Total conversations + messages
        env.DB.prepare(`
          SELECT
            COUNT(*) as conversations,
            COALESCE(SUM(message_count), 0) as messages
          FROM conversations
        `).first<{ conversations: number; messages: number }>(),

        // DB row counts
        env.DB.prepare(`
          SELECT
            (SELECT COUNT(*) FROM conversation_chunks) as chunks,
            (SELECT COUNT(*) FROM api_keys) as api_keys,
            (SELECT COUNT(*) FROM audit_log) as audit_entries
        `).first<{ chunks: number; api_keys: number; audit_entries: number }>(),
      ]);

      const tierMap: Record<string, number> = {};
      for (const row of tiers?.results ?? []) {
        tierMap[row.tier || "free"] = row.count;
      }

      const metrics = {
        signups: {
          total: orgs?.total ?? 0,
          last_7d: orgs?.last_7d ?? 0,
          last_30d: orgs?.last_30d ?? 0,
        },
        active_users_30d: active?.active ?? 0,
        tiers: tierMap,
        storage: {
          conversations: totals?.conversations ?? 0,
          messages: totals?.messages ?? 0,
          chunks: dbSize?.chunks ?? 0,
          api_keys: dbSize?.api_keys ?? 0,
          audit_entries: dbSize?.audit_entries ?? 0,
        },
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(metrics, null, 2) },
        ],
      };
    }
  );

  server.tool(
    "admin_users",
    "List all organizations with usage stats — names, emails, tiers, conversation and message counts. Requires admin authentication.",
    {
      sort: z
        .enum(["created_at", "total_messages", "conversations"])
        .optional()
        .default("created_at")
        .describe("Sort field"),
      order: z.enum(["asc", "desc"]).optional().default("desc"),
      limit: z.number().int().min(1).max(100).optional().default(50),
    },
    async (params) => {
      const denied = adminGuard(auth);
      if (denied) return denied;

      const allowedSort: Record<string, string> = {
        created_at: "o.created_at",
        total_messages: "total_messages",
        conversations: "conversations",
      };
      const sortCol = allowedSort[params.sort] ?? "o.created_at";
      const order = params.order === "asc" ? "ASC" : "DESC";

      const result = await env.DB.prepare(`
        SELECT
          o.id,
          o.name,
          o.email,
          o.tier,
          o.created_at,
          COUNT(c.id) as conversations,
          COALESCE(SUM(c.message_count), 0) as total_messages
        FROM organizations o
        LEFT JOIN conversations c ON c.organization_id = o.id
        GROUP BY o.id
        ORDER BY ${sortCol} ${order}
        LIMIT ?
      `)
        .bind(params.limit)
        .all<{
          id: string;
          name: string;
          email: string | null;
          tier: string;
          created_at: string;
          conversations: number;
          total_messages: number;
        }>();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              users: result.results,
              total: result.results.length,
            }, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "admin_health",
    "Operational health check — recent errors, audit log activity, and API key usage. Requires admin authentication.",
    {
      hours: z
        .number()
        .int()
        .min(1)
        .max(168)
        .optional()
        .default(24)
        .describe("Look-back window in hours (default 24, max 168 = 7 days)"),
    },
    async (params) => {
      const denied = adminGuard(auth);
      if (denied) return denied;

      const since = `-${params.hours} hours`;

      const [auditSummary, recentKeys, recentSignups] = await Promise.all([
        // Audit log action breakdown
        env.DB.prepare(`
          SELECT action, COUNT(*) as count
          FROM audit_log
          WHERE created_at >= datetime('now', ?)
          GROUP BY action
          ORDER BY count DESC
          LIMIT 20
        `)
          .bind(since)
          .all<{ action: string; count: number }>(),

        // Most recently used API keys
        env.DB.prepare(`
          SELECT
            ak.key_prefix,
            ak.name,
            ak.last_used_at,
            o.name as org_name,
            o.email as org_email
          FROM api_keys ak
          JOIN organizations o ON o.id = ak.organization_id
          WHERE ak.last_used_at IS NOT NULL
          ORDER BY ak.last_used_at DESC
          LIMIT 10
        `).all<{
          key_prefix: string;
          name: string;
          last_used_at: string;
          org_name: string;
          org_email: string | null;
        }>(),

        // Recent signups
        env.DB.prepare(`
          SELECT id, name, email, tier, created_at
          FROM organizations
          WHERE created_at >= datetime('now', ?)
          ORDER BY created_at DESC
        `)
          .bind(since)
          .all<{
            id: string;
            name: string;
            email: string | null;
            tier: string;
            created_at: string;
          }>(),
      ]);

      const health = {
        window_hours: params.hours,
        audit_actions: auditSummary.results,
        recent_api_keys: recentKeys.results,
        recent_signups: recentSignups.results,
      };

      return {
        content: [
          { type: "text" as const, text: JSON.stringify(health, null, 2) },
        ],
      };
    }
  );
}
