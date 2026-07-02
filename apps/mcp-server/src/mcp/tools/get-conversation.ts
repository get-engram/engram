import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getConversation } from "../../services/conversation.js";
import { audit } from "../../services/audit.js";
import { loadPrivacy, PRIVACY_BODIES_NOTICE } from "../../services/privacy.js";
import type { Env, AuthContext } from "../../types.js";

export function registerGetConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.registerTool(
    "get_conversation",
    {
      description: "Get a conversation with its full verbatim messages. Supports pagination.",
      inputSchema: {
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
      outputSchema: {
        conversation: z
          .object({
            id: z.string().optional(),
            title: z.string().nullable().optional(),
            agent_id: z.string().nullable().optional(),
            tags: z.array(z.string()).optional(),
            metadata: z.record(z.unknown()).optional(),
            message_count: z.number().optional(),
            created_at: z.string().optional(),
            updated_at: z.string().optional(),
          })
          .passthrough(),
        messages: z.array(
          z
            .object({
              id: z.string().optional(),
              conversation_id: z.string().optional(),
              role: z.string().optional(),
              content: z.string().optional(),
              sequence: z.number().optional(),
              created_at: z.string().optional(),
            })
            .passthrough(),
        ),
      },
      annotations: {
        title: "Get conversation",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
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
      const privacy = await loadPrivacy(env.DB, auth.organizationId);
      const messages = result.messages.map((m) => {
        const {
          organization_id: _mo,
          content_encoding: _enc,
          content,
          ...rest
        } = m as typeof m & {
          organization_id?: string;
          content_encoding?: string;
          content?: string;
        };
        // Honor the org's privacy setting: when bodies are hidden, return
        // message metadata (role, sequence, timestamps) but not content.
        return privacy.canReadBodies
          ? { ...rest, content }
          : { ...rest, body_hidden: true };
      });

      const payload = privacy.canReadBodies
        ? { conversation, messages }
        : { conversation, messages, privacy_notice: PRIVACY_BODIES_NOTICE };

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
