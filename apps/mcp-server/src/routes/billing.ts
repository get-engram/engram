import { Hono } from "hono";
import {
  claimStripeWebhookEvent,
  getOrganizationById,
  getOrganizationByStripeCustomer,
  markStripeWebhookEventProcessed,
  releaseStripeWebhookEvent,
  setOrganizationTier,
} from "@getengram/db";
import { TIER_LIMITS } from "@getengram/shared";
import {
  createCheckoutSession,
  createOrGetCustomer,
  createPortalSession,
  priceToTier,
  verifyWebhookSignature,

  resolvePlanPrice,
} from "../services/stripe.js";
import { bindStripeCustomer, resolveCachedCustomer } from "../services/stripe-customer.js";
import { websiteBearer } from "../services/secrets.js";
import { denyUnlessOwner } from "./guards.js";
import type { Env, AuthContext } from "../types.js";

type HonoEnv = { Bindings: Env; Variables: { auth: AuthContext } };

const BILLING_OWNER_ONLY = "Only the organization owner can manage billing.";

/**
 * Stamp churned_at when a PAYING org loses its subscription (migration
 * 0030). Guarded on tier so free orgs bouncing through cancel events don't
 * get marked; the flag clears again if they later resubscribe.
 */
async function markChurned(db: Env["DB"], orgId: string): Promise<void> {
  await db
    .prepare(
      "UPDATE organizations SET churned_at = datetime('now'), cancel_at_period_end = 0 WHERE id = ? AND tier != 'free'",
    )
    .bind(orgId)
    .run();
}

/**
 * Churn + downgrade an org to free, but ONLY when the terminating Stripe event
 * is about the org's CURRENT subscription. Stripe does not guarantee event
 * ordering: a superseded old sub's late `canceled`/`deleted` can arrive after
 * the new sub's `active` and would otherwise nuke a live payer to "cancelled".
 * Returns false (no-op) when the event is for a stale/foreign subscription.
 */
async function churnIfCurrentSub(
  db: Env["DB"],
  orgId: string,
  eventSubscriptionId: string | null | undefined,
): Promise<boolean> {
  const org = await db
    .prepare("SELECT stripe_subscription_id, grace_ends_at FROM organizations WHERE id = ?")
    .bind(orgId)
    .first<{ stripe_subscription_id: string | null; grace_ends_at: string | null }>();
  const current = org?.stripe_subscription_id;
  if (current && eventSubscriptionId && current !== eventSubscriptionId) {
    // Terminating event is for an old/superseded sub — the org already moved
    // on to a different live subscription. Ignore.
    return false;
  }
  // An admin grant-pro / comp still inside its grace window is operator-managed
  // — a stray Stripe terminal event must not revert it.
  const grace = org?.grace_ends_at;
  if (grace && Date.parse(grace.replace(" ", "T") + "Z") > Date.now()) {
    return false;
  }
  await markChurned(db, orgId);
  await setOrganizationTier(db, orgId, "free", null, 1);
  return true;
}

const billing = new Hono<HonoEnv>();

/** Team is a shared plan: one seat is Pro with extra steps. */
export { TEAM_MIN_SEATS } from "../services/stripe.js";

/**
 * Does this org currently hold a verified university address?
 *
 * The same proof grants two different things: the Student price for one
 * person, and the Education price on Team seats for a department or lab.
 * Both are revocable the moment the yearly re-verification lapses, which is
 * the only thing keeping either honest.
 */
