import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchConversations } from "../../services/search.js";
import type { Env, AuthContext } from "../../types.js";

export function registerSearch(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "search",
    "Semantic search across stored conversations. Returns matching conversation chunks with relevance scores and surrounding messages.",
    {
      query: z.string().describe("Search query text"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results to return"),
      conversation_id: z
        .string()
        .optional()
        .describe("Limit search to a specific conversation"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by conversation tags"),
    },
    async (params) => {
      const results = await searchConversations(
        env,
        auth.organizationId,
        params.query,
        params.limit,
        params.conversation_id,
        params.tags
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, total: results.length }),
          },
        ],
      };
    }
  );
}
