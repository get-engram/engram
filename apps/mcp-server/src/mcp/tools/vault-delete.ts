import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { deleteNamedSecret, getNamedSecret } from "@getengram/db";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerVaultDelete(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "vault_delete",
    "Delete a named secret permanently. This action cannot be undone.",
    {
      name: z
        .string()
        .min(1)
        .describe("Secret name to delete"),
    },
    async (params) => {
      // Check existence first for audit
      const existing = await getNamedSecret(
        env.DB,
        auth.organizationId,
        params.name
      );

      if (!existing) {
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

      await deleteNamedSecret(env.DB, auth.organizationId, params.name);

      audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "vault.delete",
        "named_secret",
        params.name,
        {}
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              deleted: true,
              name: params.name,
            }),
          },
        ],
      };
    }
  );
}
