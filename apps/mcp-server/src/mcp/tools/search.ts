import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchConversations } from "../../services/search.js";
import { checkAndTrackSearch } from "../../services/tier.js";
import { audit } from "../../services/audit.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import { limitMessage } from "../usage-messaging.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE, stripBodyFields } from "../../services/privacy.js";
import { hasScope, scopeError } from "../scopes.js";
import { MAX_SEARCH_QUERY_CHARS } from "@getengram/shared";
import { searchEmptyTip, firstRunActivation } from "../coaching.js";
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
        "Searches the user's long-term memory. Applicable when previously saved context is relevant to the current request — for example when the user references something from before ('what did we decide', 'like last time', 'my usual', a project/person/preference by name) or asks what is remembered about a topic. Hybrid search (semantic + keyword) across stored conversations. Each result includes a short chunk_summary, the full chunk_text snippet, conversation_title, tags, and relevance scores, best match first.",
      inputSchema: {
      query: z.string().max(MAX_SEARCH_QUERY_CHARS).describe("Search query text"),
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
              .loose(),
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

      // Search budget (engram#451): counted BEFORE the query embedding —
      // that and the vector/FTS query are the cost being bounded.
      const searchCheck = await checkAndTrackSearch(env.DB, auth.organizationId, auth.tier);
      if (!searchCheck.allowed) {
        const isOAuth = isExternalOAuthClient(auth);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: searchCheck.error,
                message: limitMessage({
                  unit: "searches",
                  tier: searchCheck.tier,
                  limit: searchCheck.limit,
                  used: searchCheck.used,
                  isOAuth,
                }),
                limit: searchCheck.limit,
                used: searchCheck.used,
                tier: searchCheck.tier,
                upgrade_url: isOAuth
                  ? "https://getengram.app/dashboard"
                  : "https://getengram.app/pricing",
              }),
            },
          ],
          isError: true,
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
      const results = privacy.canReadBodies ? raw : stripBodyFields(raw);

      await audit(env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
        query: params.query,
        results: results.length,
      });

      const emptyTip = results.length === 0 ? searchEmptyTip(auth) : undefined;
      // First-run forcing function: a brand-new account's searches only ever
      // hit the seeded welcome note, so the empty-tip never fires — attach the
      // activation script instead so the model drives the first save now.
      const activation = await firstRunActivation(env, auth);
      const payload = {
        results,
        total: results.length,
        ...(privacy.canReadBodies ? {} : { privacy_notice: PRIVACY_BODIES_NOTICE }),
        ...(emptyTip ? { tip: emptyTip } : {}),
        ...(activation ? { activation } : {}),
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
