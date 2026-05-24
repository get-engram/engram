/**
 * Client-side secrets vault: detect, encrypt, and tokenize secrets
 * before they leave the client. Zero-knowledge — the server never
 * sees plaintext secrets.
 *
 * Uses Web Crypto API (AES-256-GCM) — works in Node 18+, browsers,
 * and Cloudflare Workers.
 */

// ── Types ──

export interface VaultConfig {
  /** Base64-encoded AES-256 key (32 bytes → 44 base64 chars) */
  encryptionKey: string;
}

export interface VaultEntry {
  id: string;
  encrypted_value: string;
  iv: string;
  secret_type: string;
}

export interface ProcessedContent {
  content: string;
  vaultEntries: VaultEntry[];
}

// ── Secret Detection (self-contained — mirrors server-side patterns) ──

type SecretType =
  | "private_key"
  | "api_key"
  | "jwt"
  | "connection_string"
  | "secret_assignment"
  | "ssn"
  | "credit_card"
  | "email"
  | "phone"
  | "token";

interface DetectedSecret {
  type: SecretType;
  value: string;
  start: number;
  end: number;
}

const PATTERNS: Array<[RegExp, SecretType]> = [
  // PEM private keys
  [/-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, "private_key"],
  // Provider API keys
  [/\bsk-[A-Za-z0-9]{20,}\b/g, "api_key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "api_key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "api_key"],
  [/\bASIA[0-9A-Z]{16}\b/g, "api_key"],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, "api_key"],
  [/\b[rs]k_(test|live)_[A-Za-z0-9]{10,}\b/g, "api_key"],
  [/\bcfk_[A-Za-z0-9]{30,}\b/g, "api_key"],
  [/\bsbp_[A-Za-z0-9]{30,}\b/g, "api_key"],
  [/\bxox[bpras]-[A-Za-z0-9-]{10,}\b/g, "api_key"],
  [/\bnpm_[A-Za-z0-9]{30,}\b/g, "api_key"],
  [/\bSG\.[A-Za-z0-9_-]{22,}\.[A-Za-z0-9_-]{22,}\b/g, "api_key"],
  [/\bSK[0-9a-fA-F]{32}\b/g, "api_key"],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "api_key"],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "jwt"],
  // Connection strings
  [/\b(postgres|postgresql|mysql|redis|rediss|mongodb|mongodb\+srv|amqp|amqps):\/\/[^\s"'`]+/gi, "connection_string"],
  // Secret assignments
  [/\b\w*(password|passwd|secret|token|api_key|apikey|api[-_]?secret|private[-_]?key|access[-_]?key|auth[-_]?token|client[-_]?secret|signing[-_]?key|encryption[-_]?key|jwt[-_]?secret)\s*[:=]\s*["']?[^\s"']{8,}["']?/gi, "secret_assignment"],
  // PII
  [/\b\d{3}-\d{2}-\d{4}\b/g, "ssn"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "credit_card"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}\b/gi, "email"],
  [/(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "phone"],
  // Generic high-entropy tokens (last)
  [/\b[0-9a-fA-F]{32,}\b/g, "token"],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "token"],
];

function detectSecrets(input: string): DetectedSecret[] {
  const matches: DetectedSecret[] = [];

  for (const [pattern, type] of PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      matches.push({
        type,
        value: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const deduped: DetectedSecret[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }

  return deduped;
}

// ── Crypto Helpers (AES-256-GCM via Web Crypto API) ──

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

function generateVaultId(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(21));
  let id = "vlt_";
  for (let i = 0; i < bytes.length; i++) id += chars[bytes[i] % chars.length];
  return id;
}

// ── Public API ──

/**
 * Generate a new AES-256 vault encryption key.
 * Returns a base64-encoded 32-byte key. Store this securely —
 * Engram never sees it.
 */
export async function generateVaultKey(): Promise<string> {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return bytesToBase64(key);
}

/**
 * Scan message content for secrets, encrypt each one client-side,
 * and replace with vault reference tokens. Returns modified content
 * and the encrypted vault entries to send alongside the message.
 */
export async function processContent(
  content: string,
  config: VaultConfig
): Promise<ProcessedContent> {
  const secrets = detectSecrets(content);
  if (secrets.length === 0) {
    return { content, vaultEntries: [] };
  }

  const key = await importKey(config.encryptionKey);
  const entries: VaultEntry[] = [];

  // Replace from end → start so indices stay valid
  let result = content;
  for (let i = secrets.length - 1; i >= 0; i--) {
    const secret = secrets[i];
    const vaultId = generateVaultId();
    const { encrypted, iv } = await encrypt(key, secret.value);

    entries.push({
      id: vaultId,
      encrypted_value: encrypted,
      iv,
      secret_type: secret.type,
    });

    result =
      result.slice(0, secret.start) +
      `[VAULT:${vaultId}]` +
      result.slice(secret.end);
  }

  // Entries were pushed in reverse order — fix for consistency
  entries.reverse();

  return { content: result, vaultEntries: entries };
}

/**
 * Decrypt vault entries returned by the server and resolve
 * vault tokens in message content back to plaintext secrets.
 */
export async function resolveContent(
  content: string,
  vaultEntries: Array<{
    id: string;
    encrypted_value: string;
    iv: string;
  }>,
  config: VaultConfig
): Promise<string> {
  if (vaultEntries.length === 0) return content;

  const key = await importKey(config.encryptionKey);
  const resolved = new Map<string, string>();

  await Promise.all(
    vaultEntries.map(async (entry) => {
      const plaintext = await decrypt(key, entry.encrypted_value, entry.iv);
      resolved.set(entry.id, plaintext);
    })
  );

  return content.replace(
    /\[VAULT:(vlt_[A-Za-z0-9_-]+)\]/g,
    (full, id: string) => resolved.get(id) ?? full
  );
}
