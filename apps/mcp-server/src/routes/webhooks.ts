import { Hono } from "hono";
import { generateId, generateWebhookSecret } from "@getengram/shared";
import {
  insertWebhookEndpoint,
  getWebhookEndpointsByOrg,
  getWebhookEndpointCount,
  deleteWebhookEndpoint,
} from "@getengram/db";
import { checkFeatureAccess } from "../services/tier.js";
import { validateWebhookUrl, WEBHOOK_MAX_PER_ORG } from "../services/webhook-url.js";
import { denyUnlessOwner } from "./guards.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const webhooks = new Hono<HonoEnv>();

// Gate: webhooks are Team+ only, and owner-only within the org (the #441
// floor). A webhook is org-wide integration config: it is told about every
// seat's activity, and its URL routinely carries the receiver's own secret.
webhooks.use("*", async (c, next) => {
  const auth = c.get("auth");
  if (!checkFeatureAccess(auth.tier, "webhooks")) {
    return c.json({
      error: "feature_not_available",
      message: "Webhooks are available on Team and Enterprise plans. Upgrade at https://getengram.app/pricing",
      tier: auth.tier,
    }, 403);
  }
  const denied = denyUnlessOwner(c, "Only the organization owner can manage webhooks.");
  if (denied) return denied;
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
  const body = (await c.req.json().catch(() => null)) as { url?: unknown; events?: unknown } | null;
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body", message: "Body must be a JSON object." }, 400);
  }

  // The destination is the SSRF surface (engram#448); the policy lives in
  // one place and is applied again at fire time.
  const target = validateWebhookUrl(body.url);
  if (!target.ok) {
    return c.json({ error: "invalid_url", message: target.reason }, 400);
  }

  const validEvents = ["messages.appended", "conversation.created", "conversation.deleted"];
  const events = (Array.isArray(body.events) ? body.events : []).filter(
    (e): e is string => typeof e === "string" && validEvents.includes(e),
  );
  if (events.length === 0) {
    return c.json(
      { error: "invalid_events", message: `At least one valid event required. Valid events: ${validEvents.join(", ")}` },
      400,
    );
  }

  // Every event fans out to every active endpoint, so an unbounded list is
  // an amplifier: one append becomes N signed POSTs from our egress.
  const existing = await getWebhookEndpointCount(c.env.DB, auth.organizationId);
  if ((existing?.count ?? 0) >= WEBHOOK_MAX_PER_ORG) {
    return c.json(
      {
        error: "webhook_limit_reached",
        message: `An organization can have at most ${WEBHOOK_MAX_PER_ORG} active webhook endpoints. Delete one to add another.`,
      },
      409,
    );
  }

  const id = generateId("whk");
  const secret = generateWebhookSecret();

  // Stored in its canonical form (lowercased host, resolved dot segments) so
  // what we fire is exactly what was validated.
  await insertWebhookEndpoint(c.env.DB, id, auth.organizationId, target.url, events, secret);

  // Return secret ONCE — can never be retrieved again
  return c.json({ id, url: target.url, events, secret }, 201);
});

// Delete a webhook endpoint
webhooks.delete("/:id", async (c) => {
  const auth = c.get("auth");
  const webhookId = c.req.param("id");
  await deleteWebhookEndpoint(c.env.DB, webhookId, auth.organizationId);
  return c.json({ removed: true });
});

export { webhooks };
