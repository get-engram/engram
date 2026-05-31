import { Hono } from "hono";
import {
  getOrganizationById,
  getOrganizationByStripeCustomer,
  setOrganizationStripeCustomer,
  setOrganizationTier,
} from "@getengram/db";
import {
  createCheckoutSession,
  createOrGetCustomer,
  createPortalSession,
  verifyWebhookSignature,
} from "../services/stripe.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const billing = new Hono<HonoEnv>();

// POST /api/billing/checkout
// Authed. Creates a Checkout Session and returns its URL. The caller is
// expected to redirect the user to the returned URL.
//
// Body:
//   plan        — "pro" (default) or "team"
//   quantity    — only meaningful for team; defaults to 1 seat. Customers
//                 can also edit this inside Stripe Checkout via the
//                 adjustable_quantity toggle.
//   success_url — override redirect on success
//   cancel_url  — override redirect on cancel
billing.post("/checkout", async (c) => {
  const auth = c.get("auth");
  const body = await c.req
    .json<{
      success_url?: string;
      cancel_url?: string;
      plan?: "pro" | "team";
      quantity?: number;
    }>()
    .catch(() => ({}) as Record<string, never>);

  const plan = body.plan === "team" ? "team" : "pro";
  const priceId =
    plan === "team" ? c.env.STRIPE_PRICE_ID_TEAM : c.env.STRIPE_PRICE_ID_PRO;
  if (!priceId) {
    return c.json(
      { error: "price_not_configured", message: `No Stripe price configured for plan="${plan}"` },
      500,
    );
  }

  const org = (await getOrganizationById(c.env.DB, auth.organizationId)) as
    | { id: string; email: string | null; stripe_customer_id: string | null }
    | null;
  if (!org) return c.json({ error: "organization_not_found" }, 404);
  if (!org.email) {
    return c.json(
      {
        error: "missing_email",
        message:
          "Organization has no email on file. Contact support to attach one.",
      },
      400,
    );
  }

  // Ensure a Stripe customer exists and is cached on the org row
  let customerId = org.stripe_customer_id;
  if (!customerId) {
    const customer = await createOrGetCustomer(
      c.env.STRIPE_SECRET_KEY,
      org.email,
      org.id,
    );
    customerId = customer.id;
    await setOrganizationStripeCustomer(c.env.DB, org.id, customerId);
  }

  // If the customer already has an active subscription for this price,
  // send them to the billing portal instead of creating a duplicate.
  if (customerId) {
    const subsRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&price=${priceId}&limit=1`,
      { headers: { Authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}` } },
    );
    if (subsRes.ok) {
      const subs = (await subsRes.json()) as { data: unknown[] };
      if (subs.data.length > 0) {
        const portal = await createPortalSession(c.env.STRIPE_SECRET_KEY, {
          customerId,
          returnUrl: `${c.env.APP_URL}/dashboard`,
        });
        return c.json({ url: portal.url, already_subscribed: true, plan });
      }
    }
  }

  const successUrl =
    body.success_url ||
    `${c.env.APP_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancel_url || `${c.env.APP_URL}/pricing?upgrade=cancelled`;

  const quantity = plan === "team" ? Math.max(1, body.quantity ?? 1) : 1;

  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId,
    priceId,
    quantity,
    adjustableQuantity: plan === "team",
    successUrl,
    cancelUrl,
    organizationId: org.id,
  });

  return c.json({ url: session.url, session_id: session.id, plan });
});

// POST /api/billing/portal
// Authed. Creates a Billing Portal session and returns its URL.
billing.post("/portal", async (c) => {
  const auth = c.get("auth");
  const body = await c.req
    .json<{ return_url?: string }>()
    .catch(() => ({}) as Record<string, string>);

  const org = (await getOrganizationById(c.env.DB, auth.organizationId)) as
    | { stripe_customer_id: string | null }
    | null;
  if (!org?.stripe_customer_id) {
    return c.json(
      {
        error: "no_subscription",
        message: "No Stripe customer is attached to this organization yet.",
      },
      400,
    );
  }

  const returnUrl = body.return_url || `${c.env.APP_URL}/dashboard`;

  const session = await createPortalSession(c.env.STRIPE_SECRET_KEY, {
    customerId: org.stripe_customer_id,
    returnUrl,
  });

  return c.json({ url: session.url });
});

export { billing };

// ---------------------------------------------------------------------------
// Public session verification — lets the success page look up org info from
// a Stripe checkout session_id (unguessable). No API key needed.
// ---------------------------------------------------------------------------

export const billingSession = new Hono<{ Bindings: Env }>();

interface StripeCheckoutSession {
  id: string;
  status: string;
  metadata: Record<string, string>;
  customer_details?: { email?: string };
}

billingSession.post("/", async (c) => {
  const body = await c.req.json<{ session_id?: string }>().catch(() => ({}));
  const sessionId = (body as { session_id?: string }).session_id;
  if (!sessionId || !sessionId.startsWith("cs_")) {
    return c.json({ error: "invalid_session_id" }, 400);
  }

  // Look up the checkout session from Stripe
  const stripeKey = c.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return c.json({ error: "stripe_not_configured" }, 500);
  }

  const res = await fetch(
    `https://api.stripe.com/v1/checkout/sessions/${sessionId}`,
    {
      headers: { Authorization: `Bearer ${stripeKey}` },
    },
  );
  if (!res.ok) {
    return c.json({ error: "session_not_found" }, 404);
  }

  const session = (await res.json()) as StripeCheckoutSession;
  if (session.status !== "complete") {
    return c.json({ error: "session_not_complete" }, 400);
  }

  const orgId = session.metadata?.organization_id;
  if (!orgId) {
    return c.json({ error: "no_organization" }, 400);
  }

  const org = (await getOrganizationById(c.env.DB, orgId)) as {
    id: string;
    email: string | null;
    tier: string;
  } | null;
  if (!org) {
    return c.json({ error: "organization_not_found" }, 404);
  }

  return c.json({
    organization_id: org.id,
    email: org.email,
    tier: org.tier,
  });
});

