import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TIER_LIMITS } from "@getengram/shared";
import { getUsage, getOrganizationById, getStorageUsed } from "@getengram/db";
import { storageLimitFor } from "../../services/tier.js";
import { usageMeter, meterBar } from "../usage-messaging.js";
import { isExternalOAuthClient } from "../auth-kind.js";
import type { Env, AuthContext } from "../../types.js";

/**
 * memory_status — "how full is my memory?" Read-only usage meter for any
 * client. ChatGPT/Claude relay the bar string verbatim, which gives users
 * a visual without any UI surface.
 */
export function registerMemoryStatus(
  server: McpServer,
  env: Env,
  auth: AuthContext,
) {
  server.registerTool(
    "memory_status",
    {
      description:
        "Show how full the user's Engram memory is: lifetime storage used vs their plan's capacity, with a ready-to-display progress bar. Call this when the user asks how much memory/space they have, how full Engram is, or about their plan usage. Show the bar line to the user verbatim.",
      inputSchema: {},
      outputSchema: {
        tier: z.string(),
        storage: z.object({
          used: z.number(),
          limit: z.number().describe("-1 means unlimited"),
          remaining: z.number().optional(),
          bar: z.string().optional().describe("e.g. [████████░░] 82%"),
        }),
        monthly: z
          .object({
            used: z.number(),
            limit: z.number(),
            remaining: z.number(),
            bar: z.string().optional(),
          })
          .optional()
          .describe("Monthly velocity meter — only present on tiers with a monthly limit"),
        note: z.string(),
      },
      annotations: {
        title: "Memory status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const [org, usage, storageRow] = await Promise.all([
        getOrganizationById(env.DB, auth.organizationId) as Promise<{
          seat_limit?: number;
        } | null>,
        getUsage(env.DB, auth.organizationId) as Promise<{
          messages_stored: number;
        } | null>,
        getStorageUsed(env.DB, auth.organizationId),
      ]);

      const storageUsed = storageRow?.messages_stored_total ?? 0;
      const storageLimit = storageLimitFor(auth.tier, org?.seat_limit ?? 1);
      const monthlyLimit = TIER_LIMITS[auth.tier].messages_per_month;
      const monthlyUsed = usage?.messages_stored ?? 0;

      const isOAuth = isExternalOAuthClient(auth);
      const upgradeAt = isOAuth
        ? "getengram.app/dashboard (sign in with the email used to connect this app)"
        : "getengram.app/pricing";

      const monthlyMeter = usageMeter(monthlyUsed, monthlyLimit);
      const payload = {
        tier: auth.tier,
        storage: {
          used: storageUsed,
          limit: storageLimit,
          ...(storageLimit > 0
            ? { remaining: Math.max(0, storageLimit - storageUsed) }
            : {}),
          ...(storageLimit > 0
            ? { bar: meterBar(storageUsed, storageLimit) }
            : {}),
        },
        ...(monthlyMeter
          ? {
              monthly: {
                ...monthlyMeter,
                bar: meterBar(monthlyUsed, monthlyLimit),
              },
            }
          : {}),
        note:
          storageLimit > 0
            ? `Memory never expires — deleting conversations frees space. More room: upgrade at ${upgradeAt}.`
            : "Memory never expires. This plan has unlimited storage.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );
}
