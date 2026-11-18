import { getOrganizationById } from "@getengram/db";
import { createCheckoutSession, createOrGetCustomer } from "./stripe.js";
import { bindStripeCustomer, resolveCachedCustomer } from "./stripe-customer.js";
import type { Env } from "../types.js";

/** What starting a checkout for an org came to. */
export type CheckoutOutcome =
  | { kind: "error"; status: 400 | 404 | 409; body: { error: string; message?: string } }
  /** The customer already holds a live subscription; no session was created. */
  | { kind: "already_subscribed"; customerId: string }
  | { kind: "session"; url: string; sessionId: string };

/**
 * Start a Stripe Checkout for an org: its Stripe customer, the
 * one-subscription guard, then the session. Shared by the signed-in
 * checkout (POST /api/billing/checkout) and the emailed offer link
 * (POST /offers/black-friday/checkout), so the customer checks of
 * engram#443 and engram#536 cannot be skipped by either.
 *
 * The caller decides who may ask and at what price; nothing here trusts a
 * request body.
 */
export async function checkoutForOrg(
  env: Env,
  organizationId: string,
  params: {
    priceId: string;
    quantity?: number;
    adjustableQuantity?: boolean;
    minQuantity?: number;
    successUrl: string;
    cancelUrl: string;
    expiresAt?: number;
    allowPromotionCodes?: boolean;
    offer?: string;
  },
): Promise<CheckoutOutcome> {
  const org = (await getOrganizationById(env.DB, organizationId)) as
    | { id: string; email: string | null; stripe_customer_id: string | null }
    | null;
  if (!org) return { kind: "error", status: 404, body: { error: "organization_not_found" } };
  if (!org.email) {
    return {
      kind: "error",
      status: 400,
      body: {
        error: "missing_email",
        message: "Organization has no email on file. Contact support to attach one.",
      },
    };
  }

  // Ensure a Stripe customer exists and is cached on the org row. The cached
  // one must be this org's own (engram#443): a foreign or vanished customer is
  // unlinked and replaced, never checked out against.
  const cached = await resolveCachedCustomer(env, org);
  let customerId: string | null = cached.ok ? cached.customerId : null;
  if (!customerId) {
    const customer = await createOrGetCustomer(env.STRIPE_SECRET_KEY, org.email, org.id);
    customerId = customer.id;
    // Refused when another org already holds this customer (engram#536):
    // never create a checkout session against a customer that is not
    // provably this org's alone.
    if ((await bindStripeCustomer(env.DB, org.id, customerId)) === "conflict") {
      return {
        kind: "error",
        status: 409,
        body: {
          error: "stripe_customer_conflict",
          message: "This billing identity is already attached to another organization. Contact support.",
        },
      };
    }
  }

  // One subscription per customer. Without the trialing check, a user who
  // starts a free trial and comes back the next day would bypass this guard
  // and create a duplicate.
  for (const status of ["active", "trialing"] as const) {
    const subsRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${encodeURIComponent(customerId)}&status=${status}&limit=1`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
    );
    if (subsRes.ok) {
      const subs = (await subsRes.json()) as { data: unknown[] };
      if (subs.data.length > 0) return { kind: "already_subscribed", customerId };
    }
  }

  const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
    customerId,
    priceId: params.priceId,
    quantity: params.quantity,
    adjustableQuantity: params.adjustableQuantity,
    minQuantity: params.minQuantity,
    successUrl: params.successUrl,
    cancelUrl: params.cancelUrl,
    organizationId: org.id,
    expiresAt: params.expiresAt,
    allowPromotionCodes: params.allowPromotionCodes,
    offer: params.offer,
  });
  return { kind: "session", url: session.url, sessionId: session.id };
}
