/**
 * Named secrets manager. Provides explicit key-value secret storage
 * with client-side encryption. Follows patterns from GitHub Secrets
 * and HashiCorp Vault:
 *
 * - Values are encrypted client-side before transmission (zero-knowledge)
 * - List only returns names and metadata, never values
 * - All operations are audit-logged server-side
 */

import { McpTransport } from "./transport.js";
import { EngramError } from "./errors.js";
import type { VaultConfig } from "./vault.js";
import type { NamedSecretMetadata } from "./types.js";

// Import the crypto helpers from vault.ts
// We need encrypt/decrypt but they're not exported — inline them here
// to keep vault.ts unchanged.

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const keyBytes = base64ToBytes(base64Key);
  if (keyBytes.length !== 32) {
    throw new Error(
      `Vault encryption key must be 32 bytes (AES-256). Got ${keyBytes.length} bytes.`
    );
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
}

async function encrypt(
  key: CryptoKey,
  plaintext: string
): Promise<{ encrypted: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    encoded
  );
  return {
    encrypted: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

async function decrypt(
  key: CryptoKey,
  encryptedB64: string,
  ivB64: string
): Promise<string> {
  const ciphertext = base64ToBytes(encryptedB64);
  const iv = base64ToBytes(ivB64);
  const plainBytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(plainBytes);
}

// Simple secret type detection for named secrets
function detectSecretType(value: string): string {
  if (/-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/.test(value)) return "private_key";
  if (/\bsk-[A-Za-z0-9]{20,}\b/.test(value)) return "api_key";
  if (/\bsk-ant-[A-Za-z0-9_-]{20,}\b/.test(value)) return "api_key";
  if (/\bAKIA[0-9A-Z]{16}\b/.test(value)) return "api_key";
  if (/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/.test(value)) return "api_key";
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(value)) return "jwt";
  if (/\b(postgres|postgresql|mysql|redis|mongodb)(:\/\/|%3A%2F%2F)/i.test(value)) return "connection_string";
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(value)) return "ssn";
  return "secret";
}

export class VaultManager {
  constructor(
    private transport: McpTransport,
    private vaultConfig: VaultConfig
  ) {}

  /**
   * Store a named secret. The value is encrypted client-side before
   * being sent to the server. If a secret with this name already exists,
   * it is overwritten.
   *
   * @param name - Secret name (e.g. DATABASE_URL, OPENAI_KEY)
   * @param value - Plaintext secret value (encrypted before transmission)
   */
  async set(name: string, value: string): Promise<void> {
    const key = await importKey(this.vaultConfig.encryptionKey);
    const { encrypted, iv } = await encrypt(key, value);
    const secretType = detectSecretType(value);

    const raw = await this.transport.callTool("vault_set", {
      name,
      encrypted_value: encrypted,
      iv,
      secret_type: secretType,
    });

    const data = JSON.parse(raw);
    if (data.error) {
      throw new EngramError(data.error);
    }
  }

  /**
   * Retrieve a named secret. The encrypted blob is fetched from the
   * server and decrypted locally with your vault key.
   *
   * @param name - Secret name to retrieve
   * @returns The plaintext secret value, or null if not found
   */
  async get(name: string): Promise<string | null> {
    const raw = await this.transport.callTool("vault_get", { name });
    const data = JSON.parse(raw);

    if (data.error) {
      return null;
    }

    const key = await importKey(this.vaultConfig.encryptionKey);
    return decrypt(key, data.encrypted_value, data.iv);
  }

  /**
   * List all named secrets. Returns names and metadata only —
   * never values or encrypted blobs.
   */
  async list(): Promise<NamedSecretMetadata[]> {
    const raw = await this.transport.callTool("vault_list", {});
    const data = JSON.parse(raw);

    return (data.secrets ?? []).map((s: Record<string, unknown>) => ({
      name: s.name as string,
      secretType: s.secret_type as string,
      createdAt: s.created_at as string,
      updatedAt: s.updated_at as string,
    }));
  }

  /**
   * Delete a named secret permanently. This cannot be undone.
   *
   * @param name - Secret name to delete
   * @returns true if deleted, false if not found
   */
  async delete(name: string): Promise<boolean> {
    const raw = await this.transport.callTool("vault_delete", { name });
    const data = JSON.parse(raw);

    if (data.error) {
      return false;
    }

    return data.deleted === true;
  }
}
