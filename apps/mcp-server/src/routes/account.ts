import { Hono } from "hono";
import {
  getOrganizationById,
  getOrganizationByEmail,
  getOrganizationStats,
  softDeleteOrganization,
  restoreOrganization,
  setOrganizationEmail,
} from "@getengram/db";
import { audit } from "../services/audit.js";
import { hasScope } from "../mcp/scopes.js";
import { isExternalOAuthClient } from "../mcp/auth-kind.js";
import type { Context } from "hono";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const account = new Hono<HonoEnv>();

/**
 * Account lifecycle and identity are first-party, write-level acts.
 *
 * These handlers used to check only `auth.seatId` (owner vs Team member),
 * which let two credentials through that must never reach them:
 *   - a key minted with scopes=["read"]. Proved live 2026-10-11: a read-only
 *     key was refused by POST /api/keys and then successfully soft-deleted
 *     its own organization, scheduling every conversation, message, chunk
 *     and vector for permanent purge.
 *   - an OAuth connector token. A connected app's consent vocabulary is
 *     engram:read / engram:write; neither word means "destroy this account"
 *     or "change the address that owns it", so a prompt-injected assistant
 *     holding read-only consent could do both.
 *
 * PATCH is the sharper of the two: organizations.email is the identity
 * anchor that /signup, /signup/login and the #480 claim link all resolve
 * against, so re-pointing it is an account-takeover primitive, not a
 * profile edit.
 *
 * GET stays open to read-only callers — it is the key-validation "whoami".
 */
function denyUnlessFirstPartyWrite(c: Context<HonoEnv>): Response | null {
  const auth = c.get("auth");
  if (isExternalOAuthClient(auth)) {
    return c.json(
      {
        error: "forbidden",
        message:
          "Account settings are managed from the Engram dashboard or CLI, not from a connected app.",
      },
      403,
    );
  }
  if (!hasScope(auth, "write")) {
    return c.json(
      { error: "insufficient_scope", message: "This action requires the 'write' scope." },
      403,
    );
  }
  return null;
}

const GRACE_PERIOD_DAYS = 30;

/** When the purge cron will hard-delete a soft-deleted org, as an ISO string.
 *  D1 stores datetimes as "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker,
 *  so the T/Z are added before parsing — without them this parses as local
 *  time and the deadline shown to the user drifts by the offset. */
function purgeAt(deletedAt: string): string {
  const ms = Date.parse(`${deletedAt.replace(" ", "T")}Z`);
  return new Date(ms + GRACE_PERIOD_DAYS * 86400_000).toISOString();
}

// GET /api/account — "whoami" for the authenticated key. Lets the web app
// validate an API key and build a session from it (key-only login for CLI
// users), and decide whether to prompt for an email.
account.get("/", async (c) => {
  const auth = c.get("auth");
  const org = (await getOrganizationById(c.env.DB, auth.organizationId)) as
    | { id: string; email: string | null; name: string | null; deleted_at: string | null }
    | null;
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }
  // A soft-deleted org still authenticates on purpose — that is what keeps
  // POST /api/account/restore reachable during the grace period. Reporting
  // deleted_at here is what lets a client show the pending deletion and the
  // undo path after a reload, instead of only in the tab that requested it.
  return c.json({
    org_id: auth.organizationId,
    email: org.email ?? null,
    name: org.name ?? null,
    tier: auth.tier,
    deleted_at: org.deleted_at ?? null,
    purge_at: org.deleted_at ? purgeAt(org.deleted_at) : null,
  });
});

// PATCH /api/account — update organization settings (email)
account.patch("/", async (c) => {
  const denied = denyUnlessFirstPartyWrite(c);
  if (denied) return denied;

  const auth = c.get("auth");
  const orgId = auth.organizationId;
  // Owner-only: a Team member's seat key must not re-point the address the
  // whole organization is identified by.
  if (auth.seatId) {
    return c.json(
      { error: "forbidden", message: "Only the organization owner can change the account email." },
      403,
    );
  }
  const body = await c.req.json<{ email?: string }>().catch(() => ({}));
  const email = (body as { email?: string }).email?.trim();

  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email", message: "A valid email is required" }, 400);
  }

  // Same collision rule POST /signup/link already enforces: one address maps
  // to one org, or the email-keyed lookups behind sign-in and the claim link
  // become ambiguous.
  const clash = (await getOrganizationByEmail(c.env.DB, email)) as { id: string } | null;
  if (clash && clash.id !== orgId) {
    return c.json(
      { error: "email_taken", message: "This email is already linked to another account" },
      409,
    );
  }

  const before = (await getOrganizationById(c.env.DB, orgId)) as { email: string | null } | null;
  await setOrganizationEmail(c.env.DB, orgId, email);
  // Record old and new: an unexplained email change is the signature of a
  // takeover, and the Oct 2026 lockout had to be reconstructed without one.
  await audit(c.env.DB, orgId, auth.apiKeyId, "account.update_email", "organization", orgId, {
    from: before?.email ?? null,
    to: email,
  });

  return c.json({ updated: true, email });
});

// DELETE /api/account — soft-delete the organization (30-day grace period)
account.delete("/", async (c) => {
  const denied = denyUnlessFirstPartyWrite(c);
  if (denied) return denied;

  const auth = c.get("auth");
  const orgId = auth.organizationId;

  // Owner-only. A seat-bound (Team member) key must not be able to delete the
  // whole organization. seatId is null for owner keys and set for member keys
  // (engram#264). The `seats.role` column exists for finer RBAC but is not yet
  // plumbed into auth; until it is, owner-vs-seat is the enforceable boundary,
  // and it is the one that matters for a destructive org-level action.
  if (auth.seatId) {
    return c.json(
      { error: "forbidden", message: "Only the organization owner can delete the account." },
      403,
    );
  }

  const org = await getOrganizationById(c.env.DB, orgId);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const stats = await getOrganizationStats(c.env.DB, orgId);

  // Soft-delete: set deleted_at timestamp. Data is purged after 30 days by cron.
  await softDeleteOrganization(c.env.DB, orgId);
  await audit(c.env.DB, orgId, auth.apiKeyId, "account.delete");

  return c.json({
    deleted: true,
    organization_id: orgId,
    grace_period_days: GRACE_PERIOD_DAYS,
    message: "Account scheduled for deletion. Data will be permanently removed after 30 days. Call POST /api/account/restore to undo.",
    affected_records: {
      conversations: stats?.conversations ?? 0,
      messages: stats?.messages ?? 0,
      chunks: stats?.chunks ?? 0,
    },
  });
});

// POST /api/account/restore — undo soft-delete within 30-day window
account.post("/restore", async (c) => {
  const denied = denyUnlessFirstPartyWrite(c);
  if (denied) return denied;

  const auth = c.get("auth");
  const orgId = auth.organizationId;

  // Owner-only, same as delete — a member key must not control the org lifecycle.
  if (auth.seatId) {
    return c.json(
      { error: "forbidden", message: "Only the organization owner can restore the account." },
      403,
    );
  }

  const org = (await getOrganizationById(c.env.DB, orgId)) as Record<string, unknown> | null;
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  if (!org.deleted_at) {
    return c.json({ error: "Account is not marked for deletion" }, 400);
  }

  await restoreOrganization(c.env.DB, orgId);
  await audit(c.env.DB, orgId, auth.apiKeyId, "account.restore");

  return c.json({
    restored: true,
    organization_id: orgId,
  });
});

export { account };
