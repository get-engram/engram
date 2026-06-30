import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getNamedSecret } from "@getengram/db";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerVaultGet(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "vault_get",
    "Retrieve a named secret's encrypted blob. Decryption happens client-side with your vault key.",
    {
      name: z
        .string()
        .min(1)
        .describe("Secret name to retrieve (e.g. DATABASE_URL)"),
    },
    {
      title: "Get vault secret",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      const row = await getNamedSecret(
        env.DB,
        auth.organizationId,
        params.name
      );

      audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "vault.get",
        "named_secret",
        params.name,
        { found: !!row }
      );

      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Secret "${params.name}" not found`,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              name: row.name,
              encrypted_value: row.encrypted_value,
              iv: row.iv,
              secret_type: row.secret_type,
              created_at: row.created_at,
              updated_at: row.updated_at,
            }),
          },
        ],
      };
    }
  );
}
