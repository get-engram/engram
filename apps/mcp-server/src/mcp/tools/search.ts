import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchConversations,
  DEFAULT_SNIPPET_CHARS,
  DEFAULT_MIN_SCORE,
  MAX_SNIPPET_CHARS,
} from "../../services/search.js";
import { trackSearchRun } from "../../services/tier.js";
import type { Env, AuthContext } from "../../types.js";

export function registerSearch(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "search",
    "Semantic search across stored conversations. Returns the matching chunk_text snippets with relevance scores. For the full structured messages of a chunk, call get_conversation with the returned conversation_id + start_sequence / end_sequence.",
    {
      query: z.string().describe("Search query text"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe("Max results to return (default 5)"),
      conversation_id: z
        .string()
        .optional()
        .describe("Limit search to a specific conversation"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Filter by conversation tags"),
      snippet_chars: z
        .number()
        .int()
        .min(0)
        .max(MAX_SNIPPET_CHARS)
        .optional()
        .default(DEFAULT_SNIPPET_CHARS)
        .describe(
          `Max characters of chunk_text to return per result (default ${DEFAULT_SNIPPET_CHARS}, max ${MAX_SNIPPET_CHARS}). Longer snippets = larger responses.`
        ),
      min_score: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(DEFAULT_MIN_SCORE)
        .describe(
          `Minimum similarity score (0-1) to include a result (default ${DEFAULT_MIN_SCORE}). Filters out low-relevance noise.`
        ),
      dedupe: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Deduplicate overlapping chunks from the same conversation (default true). Set false to see all matching chunks."
        ),
    },
    async (params) => {
      const results = await searchConversations(
        env,
        auth.organizationId,
        params.query,
        params.limit,
        params.conversation_id,
        params.tags,
        params.snippet_chars,
        params.min_score,
        params.dedupe
      );

      // Track usage (non-blocking)
      trackSearchRun(env.DB, auth.organizationId).catch(() => {});

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
