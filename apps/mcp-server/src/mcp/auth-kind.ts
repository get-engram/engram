import type { AuthContext } from "../types.js";

/** True when the session is an external app connected via OAuth (not an API key). */
export function isExternalOAuthClient(auth: AuthContext): boolean {
  return typeof auth.apiKeyId === "string" && auth.apiKeyId.startsWith("oauth:");
}
