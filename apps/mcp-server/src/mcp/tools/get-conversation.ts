import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConversation } from "../../services/conversation.js";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerGetConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "get_conversation",
    "Get a conversation with its full verbatim messages. Supports pagination.",
    {
      conversation_id: z.string().describe("The conversation to retrieve"),
      message_limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(100)
        .describe("Max messages to return"),
      message_offset: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(0)
        .describe("Message offset for pagination"),
    },
    {
      title: "Get conversation",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.read", "conversation", params.conversation_id);

      const result = await getConversation(
        env.DB,
        auth.organizationId,
        params.conversation_id,
        params.message_limit,
        params.message_offset
      );

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: "Conversation not found" }),
            },
          ],
          isError: true,
        };
      }

      // Strip internal fields the model/user don't need and that app
      // marketplaces flag (internal account IDs, storage encoding).
      const { organization_id: _o, ...conversation } = result.conversation;
      const messages = result.messages.map((m) => {
        const {
          organization_id: _mo,
          content_encoding: _enc,
          ...rest
        } = m as typeof m & { organization_id?: string; content_encoding?: string };
        return rest;
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ conversation, messages }),
          },
        ],
      };
    }
  );
}
