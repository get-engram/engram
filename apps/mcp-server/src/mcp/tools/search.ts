import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchConversations } from "../../services/search.js";
import { trackSearchRun } from "../../services/tier.js";
import { audit } from "../../services/audit.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE,
} from "../../services/privacy.js";
import { hasScope, scopeError } from "../scopes.js";
import { searchEmptyTip } from "../coaching.js";
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
        "Hybrid search (semantic + keyword) across stored conversations. Each result has a short chunk_summary for quick triage plus the full chunk_text snippet, with conversation_title, tags, and scores. Read chunk_summary to pick the relevant result, then use chunk_text or get_conversation for full context. One search is enough — do not retry with rephrased queries.",
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
      project: z
        .string()
        .optional()
        .describe("Filter by project name (matches conversation title prefix, case-insensitive). Use to avoid cross-project noise."),
      },
      outputSchema: {
        results: z
          .array(
            z
              .object({
                conversation_id: z.string().optional(),
                conversation_title: z.string().optional(),
                chunk_text: z.string().optional(),
                chunk_summary: z.string().optional(),
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
      if (!hasScope(auth, "search")) return scopeError("search");
      const privacy = await loadPrivacy(env.DB, auth.organizationId);

      // A search without a conversation_id spans all conversations. When
      // cross-conversation access is off, only single-conversation search
      // is allowed.
      if (!privacy.canReadCrossConversation && !params.conversation_id) {
        const payload = {
          results: [],
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

      const raw = await searchConversations(
        env,
        auth.organizationId,
        params.query,
        params.limit,
        params.conversation_id,
        params.tags,
        undefined, // snippetChars
        undefined, // minScore
        undefined, // dedupe
        params.project,
        auth.seatId, // private-space filter (engram#264)
      );

      // When bodies are hidden, return the matching conversations'
      // metadata (title, tags, score) but drop the verbatim snippet.
      const results = privacy.canReadBodies
        ? raw
        : raw.map(({ chunk_text: _c, ...rest }) => rest);

      // Track usage
      await trackSearchRun(env.DB, auth.organizationId).catch(() => {});
      await audit(env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
        query: params.query,
        results: results.length,
      });

      const emptyTip = results.length === 0 ? searchEmptyTip(auth) : undefined;
      const payload = {
        results,
        total: results.length,
        ...(privacy.canReadBodies ? {} : { privacy_notice: PRIVACY_BODIES_NOTICE }),
        ...(emptyTip ? { tip: emptyTip } : {}),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(payload),
          },
        ],
        structuredContent: payload,
      };
    }
  );
}
