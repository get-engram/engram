import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createConversation } from "../../services/conversation.js";
import { getConversationCount } from "@getengram/db";
import { checkConversationLimit } from "../../services/tier.js";
import { fireWebhooks } from "../../services/webhooks.js";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerCreateConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "create_conversation",
    "Create a new conversation to store messages in. Returns the conversation ID.",
    {
      title: z.string().optional().describe("Title for the conversation"),
      agent_id: z.string().optional().describe("Agent identifier"),
      tags: z.array(z.string()).optional().describe("Tags for filtering"),
      metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata"),
    },
    async (params) => {
      // Check conversation limit
      const countResult = await getConversationCount(env.DB, auth.organizationId);
      const currentCount = countResult?.count ?? 0;
      const tierCheck = checkConversationLimit(auth.tier, currentCount);

      if (!tierCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: tierCheck.error,
                message: `Conversation limit exceeded. Your ${tierCheck.tier} plan allows ${tierCheck.limit} conversations. Upgrade at https://getengram.app/pricing`,
                limit: tierCheck.limit,
                used: tierCheck.used,
                tier: tierCheck.tier,
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
