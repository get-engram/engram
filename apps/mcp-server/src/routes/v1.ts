import { Hono } from "hono";
import { z } from "zod";
import {
  listConversations as dbListConversations,
  getOrgConversationCount,
} from "@getengram/db";
import {
  createConversation,
  getConversation,
  deleteConversation,
  appendMessages,
  getOrCreateDefaultConversation,
} from "../services/conversation.js";
import {
  checkConversationLimit,
  checkAndTrackMessages,
  checkAndTrackStorage,
  releaseStorage,
  trackSearchRun,
} from "../services/tier.js";
import { searchConversations } from "../services/search.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE,
} from "../services/privacy.js";
import { fireWebhooks } from "../services/webhooks.js";
import { audit } from "../services/audit.js";
import { hasScope, type Scope } from "../mcp/scopes.js";
import { usageMeter } from "../mcp/usage-messaging.js";
import type { Env, AuthContext } from "../types.js";
import type { Context } from "hono";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

/**
 * Public REST API (engram#287) — the pricing page promises "MCP + REST
 * API", so the six MCP memory tools are mirrored here 1:1 for callers
 * that can't (or don't want to) drive the MCP protocol: backends, cron
 * jobs, curl. Same services, same scope checks, same storage/monthly
 * gates, same privacy settings, same audit + webhooks — different
 * transport. Versioned under /api/v1 so the shape can evolve without
 * breaking the account-management routes that live at /api/*.
 */
export const v1 = new Hono<HonoEnv>();

function scopeError(c: Context<HonoEnv>, scope: Scope) {
  return c.json(
    {
      error: "insufficient_scope",
      required: scope,
      message: `This API key does not have the '${scope}' permission. Create a key with this scope at getengram.app/dashboard.`,
    },
    403,
  );
}

// ---------------------------------------------------------------------------
// POST /api/v1/conversations — mirror of create_conversation
// ---------------------------------------------------------------------------

const createConversationSchema = z.object({
  title: z.string().optional(),
  agent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

v1.post("/conversations", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "write")) return scopeError(c, "write");

  const parsed = createConversationSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }

  const countResult = await getOrgConversationCount(c.env.DB, auth.organizationId);
  const tierCheck = checkConversationLimit(auth.tier, countResult?.count ?? 0);
  if (!tierCheck.allowed) {
    return c.json(
      {
        error: tierCheck.error,
        limit: tierCheck.limit,
        used: tierCheck.used,
        tier: tierCheck.tier,
        upgrade_url: "https://getengram.app/pricing",
      },
      402,
    );
  }

  const id = await createConversation(
    c.env.DB,
    auth.organizationId,
    parsed.data.title,
    parsed.data.agent_id,
    parsed.data.tags,
    parsed.data.metadata as Record<string, unknown>,
  );

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "conversation.create", "conversation", id, {
    source: "rest",
  });
  fireWebhooks(c.env.DB, auth.organizationId, "conversation.created", {
    conversation_id: id,
    title: parsed.data.title ?? null,
  }).catch(() => {});

  return c.json({ conversation_id: id }, 201);
});

// ---------------------------------------------------------------------------
// GET /api/v1/conversations — mirror of list_conversations
// ---------------------------------------------------------------------------

v1.get("/conversations", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "read")) return scopeError(c, "read");

  const privacy = await loadPrivacy(c.env.DB, auth.organizationId);
  if (!privacy.canReadCrossConversation) {
    return c.json({ conversations: [], total: 0, privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE });
  }

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "20") || 20, 1), 100);
  const offset = Math.max(Number(c.req.query("offset") ?? "0") || 0, 0);
  const sortParam = c.req.query("sort");
  const sort = (["created_at", "updated_at", "message_count"] as const).find(
    (s) => s === sortParam,
  ) ?? "updated_at";
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  const tagsParam = c.req.query("tags");

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "conversation.list", undefined, undefined, {
    source: "rest",
  });

  const result = await dbListConversations(c.env.DB, auth.organizationId, {
    limit,
    offset,
    agentId: c.req.query("agent_id") || undefined,
    tags: tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    sort,
    order,
  });

  const conversations = (result.results as Array<Record<string, unknown>>).map(
    ({ organization_id: _o, ...conv }) => ({
      ...conv,
      tags: JSON.parse((conv.tags as string) || "[]"),
      metadata: JSON.parse((conv.metadata as string) || "{}"),
    }),
  );

  return c.json({ conversations, total: conversations.length });
});

// ---------------------------------------------------------------------------
// GET /api/v1/conversations/:id — mirror of get_conversation
// ---------------------------------------------------------------------------

