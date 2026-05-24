import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendMessages } from "../../services/conversation.js";
import { checkAndTrackMessages } from "../../services/tier.js";
import { fireWebhooks } from "../../services/webhooks.js";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerAppendMessages(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "append_messages",
    "Append messages to a conversation. Messages are stored verbatim and automatically chunked + embedded for search. Optionally accepts client-encrypted vault entries for secrets detected client-side.",
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
      vault_entries: z
        .array(
          z.object({
            id: z.string().describe("Vault entry ID (e.g. vlt_abc123)"),
            encrypted_value: z
              .string()
              .describe("Base64-encoded AES-256-GCM ciphertext"),
            iv: z.string().describe("Base64-encoded 12-byte IV"),
            secret_type: z
              .string()
              .describe(
                "Type of secret (api_key, ssn, connection_string, etc.)"
              ),
          })
        )
        .optional()
        .describe(
          "Client-encrypted vault entries. Server stores these as opaque blobs — zero knowledge."
        ),
    },
    async (params) => {
      // Atomically check tier limit AND increment usage in one operation.
      // Prevents race conditions where concurrent requests both pass the
      // check but together exceed the limit.
      const tierCheck = await checkAndTrackMessages(
        env.DB,
        auth.organizationId,
        auth.tier,
        params.messages.length
      );

      if (!tierCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: tierCheck.error,
                message: `Message limit exceeded. Your ${tierCheck.tier} plan allows ${tierCheck.limit?.toLocaleString()} messages/month. Used: ${tierCheck.used?.toLocaleString()}. Upgrade at https://getengram.app/pricing`,
                limit: tierCheck.limit,
                used: tierCheck.used,
                tier: tierCheck.tier,
              }),
            },
          ],
          isError: true,
        };
      }

      const messages = await appendMessages(
        env,
        auth.organizationId,
        params.conversation_id,
        params.messages.map((m) => ({
          ...m,
          metadata: m.metadata as Record<string, unknown>,
        })),
        params.vault_entries
      );

      audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "messages.append",
        "conversation",
        params.conversation_id,
        {
          count: messages.length,
          vault_entries: params.vault_entries?.length ?? 0,
        }
      );

      // Fire webhooks (non-blocking)
      fireWebhooks(env.DB, auth.organizationId, "messages.appended", {
        conversation_id: params.conversation_id,
        message_count: messages.length,
        message_ids: messages.map((m) => m.id),
      }).catch(() => {});

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              appended: messages.length,
              message_ids: messages.map((m) => m.id),
              vault_entries_stored: params.vault_entries?.length ?? 0,
            }),
          },
        ],
      };
    }
  );
}