async function academicallyVerified(db: D1Database, orgId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT student_verified_at, student_expires_at FROM organizations WHERE id = ?`)
    .bind(orgId)
    .first<{ student_verified_at: string | null; student_expires_at: string | null }>();
  return (
    !!row?.student_verified_at &&
    !!row.student_expires_at &&
    new Date(row.student_expires_at + "Z").getTime() > Date.now()
  );
}

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
  // Checkout changes what the org is charged — owner only (engram#441). A
  // Team member reaching this would have been able to put the owner's card
  // through a plan change.
  const denied = denyUnlessOwner(c, BILLING_OWNER_ONLY);
  if (denied) return denied;

  const auth = c.get("auth");
  const body = await c.req
    .json<{
      success_url?: string;
      cancel_url?: string;
      plan?: "pro" | "team" | "student";
      quantity?: number;
    }>()
    .catch(() => ({}) as Record<string, never>);

  const requested =
    body.plan === "team" ? "team" : body.plan === "student" ? "student" : "pro";

  // Student pricing is gated server-side (engram#471). A client can ask for
  // it, but only a current verification grants it — never trust the plan field
  // to decide what something costs.
  const plan: "pro" | "team" | "student" = requested;
  const academic = await academicallyVerified(c.env.DB, auth.organizationId);
  if (requested === "student") {
    const active = academic;
    if (!active) {
      return c.json(
        {
          error: "student_not_verified",
          message:
            "Student pricing requires a verified university email. Verify at /student/verify first.",
        },
        403,
      );
    }
  }

  // Education pricing is APPLIED, never requested: a verified academic org
  // buying Team seats gets the academic price automatically. A client cannot
  // ask for the discount, so asking cannot grant it.
  const { priceId, minSeats } = resolvePlanPrice(c.env, plan, {
    academicallyVerified: academic,
  });
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

  // Ensure a Stripe customer exists and is cached on the org row. The cached
  // one must be this org's own (engram#443): a foreign or vanished customer is
  // unlinked and replaced, never checked out against.
  const cached = await resolveCachedCustomer(c.env, org);
  let customerId: string | null = cached.ok ? cached.customerId : null;
  if (!customerId) {
    const customer = await createOrGetCustomer(
      c.env.STRIPE_SECRET_KEY,
      org.email,
      org.id,
    );
    customerId = customer.id;
    // Refused when another org already holds this customer (engram#536):
    // never create a checkout session against a customer that is not
    // provably this org's alone.
    if ((await bindStripeCustomer(c.env.DB, org.id, customerId)) === "conflict") {
      return c.json(
        {
          error: "stripe_customer_conflict",
          message:
            "This billing identity is already attached to another organization. Contact support.",
        },
        409,
      );
    }
  }

  // One subscription per customer. If they already have any active or
  // trialing subscription, send them to the billing portal to manage it.
  // Without the trialing check, a user who starts a free trial and comes
  // back the next day would bypass this guard and create a duplicate.
  if (customerId) {
    for (const status of ["active", "trialing"] as const) {
      const subsRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=${status}&limit=1`,
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
  }

  const successUrl =
    body.success_url ||
    `${c.env.APP_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = body.cancel_url || `${c.env.APP_URL}/pricing?upgrade=cancelled`;

  // Team has a TWO SEAT MINIMUM, and it is the more important half of the
  // Sept->Oct 2026 repricing.
  //
  // Both Team subscriptions ever sold bought ONE seat: $27 for what Pro gave
  // at $9 plus webhooks. That is the worst configuration of the product, and
  // the product was happily selling it — one of them cancelled after four
  // days. A single-seat "team" is Pro with extra steps; at $9/seat it would
  // also undercut Pro outright. The floor makes the plan mean what its name
  // says: more than one person sharing a memory.
  const quantity = Math.max(minSeats, body.quantity ?? minSeats);

  const session = await createCheckoutSession(c.env.STRIPE_SECRET_KEY, {
    customerId,
    priceId,
    quantity,
    adjustableQuantity: plan === "team",
    minQuantity: plan === "team" ? minSeats : undefined,
    successUrl,
    cancelUrl,
    organizationId: org.id,
  });

  return c.json({ url: session.url, session_id: session.id, plan });
});

// POST /api/billing/portal
// Authed. Creates a Billing Portal session and returns its URL.
billing.post("/portal", async (c) => {
  // The Stripe portal exposes the payment method, invoices, and cancel —
  // owner only (engram#441).
  const denied = denyUnlessOwner(c, BILLING_OWNER_ONLY);
  if (denied) return denied;

  const auth = c.get("auth");
  const body = await c.req
    .json<{ return_url?: string }>()
    .catch(() => ({}) as Record<string, string>);

  const org = (await getOrganizationById(c.env.DB, auth.organizationId)) as
    | { id: string; stripe_customer_id: string | null }
    | null;
  // The portal shows the card, the invoices and the cancel button, so only
  // this org's own customer opens it (engram#443): a cached id that turns out
  // to be another org's is unlinked and refused.
  const cached = org ? await resolveCachedCustomer(c.env, org) : null;
  if (!cached?.ok) {
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
    customerId: cached.customerId,
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

/**
 * A Stripe event id is `evt_` plus an opaque body. The idempotency ledger
 * keys on it, so a signed body that is not shaped like an event is refused
 * before it can touch D1.
 */
const STRIPE_EVENT_ID = /^evt_[A-Za-z0-9_]{1,250}$/;

function asStripeEvent(parsed: unknown): StripeEvent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const e = parsed as { id?: unknown; type?: unknown; data?: unknown };
  if (typeof e.id !== "string" || !STRIPE_EVENT_ID.test(e.id)) return null;
  if (typeof e.type !== "string" || e.type.length === 0 || e.type.length > 100) return null;
  if (!e.data || typeof e.data !== "object") return null;
  const obj = (e.data as { object?: unknown }).object;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  return { id: e.id, type: e.type, data: { object: obj as Record<string, unknown> } };
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

// ---------------------------------------------------------------------------
// Billing notices (engram#747): emails about a failed renewal, sent by
// engram-web from hello@getengram.app.
// ---------------------------------------------------------------------------

type BillingNotice = "payment-failed" | "plan-ended";

/**
 * Hand a billing notice to engram-web. One that could not be handed over
 * throws: the webhook then gives its claim back and answers 500, so Stripe's
 * redelivery sends it again instead of the customer never hearing. Both
 * callers are safe to run twice.
 */
async function sendBillingNotice(
  env: Env,
  notice: BillingNotice,
  body: { to: string; org_id: string } & Record<string, unknown>,
): Promise<void> {
  const bearer = websiteBearer(env);
  if (!env.APP_URL || !bearer) {
    console.error(`[billing] ${notice} email for org ${body.org_id}: no APP_URL or website bearer, not sent`);
    return;
  }
  const res = await fetch(`${env.APP_URL}/api/email/${notice}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`[billing] ${notice} email for org ${body.org_id}: website answered ${res.status}`);
  }
}

