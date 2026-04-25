import { Hono } from "hono";
import {
  getOrganizationById,
  listConversations,
  getMessagesByConversation,
} from "@getengram/db";
import { decompressContent } from "../utils/compress.js";
import { audit } from "../services/audit.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const dataExport = new Hono<HonoEnv>();

// GET /api/export — export all user data as JSON (GDPR Art. 20)
dataExport.get("/", async (c) => {
  const auth = c.get("auth");
  const orgId = auth.organizationId;

  const org = await getOrganizationById(c.env.DB, orgId);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const raw = org as Record<string, unknown>;

  // Fetch all conversations (paginate internally, max 10k)
  const convResult = await listConversations(c.env.DB, orgId, {
    limit: 10000,
    offset: 0,
    sort: "created_at",
    order: "asc",
  });

  const conversations = [];
  for (const rawConv of convResult.results as Array<Record<string, unknown>>) {
    // Fetch all messages for this conversation
    const msgResult = await getMessagesByConversation(
      c.env.DB,
      rawConv.id as string,
      orgId,
      100000, // high limit to get all
      0,
    );

    const messages = await Promise.all(
      (msgResult.results as Array<Record<string, unknown>>).map(async (m) => ({
        role: m.role,
        content: await decompressContent(
          m.content as string,
          m.content_encoding as string | null,
        ),
        sequence: m.sequence,
        created_at: m.created_at,
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      })),
    );

    conversations.push({
      id: rawConv.id,
      title: rawConv.title,
      agent_id: rawConv.agent_id,
      tags: JSON.parse((rawConv.tags as string) || "[]"),
      metadata: JSON.parse((rawConv.metadata as string) || "{}"),
      message_count: rawConv.message_count,
      created_at: rawConv.created_at,
      updated_at: rawConv.updated_at,
      messages,
    });
  }

  const exportData = {
    export_version: "1.0",
    exported_at: new Date().toISOString(),
    organization: {
      id: raw.id,
      name: raw.name,
      email: raw.email,
      tier: raw.tier,
      created_at: raw.created_at,
    },
    conversations,
  };

  audit(c.env.DB, orgId, auth.apiKeyId, "data.export", null, null, {
    conversations: conversations.length,
  });

  c.header("Content-Disposition", `attachment; filename="engram-export-${orgId}.json"`);
  return c.json(exportData);
});

export { dataExport };
