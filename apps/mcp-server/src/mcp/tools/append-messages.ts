import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  appendMessages,
  getOrCreateDefaultConversation,
} from "../../services/conversation.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import { newUserAppendTip } from "../coaching.js";
import {
  usageMeter,
  meterBar,
  limitMessage,
  approachingLimitNotice,
  storageFullMessage,
  approachingStorageNotice,
} from "../usage-messaging.js";
import {
  checkAndTrackMessages,
  checkAndTrackStorage,
  releaseStorage,
} from "../../services/tier.js";
import { fireWebhooks } from "../../services/webhooks.js";
import { checkMilestone } from "../../services/milestones.js";
import { audit } from "../../services/audit.js";
import { hasScope, scopeError } from "../scopes.js";
import type { Env, AuthContext } from "../../types.js";

export function registerAppendMessages(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.registerTool(
    "append_messages",
    {
      description:
        "Store messages in Engram memory, verbatim and automatically chunked + embedded for search. Pass the relevant messages from the CURRENT conversation. conversation_id is OPTIONAL: omit it to append to the user's default memory (recommended for general 'remember this' requests) — never ask the user for an id. Pass a conversation_id (from create_conversation) only when you want to group a specific topic. The response returns the conversation_id used. Note: you can only store messages from the current conversation — you cannot fetch a user's past or external chat history; for bulk history, tell them to export their data and run `engram import`. Optionally accepts client-encrypted vault entries for secrets detected client-side.",
      inputSchema: {
      conversation_id: z
        .string()
        .optional()
        .describe("Optional. Omit to use the default memory; or pass one from create_conversation to group a topic. Never ask the user for it."),
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
      outputSchema: {
        conversation_id: z.string().describe("The conversation the messages were stored in"),
        appended: z.number().describe("Number of messages stored"),
        message_ids: z.array(z.string()),
        vault_entries_stored: z.number(),
        usage: z
          .object({ used: z.number(), limit: z.number(), remaining: z.number() })
          .optional()
          .describe("Monthly message usage for the org (limited tiers only)"),
        storage: z
          .object({
            used: z.number(),
            limit: z.number(),
            remaining: z.number(),
            bar: z.string().optional().describe("Ready-to-display progress bar, e.g. [████████░░] 82%"),
          })
          .optional()
          .describe("Lifetime memory storage for the org (capped tiers only) — memory never expires; it fills up"),
        notice: z.string().optional().describe("Heads-up shown when approaching the plan limit"),
        milestone: z.string().optional().describe("One-time notice when lifetime storage crosses a threshold — worth relaying to the user"),
        storage_notice: z.string().optional().describe("Heads-up shown when memory storage is nearly full"),
      },
      annotations: {
        title: "Append messages",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (params) => {
      if (!hasScope(auth, "write")) return scopeError("write");
      const isOAuth = isExternalOAuthClient(auth);
      const count = params.messages.length;

      // Primary gate (engram#275): lifetime storage. Atomically reserves
      // space; released below if a later step rejects or fails.
      const storageCheck = await checkAndTrackStorage(
        env.DB,
        auth.organizationId,
        auth.tier,
        count
      );

      if (!storageCheck.allowed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: storageCheck.error,
                message: storageFullMessage({
                  limit: storageCheck.limit,
                  isOAuth,
                }),
                limit: storageCheck.limit,
                used: storageCheck.used,
                tier: storageCheck.tier,
                upgrade_url: isOAuth
                  ? "https://getengram.app/dashboard"
                  : "https://getengram.app/pricing",
              }),
            },
          ],
          isError: true,
        };
      }

      // Secondary gate: monthly velocity (abuse guard on paid tiers;
      // unlimited on free — the storage cap is free's only gate).
      const tierCheck = await checkAndTrackMessages(
        env.DB,
        auth.organizationId,
        auth.tier,
        count
      );

      if (!tierCheck.allowed) {
        // Give the reserved storage back — nothing was written.
        await releaseStorage(env.DB, auth.organizationId, count);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: tierCheck.error,
                message: limitMessage({
                  unit: "messages",
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

      // No conversation_id → append to the org's default memory (find-or-create).
      const conversationId =
        params.conversation_id ??
        (await getOrCreateDefaultConversation(env.DB, auth.organizationId));

      let messages;
      try {
        messages = await appendMessages(
          env,
          auth.organizationId,
          conversationId,
          params.messages.map((m) => ({
            ...m,
            metadata: m.metadata as Record<string, unknown>,
          })),
          params.vault_entries
        );
      } catch (err) {
        // The write failed — free the reserved storage so the lifetime
        // counter tracks what's actually stored.
        await releaseStorage(env.DB, auth.organizationId, count).catch(() => {});
        throw err;
      }

      await audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "messages.append",
        "conversation",
        conversationId,
        {
          count: messages.length,
          vault_entries: params.vault_entries?.length ?? 0,
        }
      );

      // Fire webhooks (non-blocking)
      fireWebhooks(env.DB, auth.organizationId, "messages.appended", {
        conversation_id: conversationId,
        message_count: messages.length,
        message_ids: messages.map((m) => m.id),
      }).catch(() => {});

      // Meters — monthly velocity (paid abuse guard) and lifetime storage
      // (the real gate), so clients can show progress and never surprise
      // the user.
      const meter = usageMeter(tierCheck.used, tierCheck.limit);
      const notice = approachingLimitNotice(meter, isOAuth);
      const storageMeterBase = usageMeter(storageCheck.used, storageCheck.limit);
      const storageNotice = approachingStorageNotice(storageMeterBase, isOAuth);
      const storageMeterVal = storageMeterBase
        ? { ...storageMeterBase, bar: meterBar(storageCheck.used, storageCheck.limit) }
        : undefined;

      // Coaching keys off lifetime storage — the count that exists on
      // every tier (free has no monthly meter anymore).
      const tip = newUserAppendTip(auth, storageCheck.used ?? tierCheck.used);
      // One-time storage milestones (engram#256) — ambient proof the
      // memory is growing; fires once per threshold per org.
      const milestone = await checkMilestone(env, auth.organizationId, storageCheck.used);
      const payload = {
        conversation_id: conversationId,
        appended: messages.length,
        message_ids: messages.map((m) => m.id),
        vault_entries_stored: params.vault_entries?.length ?? 0,
        ...(meter ? { usage: meter } : {}),
        ...(storageMeterVal ? { storage: storageMeterVal } : {}),
        ...(notice ? { notice } : {}),
        ...(storageNotice ? { storage_notice: storageNotice } : {}),
        ...(milestone ? { milestone } : {}),
        ...(tip ? { tip } : {}),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }
  );
}
