import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getOrganizationById } from "@getengram/db";
import type { Env, AuthContext } from "../../types.js";

/**
 * whoami — which Engram account is this session talking to?
 *
 * Exists because the answer has repeatedly been non-obvious in practice: the
 * owner ran two orgs for months, a daemon quietly wrote to the wrong one for
 * a day after they were merged, and a ChatGPT connector held tokens bound to
 * an org that no longer had any data. Every one of those cost real debugging
 * time that a one-word tool call would have answered.
 *
 * Deliberately read-only and registered for EVERY auth kind, including
 * external OAuth clients — identity confusion is most likely precisely in
 * the connector clients with the narrowed tool surface.
 */
export function registerWhoami(server: McpServer, env: Env, auth: AuthContext) {
  server.tool(
    "whoami",
    "Show which Engram account this connection is using — organization name, email, tier, and how you are authenticated. Use when unsure which account memories are being saved to or searched from.",
    {},
    {
      title: "Who am I",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      const org = (await getOrganizationById(env.DB, auth.organizationId)) as {
        name: string | null;
        email: string | null;
        tier: string;
        deleted_at: string | null;
      } | null;

      const viaOAuth = auth.apiKeyId.startsWith("oauth:");
      const lines = [
        `Organization: ${org?.name ?? "(unnamed)"} <${org?.email ?? "no email"}>`,
        `Org ID: ${auth.organizationId}`,
        `Tier: ${org?.tier ?? auth.tier}`,
        `Auth: ${viaOAuth ? `OAuth client (${auth.apiKeyId.slice(6)})` : `API key (${auth.apiKeyId})`}`,
        auth.seatId ? `Seat: ${auth.seatId}` : null,
        // Soft-deleted orgs still authenticate (that keeps account restore
        // reachable) — but anything saved here purges with the org, which is
        // exactly the surprise this tool exists to surface.
        org?.deleted_at
          ? `⚠️ WARNING: this account is scheduled for deletion (since ${org.deleted_at}). Anything saved here will be purged. If this is unexpected, restore the account or reconnect with the right one.`
          : null,
      ].filter(Boolean);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
