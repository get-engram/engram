import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchConversations } from "../../services/search.js";
import { trackSearchRun, retentionCutoff } from "../../services/tier.js";
import { retentionNotice } from "../usage-messaging.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import { TIER_LIMITS } from "@getengram/shared";
import { audit } from "../../services/audit.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE,
} from "../../services/privacy.js";
import { hasScope, scopeError } from "../scopes.js";
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
        archived_conversations: z
          .number()
          .optional()
          .describe(
            "Matching conversations hidden by the free plan's rolling memory window — archived, never deleted; upgrading unlocks them",
          ),
        retention_notice: z
          .string()
          .optional()
          .describe("Present when archived matches were withheld — relay this to the user"),
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

      const outcome = await searchConversations(
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
        retentionCutoff(auth.tier),
      );
      const raw = outcome.results;

      // When bodies are hidden, return the matching conversations'
      // metadata (title, tags, score) but drop the verbatim snippet.
      const results = privacy.canReadBodies
        ? raw
        : raw.map(({ chunk_text: _c, ...rest }) => rest);

      // Track usage (non-blocking)
      trackSearchRun(env.DB, auth.organizationId).catch(() => {});
      audit(env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
        query: params.query,
        results: results.length,
        archived: outcome.archived_conversations,
      });

      const payload: Record<string, unknown> = privacy.canReadBodies
        ? { results, total: results.length }
        : { results, total: results.length, privacy_notice: PRIVACY_BODIES_NOTICE };

      // Memory window (engram#252): tell the model — and through it the
      // user — that older matches exist and are safe, not gone.
      if (outcome.archived_conversations > 0) {
        payload.archived_conversations = outcome.archived_conversations;
        payload.retention_notice = retentionNotice({
          archivedCount: outcome.archived_conversations,
          retentionDays: TIER_LIMITS[auth.tier].retention_days,
          isOAuth: isExternalOAuthClient(auth),
        });
      }

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
