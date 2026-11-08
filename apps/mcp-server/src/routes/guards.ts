import type { Context } from "hono";
import { ALL_SCOPES, hasScope } from "../mcp/scopes.js";
import { isExternalOAuthClient, isSeatMember } from "../mcp/auth-kind.js";
import type { Env, AuthContext, Scope } from "../types.js";

/** The context every authenticated /api/* route handler receives. */
export type GuardContext = Context<{ Bindings: Env; Variables: { auth: AuthContext } }>;

/**
 * Owner-only floor (engram#441). Returns a 403 for a Team member's seat key,
 * null for the organization owner. Until `seats.role` is plumbed into
 * AuthContext this is deliberately coarse: a member can read and write
 * memory, but cannot touch the org's credentials, billing, or privacy policy.
 */
export function denyUnlessOwner(c: GuardContext, message: string): Response | null {
  const auth = c.get("auth");
  if (isSeatMember(auth)) {
    return c.json({ error: "forbidden", message }, 403);
  }
  return null;
}

/**
 * First-party floor (engram#603). A connected OAuth app (ChatGPT, Claude, …)
 * was granted access to memory, never to the account around it: it does not
 * manage the org's integrations, members, or connections.
 */
export function denyExternalOAuthClient(c: GuardContext, message: string): Response | null {
  const auth = c.get("auth");
  if (isExternalOAuthClient(auth)) {
    return c.json({ error: "forbidden", message }, 403);
  }
  return null;
}

/**
 * Scope floor for the REST routes outside /api/v1 (engram#603): the same
 * check, and the same 403 body, as /api/v1 and the MCP tools, so a key
 * minted with only `read` cannot write through a route that forgot to ask.
 */
export function denyUnlessScope(c: GuardContext, scope: Scope): Response | null {
  const auth = c.get("auth");
  if (hasScope(auth, scope)) return null;
  return c.json(
    {
      error: "insufficient_scope",
      required: scope,
      message: `This API key does not have the '${scope}' permission. Create a key with this scope at getengram.app/dashboard.`,
    },
    403,
  );
}

/**
 * First-party + write-level gate, shared by the account-settings surfaces.
 * An OAuth connector (ChatGPT, Claude, …) is never allowed to change org
 * settings, and a read-only key cannot either.
 */
export function denyUnlessFirstPartyWrite(c: GuardContext, message: string): Response | null {
  const denied = denyExternalOAuthClient(c, message);
  if (denied) return denied;
  const auth = c.get("auth");
  if (!hasScope(auth, "write")) {
    return c.json(
      { error: "insufficient_scope", required: "write", message: "This action requires the 'write' scope." },
      403,
    );
  }
  return null;
}

/**
 * Full-authority floor (engram#603), for an action whose result is a
 * credential carrying every scope: a seat invitation, once accepted, mints a
 * seat key with all four. First-party, the owner, and holding every scope
 * itself, so a narrower key cannot hand out more than it holds: the rule
 * mintableScopes (engram#475) applies to POST /api/keys, applied to the keys
 * minted on an invitee's behalf.
 */
export function denyUnlessFullAuthority(
  c: GuardContext,
  messages: { connector: string; member: string },
): Response | null {
  const denied =
    denyExternalOAuthClient(c, messages.connector) ?? denyUnlessOwner(c, messages.member);
  if (denied) return denied;
  for (const scope of ALL_SCOPES) {
    const missing = denyUnlessScope(c, scope);
    if (missing) return missing;
  }
  return null;
}
