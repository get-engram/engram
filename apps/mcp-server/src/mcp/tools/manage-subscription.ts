import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getOrganizationById } from "@getengram/db";
import { TIER_LIMITS } from "@getengram/shared";
import {
  createOrGetCustomer,
  createCheckoutSession,
  createPortalSession,
} from "../../services/stripe.js";
import { setOrganizationStripeCustomer } from "@getengram/db";
import { audit } from "../../services/audit.js";
import type { Env, AuthContext } from "../../types.js";

export function registerManageSubscription(
  server: McpServer,
  env: Env,
  auth: AuthContext,
) {
  server.tool(
    "manage_subscription",
    "View your current subscription or get a link to upgrade/manage your plan. Returns a Stripe Checkout URL for upgrades or a billing portal URL for existing subscribers.",
    {
      action: z
        .enum(["status", "upgrade", "portal"])
        .default("status")
        .describe(
          '"status" — show current tier and limits. "upgrade" — get a checkout link to subscribe to Pro or Team. "portal" — get a link to manage an existing subscription.',
        ),
      plan: z
        .enum(["pro", "team"])
        .optional()
        .describe('Target plan for upgrade. Defaults to "pro". Only used with action "upgrade".'),
      quantity: z
        .number()
        .optional()
        .describe("Number of seats for team plan. Only used with action \"upgrade\" and plan \"team\"."),
    },
    async (params) => {
      const org = (await getOrganizationById(env.DB, auth.organizationId)) as {
        id: string;
        email: string | null;
        tier: string;
        stripe_customer_id: string | null;
      } | null;

      if (!org) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Organization not found" }) }],
          isError: true,
        };
      }

      // --- STATUS ---
      if (params.action === "status") {
        const limits = TIER_LIMITS[auth.tier];
        audit(env.DB, auth.organizationId, auth.apiKeyId, "subscription.status", "organization", auth.organizationId);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              tier: auth.tier,
              messages_per_month: limits.messages_per_month,
              seats: limits.seats,
              webhooks: limits.webhooks,
              upgrade_available: auth.tier === "free" || auth.tier === "pro",
            }),
          }],
        };
      }

      // --- PORTAL ---
      if (params.action === "portal") {
        if (!org.stripe_customer_id) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                error: "no_subscription",
                message: "No active subscription found. Use action \"upgrade\" to subscribe.",
              }),
            }],
            isError: true,
          };
        }

        const session = await createPortalSession(env.STRIPE_SECRET_KEY, {
          customerId: org.stripe_customer_id,
          returnUrl: `${env.APP_URL}/dashboard`,
        });

        audit(env.DB, auth.organizationId, auth.apiKeyId, "subscription.portal", "organization", auth.organizationId);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              url: session.url,
              message: "Open this link to manage your subscription, update payment method, or cancel.",
            }),
          }],
        };
      }

      // --- UPGRADE ---
      if (!org.email) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: "missing_email",
              message: "Your organization has no email on file. Link an email first before upgrading.",
            }),
          }],
          isError: true,
        };
      }

      let customerId = org.stripe_customer_id;
      if (!customerId) {
        const customer = await createOrGetCustomer(env.STRIPE_SECRET_KEY, org.email, org.id);
        customerId = customer.id;
        await setOrganizationStripeCustomer(env.DB, org.id, customerId);
      }

      // If already subscribed, redirect to portal instead
      const subsRes = await fetch(
        `https://api.stripe.com/v1/subscriptions?customer=${customerId}&status=active&limit=1`,
        { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
      );
      if (subsRes.ok) {
        const subs = (await subsRes.json()) as { data: unknown[] };
        if (subs.data.length > 0) {
          const portal = await createPortalSession(env.STRIPE_SECRET_KEY, {
            customerId,
            returnUrl: `${env.APP_URL}/dashboard`,
          });

          audit(env.DB, auth.organizationId, auth.apiKeyId, "subscription.upgrade_redirect", "organization", auth.organizationId);

          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                url: portal.url,
                already_subscribed: true,
                message: "You already have an active subscription. Open this link to change your plan or manage billing.",
              }),
            }],
          };
        }
      }

      const plan = params.plan === "team" ? "team" : "pro";
      const priceId = plan === "team" ? env.STRIPE_PRICE_ID_TEAM : env.STRIPE_PRICE_ID_PRO;
      if (!priceId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "price_not_configured", message: `No price configured for plan "${plan}"` }),
          }],
          isError: true,
        };
      }

      const quantity = plan === "team" ? Math.max(1, params.quantity ?? 1) : 1;

      const session = await createCheckoutSession(env.STRIPE_SECRET_KEY, {
        customerId,
        priceId,
        quantity,
        adjustableQuantity: plan === "team",
        successUrl: `${env.APP_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${env.APP_URL}/pricing?upgrade=cancelled`,
        organizationId: org.id,
      });

      audit(env.DB, auth.organizationId, auth.apiKeyId, "subscription.checkout", "organization", auth.organizationId, { plan });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            url: session.url,
            plan,
            message: `Open this link to subscribe to the ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan ($${plan === "pro" ? "39" : "49"}/mo${plan === "team" ? " per seat" : ""}).`,
          }),
        }],
      };
    },
  );
}
