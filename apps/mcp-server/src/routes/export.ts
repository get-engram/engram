import { Hono } from "hono";
import {
  getOrganizationById,
  listConversations,
  getMessagesByConversation,
} from "@getengram/db";
import { loadContent } from "../services/content-store.js";
import { audit } from "../services/audit.js";
import { isExternalOAuthClient } from "../mcp/auth-kind.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const dataExport = new Hono<HonoEnv>();

// GET /api/export — export all user data as JSON (GDPR Art. 20)
dataExport.get("/", async (c) => {
  const auth = c.get("auth");
  const orgId = auth.organizationId;

  // Portability is for the account holder, not for a connected assistant.
  //
  // This endpoint returns every conversation title and every verbatim
  // message body, and it never consulted loadPrivacy — so an app holding
  // only engram:read consent could pull the complete corpus here even with
  // "Share full message bodies" switched OFF, walking straight around the
  // control the dashboard presents as governing exactly that. The toggle's
  // own copy says it controls "what assistants connected over MCP can see".
  // The owner exporting from the dashboard or CLI still gets everything,
  // which is the point of Art. 20.
  if (isExternalOAuthClient(auth)) {
    return c.json(
      {
        error: "forbidden",
        message:
          "Export is available from the Engram dashboard or CLI, not from a connected app.",
      },
      403,
    );
  }

  const org = await getOrganizationById(c.env.DB, orgId);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }

  const raw = org as Record<string, unknown>;

  // Fetch all conversations (paginate internally, max 10k)
  // A Team member's seat key must not export other seats' private
  // conversations. Owner keys have seatId null and still get everything.
  const convResult = await listConversations(c.env.DB, orgId, {
    limit: 10000,
    offset: 0,
    sort: "created_at",
    order: "asc",
    ...(auth.seatId ? { viewerSeatId: auth.seatId, filterVisibility: true } : {}),
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
        content: await loadContent(c.env, {
          id: m.id as string,
          content: m.content as string,
          content_encoding: m.content_encoding as string | null,
        }),
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

  await audit(c.env.DB, orgId, auth.apiKeyId, "data.export", undefined, undefined, {
    conversations: conversations.length,
  });

  c.header("Content-Disposition", `attachment; filename="engram-export-${orgId}.json"`);
  return c.json(exportData);
});

export { dataExport };
