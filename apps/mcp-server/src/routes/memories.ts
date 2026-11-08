import { Hono } from "hono";
import { z } from "zod";
import { MAX_SEARCH_QUERY_CHARS } from "@getengram/shared";
import {
  appendMessages,
  getOrCreateDefaultConversation,
} from "../services/conversation.js";
import {
  checkAndTrackSearch,
  reserveAppend,
  releaseAppendCharges,
} from "../services/tier.js";
import { searchConversations } from "../services/search.js";
import {
  loadPrivacy,
  PRIVACY_BODIES_NOTICE,
  PRIVACY_CROSS_CONVERSATION_NOTICE, stripBodyFields } from "../services/privacy.js";
import { fireWebhooks } from "../services/webhooks.js";
import { audit } from "../services/audit.js";
import { denyUnlessScope } from "./guards.js";
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
  // The scope every other append path checks (engram#603).
  const denied = denyUnlessScope(c, "write");
  if (denied) return denied;
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "invalid_body", details: z.flattenError(parsed.error) }, 400);
  }
  const { text, conversation_id } = parsed.data;

  // Every gate, in order, as on the other append paths (engram#591):
  // storage, the month's message budget, the indexing budget. A refusal
  // has already given back what the gates before it took.
  const reserved = await reserveAppend(c.env.DB, auth.organizationId, auth.tier, [
    { role: "user", content: text },
  ]);
  if (!reserved.allowed) {
    const { gate, check } = reserved;
    if (gate === "storage") {
      return c.json({ error: "storage_full", limit: check.limit, used: check.used }, 402);
    }
    return c.json(
      {
        error:
          check.error ??
          (gate === "messages" ? "message_limit_exceeded" : "indexing_quota_exceeded"),
        limit: check.limit,
        used: check.used,
      },
      429,
    );
  }
  const { storage: storageCheck } = reserved;

  let conversationId: string;
  let messages;
  try {
    conversationId =
      conversation_id ?? (await getOrCreateDefaultConversation(c.env.DB, auth.organizationId));
    // `auth` as the viewer: another seat's private conversation is refused
    // as not-found (engram#264).
    messages = await appendMessages(
      c.env,
      auth.organizationId,
      conversationId,
      [{ role: "user", content: text }],
      undefined,
      auth,
    );
  } catch (err) {
    // Nothing was stored (appendMessages throws only before it commits):
    // give back every charge (engram#591).
    await releaseAppendCharges(c.env.DB, auth.organizationId, reserved.charges);
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
  // The scope every other search path checks (engram#603).
  const denied = denyUnlessScope(c, "search");
  if (denied) return denied;
  const query = c.req.query("q")?.trim();
  if (!query) {
    return c.json({ error: "missing_query" }, 400);
  }
  // The same bound as the REST and MCP search (engram#564): the dashboard
  // path was the one that took a query of any length.
  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    return c.json(
      { error: "query_too_long", message: `Search query exceeds ${MAX_SEARCH_QUERY_CHARS} characters.` },
      400,
    );
  }
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "5") || 5, 1), 20);

  const privacy = await loadPrivacy(c.env.DB, auth.organizationId);
  if (!privacy.canReadCrossConversation) {
    return c.json({ results: [], total: 0, privacy_notice: PRIVACY_CROSS_CONVERSATION_NOTICE });
  }

  // Search budget (engram#451) — the dashboard path was the one search
  // surface that never counted at all.
  const searchCheck = await checkAndTrackSearch(c.env.DB, auth.organizationId, auth.tier);
  if (!searchCheck.allowed) {
    return c.json(
      { error: searchCheck.error ?? "search_quota_exceeded", limit: searchCheck.limit, used: searchCheck.used },
      429,
    );
  }

  const raw = await searchConversations(c.env, auth.organizationId, query, limit, undefined, undefined, undefined, undefined, undefined, undefined, auth.seatId);
  const results = privacy.canReadBodies ? raw : stripBodyFields(raw);

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
