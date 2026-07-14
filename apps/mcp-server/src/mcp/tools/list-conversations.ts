import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConversations as dbListConversations } from "@getengram/db";
import { audit } from "../../services/audit.js";
import {
  loadPrivacy,
  PRIVACY_CROSS_CONVERSATION_NOTICE,
} from "../../services/privacy.js";
import { hasScope, scopeError } from "../scopes.js";
import { retentionCutoff } from "../../services/tier.js";
import type { Env, AuthContext } from "../../types.js";

export function registerListConversations(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.registerTool(
    "list_conversations",
    {
      description: "List conversations with filtering and sorting options.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(20),
        offset: z.number().int().min(0).optional().default(0),
        agent_id: z.string().optional().describe("Filter by agent ID"),
        tags: z.array(z.string()).optional().describe("Filter by tags"),
        sort: z
          .enum(["created_at", "updated_at", "message_count"])
          .optional()
          .default("updated_at"),
        order: z.enum(["asc", "desc"]).optional().default("desc"),
      },
      outputSchema: {
        conversations: z.array(
          z
            .object({
              id: z.string().optional(),
              title: z.string().nullable().optional(),
              agent_id: z.string().nullable().optional(),
              tags: z.array(z.string()).optional(),
              metadata: z.record(z.unknown()).optional(),
              message_count: z.number().optional(),
              created_at: z.string().optional(),
              updated_at: z.string().optional(),
              archived: z
                .boolean()
                .optional()
                .describe(
                  "Outside the free plan's memory window — hidden from search/recall, never deleted; upgrading unlocks it",
                ),
            })
            .passthrough(),
        ),
        total: z.number(),
      },
      annotations: {
        title: "List conversations",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!hasScope(auth, "read")) return scopeError("read");
      audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.list");

      // Listing all conversations is cross-conversation metadata sharing;
      // honor the org's privacy setting.
      const privacy = await loadPrivacy(env.DB, auth.organizationId);
      if (!privacy.canReadCrossConversation) {
        const payload = {
          conversations: [],
          total: 0,
          privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE,
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(payload) },
          ],
          structuredContent: payload,
        };
      }

      const result = await dbListConversations(env.DB, auth.organizationId, {
        limit: params.limit,
        offset: params.offset,
        agentId: params.agent_id,
        tags: params.tags,
        sort: params.sort,
        order: params.order,
      });

      // Memory window (engram#252): archived conversations stay listed —
      // seeing what exists is part of the upgrade story — but are flagged.
      const cutoff = retentionCutoff(auth.tier);
      const cutoffMs = cutoff ? Date.parse(cutoff) : NaN;
      const conversations = (result.results as Array<Record<string, unknown>>).map(
        ({ organization_id: _o, ...c }) => {
          const ts = c.updated_at ? Date.parse(c.updated_at as string) : NaN;
          const archived =
            !Number.isNaN(cutoffMs) && !Number.isNaN(ts) && ts < cutoffMs;
          return {
            ...c,
            tags: JSON.parse((c.tags as string) || "[]"),
            metadata: JSON.parse((c.metadata as string) || "{}"),
            ...(archived ? { archived: true } : {}),
          };
        },
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              conversations,
              total: conversations.length,
            }),
          },
        ],
        structuredContent: { conversations, total: conversations.length },
      };
    }
  );
}
