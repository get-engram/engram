import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteConversation } from "../../services/conversation.js";
import { audit } from "../../services/audit.js";
import { hasScope, scopeError } from "../scopes.js";
import type { Env, AuthContext } from "../../types.js";

export function registerDeleteConversation(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.registerTool(
    "delete_conversation",
    {
      description: "Delete a conversation and all its messages, chunks, and vector embeddings.",
      inputSchema: {
        conversation_id: z.string().describe("The conversation to delete"),
      },
      outputSchema: {
        deleted: z.boolean().describe("True when the conversation was deleted"),
      },
      annotations: {
        title: "Delete conversation",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!hasScope(auth, "delete")) return scopeError("delete");
      const deleted = await deleteConversation(
        env,
        auth.organizationId,
        params.conversation_id,
        auth
      );

      await audit(env.DB, auth.organizationId, auth.apiKeyId, "conversation.delete", "conversation", params.conversation_id);

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
        structuredContent: { deleted: true },
      };
    }
  );
}