type NoticeOrg = {
  email: string | null;
  tier: string | null;
  deleted_at: string | null;
  stripe_subscription_id: string | null;
  messages_stored_total: number | null;
};

/**
 * A renewal charge was declined. Stripe retries it for about two weeks before
 * it cancels the plan; this tells the customer while there is still time to
 * fix it. Only a renewal's first failure is announced (the retries after it
 * stay quiet), and the email links Stripe's own page for paying that invoice.
 */
async function notifyPaymentFailed(env: Env, invoice: Record<string, unknown>): Promise<void> {
  if (invoice.billing_reason !== "subscription_cycle" || invoice.attempt_count !== 1) return;

  // The endpoint runs API 2026-04-22.dahlia, which carries the subscription
  // (and the metadata checkout stamped on it) under parent.subscription_details.
  const details = (
    invoice.parent as
      | { subscription_details?: { subscription?: unknown; metadata?: Record<string, unknown> } | null }
      | null
      | undefined
  )?.subscription_details;
  const subscriptionId = typeof details?.subscription === "string" ? details.subscription : null;
  const metaOrgId = details?.metadata?.organization_id;
  const orgId =
    typeof metaOrgId === "string" && metaOrgId ? metaOrgId : await resolveOrgIdFromEvent(env, invoice);
  if (!orgId) return;

  const org = (await getOrganizationById(env.DB, orgId)) as NoticeOrg | null;
  // The email tells them they are still on their plan, so it goes only to an
  // org that is.
  if (!org || org.deleted_at || !org.tier || org.tier === "free") return;
  // A renewal of a subscription the org has since replaced is not theirs to fix.
  if (org.stripe_subscription_id && subscriptionId && org.stripe_subscription_id !== subscriptionId) return;

  const to = org.email ?? (typeof invoice.customer_email === "string" ? invoice.customer_email : null);
  if (!to) return;

  const next = invoice.next_payment_attempt;
  await sendBillingNotice(env, "payment-failed", {
    to,
    tier: org.tier,
    amount_due: invoice.amount_due,
    currency: invoice.currency,
    next_payment_attempt: typeof next === "number" && next > 0 ? new Date(next * 1000).toISOString() : null,
    hosted_invoice_url: invoice.hosted_invoice_url,
    org_id: orgId,
  });
}

/**
 * Stripe gave up on a renewal and cancelled the plan, and the org has just
 * been moved to Free. Tell them what that means for what they have saved.
 * Called only after churnIfCurrentSub did the downgrade. A subscription that
 * never started (incomplete_expired) has nothing to announce. The plan name
 * comes from the cancelled subscription, not the org: on a redelivery the
 * org already reads Free.
 */
async function notifyPlanEnded(env: Env, orgId: string, subscription: Record<string, unknown>): Promise<void> {
  const reason = (subscription.cancellation_details as { reason?: unknown } | null | undefined)?.reason;
  if (subscription.status !== "canceled" || reason !== "payment_failed") return;

  const org = (await getOrganizationById(env.DB, orgId)) as NoticeOrg | null;
  if (!org || org.deleted_at || !org.email) return;

  const items = (subscription.items as { data?: Array<{ price?: { id?: string } }> } | undefined)?.data;
  await sendBillingNotice(env, "plan-ended", {
    to: org.email,
    tier: priceToTier(env, items?.[0]?.price?.id),
    stored_messages: typeof org.messages_stored_total === "number" ? org.messages_stored_total : null,
    free_limit: TIER_LIMITS.free.storage_messages,
    org_id: orgId,
  });
}

/**
 * Apply one verified, claimed event to D1. Every D1 write is idempotent (the
 * ledger in front of it makes that a defence in depth rather than the only
 * guard), and an unknown type is a no-op so Stripe stops retrying it. The
 * billing notices lean on the ledger alone: running one again sends the email
 * again, which is what a send that failed wants.
 */
