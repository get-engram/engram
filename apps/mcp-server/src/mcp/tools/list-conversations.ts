import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConversations as dbListConversations } from "@getengram/db";
import { audit } from "../../services/audit.js";
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
      audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.list");

      const result = await dbListConversations(env.DB, auth.organizationId, {
        limit: params.limit,
        offset: params.offset,
        agentId: params.agent_id,
        tags: params.tags,
        sort: params.sort,
        order: params.order,
      });

      const conversations = (result.results as Array<Record<string, unknown>>).map(
        ({ organization_id: _o, ...c }) => ({
          ...c,
          tags: JSON.parse((c.tags as string) || "[]"),
          metadata: JSON.parse((c.metadata as string) || "{}"),
        }),
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
