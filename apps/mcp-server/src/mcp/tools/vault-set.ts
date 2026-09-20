import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateId } from "@getengram/shared";
import { upsertNamedSecret } from "@getengram/db";
import { audit } from "../../services/audit.js";
import { hasScope, scopeError } from "../scopes.js";
import type { Env, AuthContext } from "../../types.js";

export function registerVaultSet(
  server: McpServer,
  env: Env,
  auth: AuthContext
) {
  server.tool(
    "vault_set",
    "Store a named secret. The value must be encrypted client-side before calling this tool. The server stores the encrypted blob — it never sees plaintext.",
    {
      name: z
        .string()
        .min(1)
        .max(255)
        .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/, "Name must be alphanumeric with underscores, dots, or hyphens")
        .describe("Secret name (e.g. DATABASE_URL, OPENAI_KEY)"),
      encrypted_value: z
        .string()
        .min(1)
        // Secrets are small (keys, tokens, connection strings, the odd cert).
        // 64 KB of base64 ciphertext is well beyond any real secret and caps
        // storage abuse of an otherwise unbounded, opaque field.
        .max(65536, "Encrypted value exceeds 64 KB")
        .describe("Base64-encoded AES-256-GCM ciphertext"),
      iv: z
        .string()
        .min(1)
        .describe("Base64-encoded initialization vector"),
      secret_type: z
        .string()
        .default("unknown")
        .describe("Type of secret (e.g. api_key, connection_string, token)"),
    },
    {
      title: "Set vault secret",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async (params) => {
      if (!hasScope(auth, "write")) return scopeError("write");
      const id = generateId("vlt");

      await upsertNamedSecret(env.DB, {
        id,
        organizationId: auth.organizationId,
        name: params.name,
        encryptedValue: params.encrypted_value,
        iv: params.iv,
        secretType: params.secret_type,
      });

      await audit(
        env.DB,
        auth.organizationId,
        auth.apiKeyId,
        "vault.set",
        "named_secret",
        params.name,
        { secret_type: params.secret_type }
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              stored: true,
              name: params.name,
              secret_type: params.secret_type,
            }),
          },
        ],
      };
    }
  );
}
