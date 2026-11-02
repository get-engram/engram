import type { AuthContext } from "../types.js";

/** True when the session is an external app connected via OAuth (not an API key). */
export function isExternalOAuthClient(auth: AuthContext): boolean {
  return typeof auth.apiKeyId === "string" && auth.apiKeyId.startsWith("oauth:");
}

/**
 * True when the caller holds a seat-bound API key — i.e. is a Team member,
 * not the organization owner. Owner keys and OAuth connections carry a null
 * seatId (engram#264), so "no seat" is the owner floor used by every
 * owner-only guard (engram#441).
 */
export function isSeatMember(auth: AuthContext): auth is AuthContext & { seatId: string } {
  return typeof auth.seatId === "string" && auth.seatId.length > 0;
}
