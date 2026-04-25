import { Hono } from "hono";
import {
  getOrganizationById,
  getVectorizeIdsByOrganization,
  deleteOrganizationById,
  getOrganizationStats,
} from "@getengram/db";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const account = new Hono<HonoEnv>();

// DELETE /api/account — delete the authenticated user's organization and all data
account.delete("/", async (c) => {
  const auth = c.get("auth");
  const orgId = auth.organizationId;

  // Verify org exists
  const org = await getOrganizationById(c.env.DB, orgId);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  // Gather stats before deletion (for the response)
  const stats = await getOrganizationStats(c.env.DB, orgId);

  // Get all vectorize IDs before D1 deletion
  const vectorResult = await getVectorizeIdsByOrganization(c.env.DB, orgId);
  const vectorizeIds = vectorResult.results.map((r) => r.vectorize_id);

  // Delete from Vectorize first (external service — fail before D1 if it errors)
  if (vectorizeIds.length > 0) {
    // Vectorize deleteByIds has a max batch size; chunk into groups of 1000
    for (let i = 0; i < vectorizeIds.length; i += 1000) {
      const batch = vectorizeIds.slice(i, i + 1000);
      await c.env.VECTORIZE.deleteByIds(batch);
    }
  }

  // Delete from D1 (FTS → chunks → messages → conversations → org)
  await deleteOrganizationById(c.env.DB, orgId);

  return c.json({
    deleted: true,
    organization_id: orgId,
    deleted_records: {
      conversations: stats?.conversations ?? 0,
      messages: stats?.messages ?? 0,
      chunks: stats?.chunks ?? 0,
      vectors: vectorizeIds.length,
    },
  });
});

export { account };
