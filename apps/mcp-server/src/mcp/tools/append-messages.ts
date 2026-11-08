import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  appendMessages,
  getOrCreateDefaultConversation,
  type VaultEntryInput,
} from "../../services/conversation.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import { newUserAppendTip, firstSaveCelebration } from "../coaching.js";
import {
  usageMeter,
  meterBar,
  limitMessage,
  approachingLimitNotice,
  storageFullMessage,
  approachingStorageNotice,
} from "../usage-messaging.js";
import { reserveAppend, releaseAppendCharges } from "../../services/tier.js";
import { fireWebhooks } from "../../services/webhooks.js";
import { checkMilestone } from "../../services/milestones.js";
import {
  MAX_MESSAGES_PER_APPEND,
  MAX_MESSAGES_PER_APPEND_CONNECTOR,
  MAX_MESSAGE_METADATA_CHARS,
} from "@getengram/shared";
import { audit } from "../../services/audit.js";
import { hasScope, scopeError } from "../scopes.js";
import type { Env, AuthContext } from "../../types.js";

export function registerAppendMessages(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  // The connector surface is deliberately narrower than the first-party one
  // (engram#467). OpenAI rejected v2.0.1 because the tool "request[s] input
  // data that is overly broad … or includes the full conversation history":
  // `system`/`tool` roles, tool_call_id/tool_name, free-form metadata and a
  // 200-message cap together describe a transcript pipe, which is not what a
  // ChatGPT/Claude user is consenting to when they say "remember this".
  //
  // API-key and SDK callers — the user's own agents, including the CLI sync
  // daemon — keep the full schema: that surface has no app-store reviewer and
  // genuinely does replay whole sessions, tool messages and all.
  const connector = isExternalOAuthClient(auth);

  const messageItem = connector
    ? z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      })
    : z.object({
        role: z.enum(["user", "assistant", "system", "tool"]),
        // Not hard-capped here: oversized single messages (tool-output
        // dumps) are truncated server-side in appendMessages rather than
        // rejected, so the CLI sync daemon can't wedge on a message it
        // cannot split. Metadata IS capped — it's the smuggling vector.
        content: z.string(),
        tool_call_id: z.string().optional(),
        tool_name: z.string().optional(),
        metadata: z
          .record(z.string(), z.unknown())
          .refine((m) => JSON.stringify(m).length <= MAX_MESSAGE_METADATA_CHARS, {
            message: `metadata exceeds ${MAX_MESSAGE_METADATA_CHARS} serialized characters`,
          })
          .optional(),
      });

  const inputSchema = {
    conversation_id: z
      .string()
      .optional()
      .describe(
        "Optional. Omit to append to the user's default memory; set to group messages under a specific conversation.",
      ),
    messages: z
      .array(messageItem)
      .min(1)
      .max(connector ? MAX_MESSAGES_PER_APPEND_CONNECTOR : MAX_MESSAGES_PER_APPEND)
      .describe(
        connector
          ? "Only the specific message(s) the user asked to remember."
          : "Messages to append",
      ),
    ...(connector
      ? {}
      : {
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
                    "Type of secret (api_key, ssn, connection_string, etc.)",
                  ),
              }),
            )
            .optional()
            .describe(
              "Client-encrypted vault entries. Server stores these as opaque blobs — zero knowledge.",
            ),
        }),
  };

  server.registerTool(
    "append_messages",
    {
      description:
        "Saves messages to the user's long-term memory, making them available in future sessions in this app and any other AI the user connects. Applicable when the user asks to remember or save a specific thing (a preference, a fact, a decision, a goal, project context). Takes only the message(s) the user pointed at, not the conversation as a whole. The text is sent to and stored on Engram's servers, verbatim, auto-chunked + embedded for search. The user can view saved messages with get_conversation and delete them with delete_conversation, which deletes the conversation they were saved in along with its other messages. On multi-seat team accounts, saved messages are visible to the whole team by default; saving into a conversation created with visibility 'private' keeps them visible only to the seat that created it. conversation_id is optional: omit it to append to the user's default memory, or set it to group messages under a specific conversation. The response returns the conversation_id used. Stores only the messages passed in — it cannot fetch past or external chat history. Not suitable for secrets (passwords, API keys, tokens, government IDs): stored text is searchable and resurfaces in future context; Engram's separate zero-knowledge encrypted vault is the store for credentials." +
        (connector
          ? ""
          : " Optionally accepts client-encrypted vault entries."),
      inputSchema,
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
        milestone: z.string().optional().describe("One-time notice when lifetime storage crosses a threshold"),
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
      // Absent from the connector schema entirely — read through a cast so the
      // handler stays shared between both shapes.
      const vaultEntries = (params as { vault_entries?: VaultEntryInput[] })
        .vault_entries;

      // Every gate, in order, in one place (engram#591): lifetime storage
      // (engram#275), the month's message budget (a velocity guard on paid
      // tiers; free has none), then the indexing budget in chunks embedded
      // (engram#445/#450). A refusal has already given back what the gates
      // before it took.
      const reserved = await reserveAppend(
        env.DB,
        auth.organizationId,
        auth.tier,
        params.messages,
      );

      if (!reserved.allowed) {
        const check = reserved.check;
        const message =
          reserved.gate === "storage"
            ? storageFullMessage({ limit: check.limit, isOAuth })
            : limitMessage({
                unit: reserved.gate,
                tier: check.tier,
                limit: check.limit,
                used: check.used,
                isOAuth,
              });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: check.error,
                message,
                limit: check.limit,
                used: check.used,
                tier: check.tier,
                upgrade_url: isOAuth
                  ? "https://getengram.app/dashboard"
                  : "https://getengram.app/pricing",
              }),
            },
          ],
          isError: true,
        };
      }
      const { storage: storageCheck, messages: tierCheck } = reserved;

      let conversationId: string;
      let messages;
      try {
        // No conversation_id → append to the org's default memory (find-or-create).
        conversationId =
          params.conversation_id ??
          (await getOrCreateDefaultConversation(env.DB, auth.organizationId));

        // appendMessages refuses a conversation this caller can't write to
        // (absent, another tenant's, another seat's private one — engram#264)
        // as not-found, before anything is stored.
        messages = await appendMessages(
          env,
          auth.organizationId,
          conversationId,
          params.messages.map((m) => {
            // `metadata` exists only on the first-party shape; narrow via the
            // union rather than asserting it onto the connector shape.
            const meta = (m as { metadata?: Record<string, unknown> }).metadata;
            return { ...m, metadata: meta };
          }),
          vaultEntries,
          auth,
        );
      } catch (err) {
        // Nothing was stored (appendMessages throws only before it commits),
        // so every charge goes back: a refused or failed append costs nothing,
        // and a client that retries one can't drain the budgets (engram#591).
        await releaseAppendCharges(env.DB, auth.organizationId, reserved.charges);
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
          vault_entries: vaultEntries?.length ?? 0,
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
      // storageCheck.used is POST-increment; subtract this batch to know what
      // the account held before. <=1 before (just the seeded welcome note)
      // means THIS is the account's first real save — the single highest-value
      // teaching moment, so it gets a distinct line over the generic tip.
      const usedBefore =
        typeof storageCheck.used === "number"
          ? storageCheck.used - count
          : undefined;
      const tip =
        firstSaveCelebration(auth, usedBefore) ??
        newUserAppendTip(auth, storageCheck.used ?? tierCheck.used);
      // One-time storage milestones (engram#256) — ambient proof the
      // memory is growing; fires once per threshold per org.
      const milestone = await checkMilestone(env, auth.organizationId, storageCheck.used);
      const payload = {
        conversation_id: conversationId,
        appended: messages.length,
        message_ids: messages.map((m) => m.id),
        vault_entries_stored: vaultEntries?.length ?? 0,
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
