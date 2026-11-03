import type { Context } from "hono";
import { hasScope } from "../mcp/scopes.js";
import { isExternalOAuthClient, isSeatMember } from "../mcp/auth-kind.js";
import type { Env, AuthContext } from "../types.js";

type Ctx = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

/**
 * Owner-only floor (engram#441). Returns a 403 for a Team member's seat key,
 * null for the organization owner. Until `seats.role` is plumbed into
 * AuthContext this is deliberately coarse: a member can read and write
 * memory, but cannot touch the org's credentials, billing, or privacy policy.
 */
export function denyUnlessOwner(c: Ctx, message: string): Response | null {
  const auth = c.get("auth");
  if (isSeatMember(auth)) {
    return c.json({ error: "forbidden", message }, 403);
  }
  return null;
}

/**
 * First-party + write-level gate, shared by the account-settings surfaces.
 * An OAuth connector (ChatGPT, Claude, …) is never allowed to change org
 * settings, and a read-only key cannot either.
 */
export function denyUnlessFirstPartyWrite(c: Ctx, message: string): Response | null {
  const auth = c.get("auth");
  if (isExternalOAuthClient(auth)) {
    return c.json({ error: "forbidden", message }, 403);
  }
  if (!hasScope(auth, "write")) {
    return c.json(
      { error: "insufficient_scope", message: "This action requires the 'write' scope." },
      403,
    );
  }
  return null;
}
