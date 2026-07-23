import { Hono } from "hono";
import { z } from "zod";
import {
  appendMessages,
  getOrCreateDefaultConversation,
} from "../services/conversation.js";
import {
  checkAndTrackStorage,
  checkAndTrackMessages,
  releaseStorage,
} from "../services/tier.js";
import { searchConversations } from "../services/search.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE,
} from "../services/privacy.js";
import { fireWebhooks } from "../services/webhooks.js";
import { audit } from "../services/audit.js";
import { usageMeter, meterBar } from "../mcp/usage-messaging.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

/**
 * REST counterpart to the MCP append_messages / search tools — for the web
 * dashboard's onboarding wizard, which can't drive the MCP protocol
 * directly. Same enforcement (storage cap, monthly abuse guard, privacy),
 * plain structured JSON instead of conversational strings: this is
 * consumed by React, not relayed by a model.
 */
export const memories = new Hono<HonoEnv>();

const saveSchema = z.object({
  text: z.string().min(1).max(20_000),
  conversation_id: z.string().optional(),
});

memories.post("/", async (c) => {
  const auth = c.get("auth");
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: parsed.error.flatten() }, 400);
  }
  const { text, conversation_id } = parsed.data;

  const storageCheck = await checkAndTrackStorage(c.env.DB, auth.organizationId, auth.tier, 1);
  if (!storageCheck.allowed) {
    return c.json(
      { error: "storage_full", limit: storageCheck.limit, used: storageCheck.used },
      402,
    );
  }

  const tierCheck = await checkAndTrackMessages(c.env.DB, auth.organizationId, auth.tier, 1);
  if (!tierCheck.allowed) {
    await releaseStorage(c.env.DB, auth.organizationId, 1);
    return c.json(
      { error: tierCheck.error ?? "message_limit_exceeded", limit: tierCheck.limit, used: tierCheck.used },
      429,
    );
  }

  const conversationId =
    conversation_id ?? (await getOrCreateDefaultConversation(c.env.DB, auth.organizationId));

  let messages;
  try {
    messages = await appendMessages(
      c.env,
      auth.organizationId,
      conversationId,
      [{ role: "user", content: text }],
    );
  } catch (err) {
    await releaseStorage(c.env.DB, auth.organizationId, 1).catch(() => {});
    throw err;
  }

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "messages.append", "conversation", conversationId, {
    count: messages.length,
    source: "dashboard",
  });

  fireWebhooks(c.env.DB, auth.organizationId, "messages.appended", {
    conversation_id: conversationId,
    message_count: messages.length,
    message_ids: messages.map((m) => m.id),
  }).catch(() => {});

  const storageMeter = usageMeter(storageCheck.used, storageCheck.limit);

  return c.json({
    conversation_id: conversationId,
    message_id: messages[0]?.id,
    storage: storageMeter
      ? { ...storageMeter, bar: meterBar(storageCheck.used, storageCheck.limit) }
      : undefined,
  });
});

memories.get("/search", async (c) => {
  const auth = c.get("auth");
  const query = c.req.query("q")?.trim();
  if (!query) {
    return c.json({ error: "missing_query" }, 400);
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "5") || 5, 1), 20);

  const privacy = await loadPrivacy(c.env.DB, auth.organizationId);
  if (!privacy.canReadCrossConversation) {
    return c.json({ results: [], total: 0, privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE });
  }

  const raw = await searchConversations(c.env, auth.organizationId, query, limit, undefined, undefined, undefined, undefined, undefined, undefined, auth.seatId);
  const results = privacy.canReadBodies
    ? raw
    : raw.map(({ chunk_text: _c, ...rest }) => rest);

  await audit(c.env.DB, auth.organizationId, auth.apiKeyId, "search", undefined, undefined, {
    query,
    results: results.length,
    source: "dashboard",
  });

  return c.json(
    privacy.canReadBodies
      ? { results, total: results.length }
      : { results, total: results.length, privacy_notice: PRIVACY_BODIES_NOTICE },
  );
});
