import { Hono } from "hono";
import { generateId, generateWebhookSecret } from "@getengram/shared";
import {
  insertWebhookEndpoint,
  getWebhookEndpointsByOrg,
  deleteWebhookEndpoint,
} from "@getengram/db";
import { checkFeatureAccess } from "../services/tier.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const webhooks = new Hono<HonoEnv>();

// Gate: webhooks are Team+ only
webhooks.use("*", async (c, next) => {
  const auth = c.get("auth");
  if (!checkFeatureAccess(auth.tier, "webhooks")) {
    return c.json({
      error: "feature_not_available",
      message: "Webhooks are available on Team and Enterprise plans. Upgrade at https://getengram.app/pricing",
      tier: auth.tier,
    }, 403);
  }
  await next();
});

// List webhook endpoints
webhooks.get("/", async (c) => {
  const auth = c.get("auth");
  const result = await getWebhookEndpointsByOrg(c.env.DB, auth.organizationId);
  // Strip secrets from response
  const endpoints = (result.results || []).map((ep: Record<string, unknown>) => ({
    id: ep.id,
    url: ep.url,
    events: JSON.parse((ep.events as string) || "[]"),
    active: ep.active,
    created_at: ep.created_at,
  }));
  return c.json({ webhooks: endpoints });
});

// Register a webhook endpoint
webhooks.post("/", async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json<{ url: string; events: string[] }>();

  if (!body.url) {
    return c.json({ error: "URL is required" }, 400);
  }

  const validEvents = ["messages.appended", "conversation.created", "conversation.deleted"];
  const events = (body.events || []).filter((e) => validEvents.includes(e));
  if (events.length === 0) {
    return c.json({ error: `At least one valid event required. Valid events: ${validEvents.join(", ")}` }, 400);
  }

  const id = generateId("whk");
  const secret = generateWebhookSecret();

  await insertWebhookEndpoint(c.env.DB, id, auth.organizationId, body.url, events, secret);

  // Return secret ONCE — can never be retrieved again
  return c.json({ id, url: body.url, events, secret }, 201);
});

// Delete a webhook endpoint
webhooks.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const webhookId = c.req.param("id");
  await deleteWebhookEndpoint(c.env.DB, webhookId, auth.organizationId);
  return c.json({ removed: true });
});

export { webhooks };
