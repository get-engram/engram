import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listNamedSecrets } from "@getengram/db";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerVaultList(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "vault_list",
    "List all named secrets. Returns names and metadata only — never values or encrypted blobs.",
    {},
    {
      title: "List vault secrets",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async () => {
      const result = await listNamedSecrets(env.DB, auth.organizationId);

      const secrets = result.results.map((r: Record<string, unknown>) => ({
        name: r.name,
        secret_type: r.secret_type,
        created_at: r.created_at,
        updated_at: r.updated_at,
      }));

      audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "vault.list",
        "named_secret",
        undefined,
        { count: secrets.length }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              secrets,
              total: secrets.length,
            }),
          },
        ],
      };
    }
  );
}
