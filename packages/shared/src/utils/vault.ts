/**
 * Vault token format and parsing utilities.
 * Shared between SDK (client-side) and server (storage).
 */

/** Regex to find vault reference tokens in message content */
export const VAULT_TOKEN_REGEX = /\[VAULT:(vlt_[A-Za-z0-9_-]+)\]/g;

/** Build a vault reference token string from a vault entry ID */
export function createVaultToken(vaultId: string): string {
  return `[VAULT:${vaultId}]`;
}

/** Extract all vault entry IDs from text containing vault tokens */
export function extractVaultIds(text: string): string[] {
  const re = new RegExp(VAULT_TOKEN_REGEX.source, VAULT_TOKEN_REGEX.flags);
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

/** Replace vault tokens in text using a lookup map of id → plaintext */
export function replaceVaultTokens(
  text: string,
  resolved: Map<string, string>
): string {
  return text.replace(VAULT_TOKEN_REGEX, (full, id: string) => {
    return resolved.get(id) ?? full;
  });
}