v1.get("/conversations/:id", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "read")) return scopeError(c, "read");

  const conversationId = c.req.param("id");
  const messageLimit = Math.min(
    Math.max(Number(c.req.query("message_limit") ?? "100") || 100, 1),
    500,
  );
  const messageOffset = Math.max(Number(c.req.query("message_offset") ?? "0") || 0, 0);

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "conversation.read", "conversation", conversationId, {
    source: "rest",
  });

  const result = await getConversation(
    c.env.DB,
    auth.organizationId,
    conversationId,
    messageLimit,
    messageOffset,
  );
  if (!result) return c.json({ error: "conversation_not_found" }, 404);

  // Strip internal fields and honor the org's privacy setting, exactly
  // like the MCP tool.
  const { organization_id: _o, ...conversation } = result.conversation;
  const privacy = await loadPrivacy(c.env.DB, auth.organizationId);
  const messages = result.messages.map((m) => {
    const {
      organization_id: _mo,
      content_encoding: _enc,
      content,
      ...rest
    } = m as typeof m & {
      organization_id?: string;
      content_encoding?: string;
      content?: string;
    };
    return privacy.canReadBodies ? { ...rest, content } : { ...rest, body_hidden: true };
  });

  return c.json(
    privacy.canReadBodies
      ? { conversation, messages }
      : { conversation, messages, privacy_notice: PRIVACY_BODIES_NOTICE },
  );
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/conversations/:id — mirror of delete_conversation
// ---------------------------------------------------------------------------

v1.delete("/conversations/:id", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "delete")) return scopeError(c, "delete");

  const conversationId = c.req.param("id");
  const deleted = await deleteConversation(c.env, auth.organizationId, conversationId);

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "conversation.delete", "conversation", conversationId, {
    source: "rest",
  });

  if (!deleted) return c.json({ error: "conversation_not_found" }, 404);
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// POST /api/v1/messages — mirror of append_messages
// ---------------------------------------------------------------------------

const appendSchema = z.object({
  conversation_id: z.string().optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant", "system", "tool"]),
        content: z.string(),
        tool_call_id: z.string().optional(),
        tool_name: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      }),
    )
    .min(1),
});

v1.post("/messages", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "write")) return scopeError(c, "write");

  const parsed = appendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }
  const count = parsed.data.messages.length;

  // Primary gate: lifetime storage. Atomically reserves space; released
  // below if a later step rejects or fails.
  const storageCheck = await checkAndTrackStorage(c.env.DB, auth.organizationId, auth.tier, count);
  if (!storageCheck.allowed) {
    return c.json(
      {
        error: storageCheck.error,
        limit: storageCheck.limit,
        used: storageCheck.used,
        tier: storageCheck.tier,
        upgrade_url: "https://getengram.app/pricing",
      },
      402,
    );
  }

  // Secondary gate: monthly velocity.
  const tierCheck = await checkAndTrackMessages(c.env.DB, auth.organizationId, auth.tier, count);
  if (!tierCheck.allowed) {
    await releaseStorage(c.env.DB, auth.organizationId, count);
    return c.json(
      {
        error: tierCheck.error,
        limit: tierCheck.limit,
        used: tierCheck.used,
        tier: tierCheck.tier,
        upgrade_url: "https://getengram.app/pricing",
      },
      429,
    );
  }

  const conversationId =
    parsed.data.conversation_id ??
    (await getOrCreateDefaultConversation(c.env.DB, auth.organizationId));

  let messages;
  try {
    messages = await appendMessages(
      c.env,
      auth.organizationId,
      conversationId,
      parsed.data.messages.map((m) => ({
        ...m,
        metadata: m.metadata as Record<string, unknown>,
      })),
    );
  } catch (err) {
    await releaseStorage(c.env.DB, auth.organizationId, count).catch(() => {});
    throw err;
  }

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "messages.append", "conversation", conversationId, {
    count: messages.length,
    source: "rest",
  });
  fireWebhooks(c.env.DB, auth.organizationId, "messages.appended", {
    conversation_id: conversationId,
    message_count: messages.length,
    message_ids: messages.map((m) => m.id),
  }).catch(() => {});

  const meter = usageMeter(tierCheck.used, tierCheck.limit);
  const storageMeter = usageMeter(storageCheck.used, storageCheck.limit);

  return c.json({
    conversation_id: conversationId,
    appended: messages.length,
    message_ids: messages.map((m) => m.id),
    ...(meter ? { usage: meter } : {}),
    ...(storageMeter ? { storage: storageMeter } : {}),
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/search — mirror of search
// ---------------------------------------------------------------------------

v1.get("/search", async (c) => {
  const auth = c.get("auth");
  if (!hasScope(auth, "search")) return scopeError(c, "search");

  const query = c.req.query("q")?.trim();
  if (!query) return c.json({ error: "missing_query" }, 400);
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "5") || 5, 1), 20);
  const conversationId = c.req.query("conversation_id") || undefined;
  const tagsParam = c.req.query("tags");
  const tags = tagsParam ? tagsParam.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const project = c.req.query("project") || undefined;

  const privacy = await loadPrivacy(c.env.DB, auth.organizationId);
  // A search without a conversation_id spans all conversations; honor the
  // org's cross-conversation privacy setting.
  if (!privacy.canReadCrossConversation && !conversationId) {
    return c.json({ results: [], total: 0, privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE });
  }

  const raw = await searchConversations(
    c.env,
    auth.organizationId,
    query,
    limit,
    conversationId,
    tags,
    undefined, // snippetChars
    undefined, // minScore
    undefined, // dedupe
    project,
  );
  const results = privacy.canReadBodies
    ? raw
    : raw.map(({ chunk_text: _c, ...rest }) => rest);

  await trackSearchRun(c.env.DB, auth.organizationId).catch(() => {});
  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
    query,
    results: results.length,
    source: "rest",
  });

  return c.json(
    privacy.canReadBodies
      ? { results, total: results.length }
      : { results, total: results.length, privacy_notice: PRIVACY_BODIES_NOTICE },
  );
});
