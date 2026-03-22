import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listConversations as dbListConversations } from "@maas/db";
import type { Env, AuthContext } from "../../types.js";

export function registerListConversations(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "list_conversations",
    "List conversations with filtering and sorting options.",
    {
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
    async (params) => {
      const result = await dbListConversations(env.DB, auth.organizationId, {
        limit: params.limit,
        offset: params.offset,
        agentId: params.agent_id,
        tags: params.tags,
        sort: params.sort,
        order: params.order,
      });

      const conversations = (result.results as Array<Record<string, unknown>>).map((c) => ({
        ...c,
        tags: JSON.parse((c.tags as string) || "[]"),
        metadata: JSON.parse((c.metadata as string) || "{}"),
      }));

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
      };
    }
  );
}
