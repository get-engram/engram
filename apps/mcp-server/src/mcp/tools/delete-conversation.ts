import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteConversation } from "../../services/conversation.js";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerDeleteConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "delete_conversation",
    "Delete a conversation and all its messages, chunks, and vector embeddings.",
    {
      conversation_id: z.string().describe("The conversation to delete"),
    },
    {
      title: "Delete conversation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      const deleted = await deleteConversation(
        env,
        auth.organizationId,
        params.conversation_id
      );

      audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.delete", "conversation", params.conversation_id);

      if (!deleted) {
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: true }),
          },
        ],
      };
    }
  );
}
