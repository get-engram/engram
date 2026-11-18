import { Hono } from "hono";
import { takeToken } from "../middleware/ip-throttle.js";
import { checkoutForOrg } from "../services/checkout.js";
import { offerSigValid } from "../services/secrets.js";
import {
  BLACK_FRIDAY,
  blackFridayState,
  offerClosedBody,
  offerSessionExpiry,
} from "../services/black-friday.js";
import type { Env } from "../types.js";

/**
 * Offer links that work without signing in (engram#763).
 *
 * The Black Friday email carries a link signed for the account it was sent
 * to. The website's /black-friday page posts that org id and signature
 * here and gets a Stripe Checkout URL for that account, so someone who has
 * only ever used Engram from inside ChatGPT or Claude can take the offer
 * without first finding their way into the website.
 *
 * What the link can do is deliberately small. It starts a checkout for one
 * free account at the offer price, and nothing else: it never opens the
 * billing portal (which shows invoices and can cancel), never reads the
 * account, and the return addresses are fixed here, not taken from the
 * request. Someone holding a forwarded copy could pay for that account's
 * plan, which harms nobody.
 *
 * POST only. Mail scanners fetch every link in a message, and a GET must
 * not create Stripe customers or sessions.
 */
export const offers = new Hono<{ Bindings: Env }>();

offers.post("/black-friday/checkout", async (c) => {
  const body = await c.req
    .json<{ org?: unknown; sig?: unknown }>()
    .catch(() => ({}) as { org?: unknown; sig?: unknown });
  const org = typeof body.org === "string" ? body.org : "";
  const sig = typeof body.sig === "string" ? body.sig : "";
  if (!org || !(await offerSigValid(c.env, BLACK_FRIDAY, org, sig))) {
    return c.json(
      { error: "invalid_link", message: "This link is not valid. Sign in to take the offer." },
      403,
    );
  }
  // Throttled per account, not per IP: the website makes this call, so
  // every buyer arrives from its address and would share one bucket. A bad
  // signature stops above, before anything is created.
  if (!takeToken(`offer-checkout:${org}`, 5, 60_000)) {
    c.header("Retry-After", "12");
    return c.json(
      { error: "rate_limited", message: "Too many tries. Wait a minute and try again." },
      429,
    );
  }

  const offer = blackFridayState(c.env);
  if (!offer.open) {
    return c.json(offerClosedBody(offer.reason), offer.reason === "offer_ended" ? 410 : 503);
  }

  const row = await c.env.DB.prepare("SELECT tier, deleted_at FROM organizations WHERE id = ?")
    .bind(org)
    .first<{ tier: string; deleted_at: string | null }>();
  if (!row || row.deleted_at) return c.json({ error: "organization_not_found" }, 404);
  if (row.tier !== "free") {
    return c.json(
      { error: "already_subscribed", message: "This account already has a paid plan." },
      409,
    );
  }

  const outcome = await checkoutForOrg(c.env, org, {
    priceId: offer.priceId,
    successUrl: `${c.env.APP_URL}/upgrade/success?session_id={CHECKOUT_SESSION_ID}`,
    // Back to the page with the same link, so "Back" from Stripe leaves
    // the reader able to try again without signing in. Both values were
    // just verified: the signature is 64 hex characters and covers the id.
    cancelUrl: `${c.env.APP_URL}/black-friday?org=${encodeURIComponent(org)}&sig=${sig}&upgrade=cancelled`,
    expiresAt: offerSessionExpiry(),
    allowPromotionCodes: false,
    offer: BLACK_FRIDAY,
  });
  if (outcome.kind === "error") return c.json(outcome.body, outcome.status);
  if (outcome.kind === "already_subscribed") {
    // No portal link here: that needs a signed-in owner.
    return c.json(
      { error: "already_subscribed", message: "This account already has a paid plan." },
      409,
    );
  }
  return c.json({ url: outcome.url, session_id: outcome.sessionId, plan: "pro", offer: BLACK_FRIDAY });
});
