import type { AuthContext, Scope } from "../types.js";

// A key carries a subset of scopes; each memory tool requires one.
// Legacy/OAuth callers get all four. (engram#69)
export type { Scope };
export const ALL_SCOPES: Scope[] = ["read", "write", "search", "delete"];

export function isScope(value: string): value is Scope {
  return (ALL_SCOPES as string[]).includes(value);
}

/** Parse a stored comma-separated scope string into a validated array. */
export function parseScopes(raw: string | null | undefined): Scope[] {
  if (!raw) return [...ALL_SCOPES];
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Scope => isScope(s));
  // An empty/garbled value shouldn't lock a caller out of everything silently;
  // treat it as full access (matches the column default).
  return parsed.length > 0 ? parsed : [...ALL_SCOPES];
}

export function hasScope(auth: AuthContext, scope: Scope): boolean {
  return auth.scopes.includes(scope);
}

/**
 * Map an OAuth token's stored scope string to internal scopes.
 *
 * The OAuth vocabulary is only `engram:read` and `engram:write` (metadata.ts
 * OAUTH_SCOPES), and that's what the consent screen shows the user. But auth
 * used to grant every OAuth token the full internal set [read, write, search,
 * delete] — so a read-only consent silently permitted writes AND deletes, and
 * NO connector's consent ever mentioned deletion at all. This maps the granted
 * OAuth scopes to internal ones and, deliberately, never grants `delete`:
 * destroying memory is not in the vocabulary a connector was authorized for
 * (users delete via the dashboard or an API key instead).
 *
 * `engram:read` implies both read and search (reading your memory is
 * searching it). A legacy/garbled scope maps to read+search+write — the prior
 * behavior minus the delete over-grant — so existing connectors keep working
 * rather than being locked out.
 */
export function oauthScopeToInternal(scope: string | null | undefined): Scope[] {
  const tokens = (scope ?? "").split(/[\s,]+/).filter(Boolean);
  const out = new Set<Scope>();
  for (const t of tokens) {
    if (t === "engram:read") {
      out.add("read");
      out.add("search");
    } else if (t === "engram:write") {
      out.add("write");
    }
    // Any other token (including a hypothetical delete scope) is ignored.
  }
  if (out.size === 0) return ["read", "search", "write"];
  return [...out];
}

/** Standard MCP error result when a key lacks a required scope. */
export function scopeError(scope: Scope) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: "insufficient_scope",
          required: scope,
          message: `This API key does not have the '${scope}' permission. Create a key with this scope at getengram.app/dashboard.`,
        }),
      },
    ],
    isError: true as const,
  };
}
