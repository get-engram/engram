import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getVaultEntriesByIds } from "@getengram/db";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerResolveVault(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "resolve_vault",
    "Retrieve encrypted vault entries by ID. Returns encrypted blobs — decryption happens client-side.",
    {
      vault_ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("Vault entry IDs to resolve (e.g. vlt_abc123)"),
    },
    async (params) => {
      const result = await getVaultEntriesByIds(
        env.DB,
        params.vault_ids,
        auth.organizationId
      );

      const entries = result.results.map((r: Record<string, unknown>) => ({
        id: r.id,
        encrypted_value: r.encrypted_value,
        iv: r.iv,
        secret_type: r.secret_type,
        conversation_id: r.conversation_id,
        created_at: r.created_at,
      }));

      audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "vault.resolve",
        "vault",
        params.vault_ids.join(","),
        { requested: params.vault_ids.length, returned: entries.length }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              entries,
              total: entries.length,
            }),
          },
        ],
      };
    }
  );
}
