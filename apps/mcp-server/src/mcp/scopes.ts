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
