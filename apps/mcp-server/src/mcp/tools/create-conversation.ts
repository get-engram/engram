import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createConversation } from "../../services/conversation.js";
import { getConversationCount } from "@getengram/db";
import { checkConversationLimit } from "../../services/tier.js";
import { fireWebhooks } from "../../services/webhooks.js";
import { audit } from "../../services/audit.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import { limitMessage } from "../usage-messaging.js";
import type { Env, AuthContext } from "../../types.js";

export function registerCreateConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "create_conversation",
    "Create a new conversation and return its conversation_id. Call this yourself to obtain an id before appending — the id is yours to generate and reuse; never ask the user to provide one. Create one conversation per session/topic and reuse its id for all subsequent append_messages calls.",
    {
      title: z.string().optional().describe("Title for the conversation"),
      agent_id: z.string().optional().describe("Agent identifier (e.g. \"chatgpt\")"),
      tags: z.array(z.string()).optional().describe("Tags for filtering"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata"),
    },
    {
      title: "Create conversation",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    async (params) => {
      // Check conversation limit
      const countResult = await getConversationCount(env.DB, auth.organizationId);
      const currentCount = countResult?.count ?? 0;
      const tierCheck = checkConversationLimit(auth.tier, currentCount);

      if (!tierCheck.allowed) {
        const isOAuth = isExternalOAuthClient(auth);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: tierCheck.error,
                message: limitMessage({
                  unit: "conversations",
                  tier: tierCheck.tier,
                  limit: tierCheck.limit,
                  used: tierCheck.used,
                  isOAuth,
                }),
                limit: tierCheck.limit,
                used: tierCheck.used,
                tier: tierCheck.tier,
                upgrade_url: isOAuth
                  ? "https://getengram.app/dashboard"
                  : "https://getengram.app/pricing",
              }),
            },
          ],
          isError: true,
        };
      }

      const id = await createConversation(
        env.DB,
        auth.organizationId,
        params.title,
        params.agent_id,
        params.tags,
        params.metadata as Record<string, unknown>
      );

      audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.create", "conversation", id);

      // Fire webhooks (non-blocking)
      fireWebhooks(env.DB, auth.organizationId, "conversation.created", {
        conversation_id: id,
        title: params.title ?? null,
      }).catch(() => {});

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ conversation_id: id }),
          },
        ],
      };
    }
  );
}
