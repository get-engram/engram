import { Hono } from "hono";
import {
  getOrganizationById,
  getOrganizationStats,
  softDeleteOrganization,
  restoreOrganization,
  setOrganizationEmail,
} from "@getengram/db";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const account = new Hono<HonoEnv>();

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
  const auth = c.get("auth");
  const orgId = auth.organizationId;
  const body = await c.req.json<{ email?: string }>().catch(() => ({}));
  const email = (body as { email?: string }).email?.trim();

  if (!email || !email.includes("@")) {
    return c.json({ error: "invalid_email", message: "A valid email is required" }, 400);
  }

  await setOrganizationEmail(c.env.DB, orgId, email);
  await audit(c.env.DB, orgId, auth.apiKeyId, "account.update_email");

  return c.json({ updated: true, email });
});

// DELETE /api/account — soft-delete the organization (30-day grace period)
account.delete("/", async (c) => {
  const auth = c.get("auth");
  const orgId = auth.organizationId;

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
  const auth = c.get("auth");
  const orgId = auth.organizationId;

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
