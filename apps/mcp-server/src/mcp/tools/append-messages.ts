import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendMessages } from "../../services/conversation.js";
import type { Env, AuthContext } from "../../types.js";

export function registerAppendMessages(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "append_messages",
    "Append messages to a conversation. Messages are stored verbatim and automatically chunked + embedded for search.",
    {
      conversation_id: z.string().describe("The conversation to append to"),
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant", "system", "tool"]),
            content: z.string(),
            tool_call_id: z.string().optional(),
            tool_name: z.string().optional(),
            metadata: z.record(z.unknown()).optional(),
          })
        )
        .min(1)
        .describe("Messages to append"),
    },
    async (params) => {
      const messages = await appendMessages(
        env,
        auth.organizationId,
        params.conversation_id,
        params.messages.map((m) => ({
          ...m,
          metadata: m.metadata as Record<string, unknown>,
        }))
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              appended: messages.length,
              message_ids: messages.map((m) => m.id),
            }),
          },
        ],
      };
    }
  );
}
