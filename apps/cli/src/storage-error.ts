/**
 * Shared parsing for the server's `storage_full` response.
 *
 * Lives outside `commands/` because both the `import` command and the sync
 * daemon need it, and the daemon's bootstrap is deliberately import-light —
 * it must not pull the import command's dependency tree in just to read a
 * four-field JSON body.
 */

export interface StorageFullError {
  message: string;
  used?: number;
  limit?: number;
  upgrade_url?: string;
}

/**
 * Parse an SDK error message as the server's `storage_full` payload.
 *
 * The MCP tool returns it as an isError JSON body, which the SDK surfaces
 * verbatim as the Error message (see EngramError in packages/sdk). Returns
 * null for anything else, including other 402s such as `limit_exceeded`.
 */
export function parseStorageFullError(raw: string): StorageFullError | null {
  try {
    const parsed = JSON.parse(raw) as {
      error?: string;
      message?: string;
      used?: number;
      limit?: number;
      upgrade_url?: string;
    };
    if (parsed?.error !== "storage_full") return null;
    return {
      message: parsed.message || "Engram's memory is full.",
      used: parsed.used,
      limit: parsed.limit,
      upgrade_url: parsed.upgrade_url,
    };
  } catch {
    return null;
  }
}
