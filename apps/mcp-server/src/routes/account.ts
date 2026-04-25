import { Hono } from "hono";
import {
  getOrganizationById,
  getOrganizationStats,
  softDeleteOrganization,
  restoreOrganization,
} from "@getengram/db";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const account = new Hono<HonoEnv>();

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
  audit(c.env.DB, orgId, auth.apiKeyId, "account.delete");

  return c.json({
    deleted: true,
    organization_id: orgId,
    grace_period_days: 30,
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
  audit(c.env.DB, orgId, auth.apiKeyId, "account.restore");

  return c.json({
    restored: true,
    organization_id: orgId,
  });
});

export { account };