// ---------------------------------------------------------------------------
// Public webhook handler (NOT authed — verified by HMAC signature instead)
// ---------------------------------------------------------------------------

export const billingWebhook = new Hono<{ Bindings: Env }>();

type StripeEvent = {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
};

function priceToTier(
  env: Env,
  priceId: string | undefined,
): "free" | "pro" | "team" | "enterprise" | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_ID_PRO) return "pro";
  if (priceId === env.STRIPE_PRICE_ID_TEAM) return "team";
  return null;
}

async function resolveOrgIdFromEvent(
  env: Env,
  obj: Record<string, unknown>,
): Promise<string | null> {
  // Prefer explicit metadata set at checkout time
  const meta = (obj.metadata || {}) as Record<string, string>;
  if (meta.organization_id) return meta.organization_id;

  // Fall back to looking up the customer
  const customer = obj.customer as string | undefined;
  if (customer) {
    const org = (await getOrganizationByStripeCustomer(env.DB, customer)) as
      | { id: string }
      | null;
    if (org) return org.id;
  }
  return null;
}

billingWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json({ error: "missing_signature" }, 400);
  }

  // Must use raw body for signature verification
  const rawBody = await c.req.text();

  const valid = await verifyWebhookSignature(
    rawBody,
    signature,
    c.env.STRIPE_WEBHOOK_SECRET,
  );
  if (!valid) {
    return c.json({ error: "invalid_signature" }, 400);
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      // Cache the customer id on the org (usually already done at /checkout
      // time, but defensive).
      const orgId = await resolveOrgIdFromEvent(c.env, obj);
      const customer = obj.customer as string | undefined;
      if (orgId && customer) {
        await setOrganizationStripeCustomer(c.env.DB, orgId, customer);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const orgId = await resolveOrgIdFromEvent(c.env, obj);
      if (!orgId) break;

      const status = obj.status as string;
      const subscriptionId = obj.id as string;
      const items = (obj.items as { data?: Array<{ price?: { id?: string } }> })
        ?.data;
      const priceId = items?.[0]?.price?.id;

      const newTier = priceToTier(c.env, priceId);

      if (
        (status === "active" || status === "trialing") &&
        newTier
      ) {
        await setOrganizationTier(c.env.DB, orgId, newTier, subscriptionId);
      } else if (
        status === "canceled" ||
        status === "incomplete_expired" ||
        status === "unpaid" ||
        status === "past_due"
      ) {
        await setOrganizationTier(c.env.DB, orgId, "free", null);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const orgId = await resolveOrgIdFromEvent(c.env, obj);
      if (orgId) {
        await setOrganizationTier(c.env.DB, orgId, "free", null);
      }
      break;
    }

    default:
      // Acknowledge unknown events with 200 so Stripe doesn't keep retrying
      break;
  }

  return c.json({ received: true });
});
