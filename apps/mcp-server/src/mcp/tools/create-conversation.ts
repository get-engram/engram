import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createConversation } from "../../services/conversation.js";
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
      const id = await createConversation(
        env.DB,
        auth.organizationId,
        params.title,
        params.agent_id,
        params.tags,
        params.metadata as Record<string, unknown>
      );

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
