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
  server.tool(
    "search",
    "Hybrid search (semantic + keyword) across stored conversations. Returns the most relevant chunk_text snippets with conversation_title, tags, and scores. One search is enough — do not retry with rephrased queries. Tip: if the user references something recent (\"remember we were...\", \"pick up where we left off\"), use recency: \"strong\" to boost recent conversations. You can also use list_conversations(sort: \"updated_at\") for recent session context.",
    {
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
      recency: z
        .enum(["none", "auto", "strong"])
        .optional()
        .default("auto")
        .describe("Recency bias: 'none' = pure relevance, 'auto' = modest boost to recent conversations (default), 'strong' = heavily prefer recent conversations"),
    },
    async (params) => {
      const recencyWeights = { none: 0, auto: 0.15, strong: 0.5 };
      const recencyWeight = recencyWeights[params.recency];

      const results = await searchConversations(
        env,
        auth.organizationId,
        params.query,
        params.limit,
        params.conversation_id,
        params.tags,
        undefined, // snippetChars
        undefined, // minScore
        undefined, // dedupe
        recencyWeight,
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
      };
    }
  );
}