async function applyStripeEvent(env: Env, event: StripeEvent): Promise<void> {
  const obj = event.data.object;

  switch (event.type) {
    case "checkout.session.completed": {
      // Cache the customer id on the org (usually already done at /checkout
      // time, but defensive).
      const orgId = await resolveOrgIdFromEvent(env, obj);
      const customer = obj.customer as string | undefined;
      if (orgId && customer) {
        // A refused bind (engram#536) is logged by the binder; the event
        // still completes — a 500 here would only make Stripe retry it.
        await bindStripeCustomer(env.DB, orgId, customer);
      }
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const orgId = await resolveOrgIdFromEvent(env, obj);
      if (!orgId) break;

      const status = obj.status as string;
      const subscriptionId = obj.id as string;
      const items = (obj.items as { data?: Array<{ price?: { id?: string }; quantity?: number }> })
        ?.data;
      const priceId = items?.[0]?.price?.id;
      const quantity = items?.[0]?.quantity ?? 1;

      const newTier = priceToTier(env, priceId);

      if (
        (status === "active" || status === "trialing") &&
        newTier
      ) {
        const seatLimit = newTier === "team" ? quantity : 1;
        await setOrganizationTier(env.DB, orgId, newTier, subscriptionId, seatLimit);
        // Track scheduled cancellation ("pro but cancelling" in admin). An
        // active sub also clears any past churn stamp — they came back.
        // Stripe records a scheduled cancel two ways: cancel_at_period_end
        // (bool) or cancel_at (timestamp, e.g. portal "cancel on <date>").
        // Reading only the bool missed real cancellations (anar3nata,
        // 2026-08 — dashboard showed "Cancels Aug 15", admin showed
        // healthy).
        const cancelling = Boolean(obj.cancel_at_period_end) || (typeof obj.cancel_at === "number" && obj.cancel_at > 0);
        await env.DB.prepare(
          "UPDATE organizations SET cancel_at_period_end = ?, churned_at = CASE WHEN ? = 0 THEN NULL ELSE churned_at END WHERE id = ?",
        )
          .bind(cancelling ? 1 : 0, cancelling ? 1 : 0, orgId)
          .run();
      } else if (
        status === "canceled" ||
        status === "incomplete_expired" ||
        status === "unpaid"
      ) {
        // Only downgrade if this event is for the org's current sub (guards
        // against out-of-order events from a superseded subscription).
        //
        // NOTE: `past_due` is deliberately NOT in this list. It means a
        // renewal charge failed and Stripe is still retrying (dunning runs for
        // weeks and usually recovers) — the customer intends to pay and
        // yanking their plan mid-retry is both wrong and a good way to lose
        // them. Stripe escalates to `unpaid` or `canceled` when dunning is
        // exhausted, and those DO churn here. Observed: a paying customer's
        // card bounced and they were instantly downgraded to free.
        await churnIfCurrentSub(env.DB, orgId, subscriptionId);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const orgId = await resolveOrgIdFromEvent(env, obj);
      if (orgId && (await churnIfCurrentSub(env.DB, orgId, obj.id as string))) {
        // Cancelled for non-payment: say so (engram#747).
        await notifyPlanEnded(env, orgId, obj);
      }
      break;
    }

    case "invoice.payment_failed":
      // A declined renewal: tell the customer while Stripe retries (engram#747).
      await notifyPaymentFailed(env, obj);
      break;

    default:
      // Acknowledge unknown events with 200 so Stripe doesn't keep retrying
      break;
  }
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const event = asStripeEvent(parsed);
  if (!event) {
    return c.json({ error: "invalid_event" }, 400);
  }

  // Idempotency (engram#454): claim the id before doing anything. A repeat
  // delivery, whether Stripe's own retry or a captured signed body replayed
  // inside the signature window, is acknowledged and otherwise ignored.
  const claimed = await claimStripeWebhookEvent(c.env.DB, event.id, event.type);
  if (!claimed) {
    console.log(`[billing] webhook ${event.type} ${event.id}: already handled, ignored`);
    return c.json({ received: true, duplicate: true });
  }

  try {
    await applyStripeEvent(c.env, event);
  } catch (err) {
    // Give the id back so the retry Stripe sends for the non-2xx runs the
    // handler again instead of being dropped as a duplicate.
    await releaseStripeWebhookEvent(c.env.DB, event.id).catch((releaseErr: unknown) => {
      console.error(
        `[billing] webhook ${event.id}: release failed: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
      );
    });
    throw err;
  }
  await markStripeWebhookEventProcessed(c.env.DB, event.id);

  return c.json({ received: true });
});
