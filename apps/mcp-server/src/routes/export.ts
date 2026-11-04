import { Hono } from "hono";
import {
  getOrganizationById,
  listConversationsAfterId,
  countConversations,
  getMessagesByConversation,
} from "@getengram/db";
import { loadContent } from "../services/content-store.js";
import { audit } from "../services/audit.js";
import { isExternalOAuthClient } from "../mcp/auth-kind.js";
import { mapConcurrent } from "../utils/map-concurrent.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const dataExport = new Hono<HonoEnv>();

/**
 * Messages per page. One request has ~1000 subrequests and roughly a
 * minute of wall clock on Workers; every R2 body is a subrequest and every
 * conversation visited is a D1 query, so a page of 400 messages stays
 * comfortably inside both even when all 400 are single-message
 * conversations (400 + 8 + 400 subrequests).
 */
export const EXPORT_PAGE_MAX = 400;
export const EXPORT_PAGE_DEFAULT = 400;
/** Conversations fetched per listing query while walking a page. */
const CONVERSATION_BATCH = 50;
/** Concurrent R2 body loads. */
const LOAD_CONCURRENCY = 25;

/**
 * Where to resume. `messageOffset` 0 means "the conversations after
 * `conversationId`"; a positive offset means "conversation `conversationId`
 * itself, from that message onwards" — a conversation larger than a page
 * (the biggest holds 600k+ messages) spans several pages.
 */
interface ExportCursor {
  conversationId: string | null;
  messageOffset: number;
}

export function encodeCursor(cursor: ExportCursor): string {
  return `${cursor.conversationId ?? ""}:${cursor.messageOffset}`;
}

export function decodeCursor(raw: string | undefined): ExportCursor | null {
  if (raw === undefined || raw === "") return { conversationId: null, messageOffset: 0 };
  const at = raw.lastIndexOf(":");
  if (at === -1) return null;
  const id = raw.slice(0, at);
  const off = Number(raw.slice(at + 1));
  if (!Number.isInteger(off) || off < 0) return null;
  if (id === "" && off !== 0) return null;
  return { conversationId: id === "" ? null : id, messageOffset: off };
}

// GET /api/export and GET /api/v1/export — the account's data as JSON
// (GDPR Art. 20), one page per request.
//
// Version 1.0 returned everything in one response. Workers cancel a request
// after about a minute and allow ~1000 subrequests, and an account can hold
// tens of thousands of conversations with hundreds of thousands of messages
// in one of them, so for anything but a small account that response never
// arrived (engram#546). Version 1.1 pages: `limit` messages per page, an
// opaque `cursor` to continue, `next_cursor` null when the export is done.
// Clients concatenate the `conversations` arrays; a conversation that spans
// pages repeats its header with the `message_offset` its slice starts at.
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

  const cursor = decodeCursor(c.req.query("cursor"));
  if (!cursor) {
    return c.json(
      { error: "invalid_cursor", message: "cursor must be a value returned as next_cursor" },
      400,
    );
  }
  const rawLimit = c.req.query("limit");
  let limit = EXPORT_PAGE_DEFAULT;
  if (rawLimit !== undefined) {
    limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > EXPORT_PAGE_MAX) {
      return c.json(
        { error: "invalid_limit", message: `limit must be an integer from 1 to ${EXPORT_PAGE_MAX}` },
        400,
      );
    }
  }

  const org = await getOrganizationById(c.env.DB, orgId);
  if (!org) {
    return c.json({ error: "Organization not found" }, 404);
  }
  const raw = org as Record<string, unknown>;

  // A Team member's seat key must not export other seats' private
  // conversations. Owner keys have seatId null and still get everything.
  const visibility = auth.seatId
    ? { viewerSeatId: auth.seatId, filterVisibility: true as const }
    : {};

  const conversations: Array<Record<string, unknown>> = [];
  let budget = limit;
  let messagesOut = 0;
  let position: ExportCursor = cursor;
  let done = false;

  walk: while (budget > 0) {
    const batch = await listConversationsAfterId(
      c.env.DB,
      orgId,
      position.conversationId,
      CONVERSATION_BATCH,
      { ...visibility, inclusive: position.messageOffset > 0 },
    );
    const rows = batch.results as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      done = true;
      break;
    }

    for (const conv of rows) {
      if (budget <= 0) break walk;
      const convId = conv.id as string;
      // Only the conversation the cursor names resumes mid-way; every later
      // one starts at its first message.
      const offset = convId === position.conversationId ? position.messageOffset : 0;

      const msgResult = await getMessagesByConversation(c.env.DB, convId, orgId, budget, offset);
      const msgRows = msgResult.results as Array<Record<string, unknown>>;

      if (msgRows.length === 0 && offset > 0) {
        // The previous page ended exactly at this conversation's last
        // message; nothing left to emit for it.
        position = { conversationId: convId, messageOffset: 0 };
        continue;
      }

      const messages = await mapConcurrent(msgRows, LOAD_CONCURRENCY, async (m) => ({
        role: m.role,
        content: await loadContent(c.env, {
          id: m.id as string,
          content: m.content as string,
          content_encoding: m.content_encoding as string | null,
        }),
        sequence: m.sequence,
        created_at: m.created_at,
        ...(m.tool_name ? { tool_name: m.tool_name } : {}),
      }));

      conversations.push({
        id: convId,
        title: conv.title,
        agent_id: conv.agent_id,
        tags: JSON.parse((conv.tags as string) || "[]"),
        metadata: JSON.parse((conv.metadata as string) || "{}"),
        message_count: conv.message_count,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        message_offset: offset,
        messages,
      });
      messagesOut += msgRows.length;

      if (msgRows.length < budget) {
        // Fewer rows than asked for: this conversation is finished. An empty
        // conversation still costs one unit so a page of them stays bounded.
        budget -= Math.max(msgRows.length, 1);
        position = { conversationId: convId, messageOffset: 0 };
      } else {
        // The page filled up inside this conversation; resume here.
        budget = 0;
        position = { conversationId: convId, messageOffset: offset + msgRows.length };
        break walk;
      }
    }

    if (rows.length < CONVERSATION_BATCH && budget > 0) {
      done = true;
      break;
    }
  }

  const total = await countConversations(c.env.DB, orgId, visibility);

  const exportData = {
    export_version: "1.1",
    exported_at: new Date().toISOString(),
    organization: {
      id: raw.id,
      name: raw.name,
      email: raw.email,
      tier: raw.tier,
      created_at: raw.created_at,
    },
    total_conversations: total?.count ?? 0,
    page: { cursor: c.req.query("cursor") ?? null, limit },
    next_cursor: done ? null : encodeCursor(position),
    conversations,
  };

  await audit(c.env.DB, orgId, auth.apiKeyId, "data.export", undefined, undefined, {
    cursor: c.req.query("cursor") ?? null,
    conversations: conversations.length,
    messages: messagesOut,
    complete: done,
  });

  c.header("Content-Disposition", `attachment; filename="engram-export-${orgId}.json"`);
  return c.json(exportData);
});

export { dataExport };
