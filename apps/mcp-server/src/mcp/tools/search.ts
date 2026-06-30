import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchConversations } from "../../services/search.js";
import { trackSearchRun } from "../../services/tier.js";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerSearch(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.registerTool(
    "search",
    {
      description:
        "Hybrid search (semantic + keyword) across stored conversations. Returns the most relevant chunk_text snippets with conversation_title, tags, and scores. One search is enough — do not retry with rephrased queries.",
      inputSchema: {
      query: z.string().describe("Search query text"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .default(5)
        .describe("Max results (default 5)"),
      conversation_id: z
        .string()
        .optional()
        .describe("Limit search to a specific conversation"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by conversation tags"),
      },
      outputSchema: {
        results: z
          .array(
            z
              .object({
                conversation_id: z.string().optional(),
                conversation_title: z.string().optional(),
                chunk_text: z.string().optional(),
                score: z.number().optional(),
                chunk_id: z.string().optional(),
                start_sequence: z.number().optional(),
                end_sequence: z.number().optional(),
                tags: z.array(z.string()).optional(),
              })
              .passthrough(),
          )
          .describe("Relevant conversation snippets, best match first"),
        total: z.number(),
      },
      annotations: {
        title: "Search memory",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const results = await searchConversations(
        env,
        auth.organizationId,
        params.query,
        params.limit,
        params.conversation_id,
        params.tags,
      );

      // Track usage (non-blocking)
      trackSearchRun(env.DB, auth.organizationId).catch(() => {});
      audit(env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
        query: params.query,
        results: results.length,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ results, total: results.length }),
          },
        ],
        structuredContent: { results, total: results.length },
      };
    }
  );
}
