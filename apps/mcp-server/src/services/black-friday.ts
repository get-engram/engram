import type { Env } from "../types.js";

/**
 * Black Friday 2026 (engram#763): one year of Pro for one payment of $27,
 * in place of $9 a month.
 *
 * It is a single payment, not a subscription. Nothing renews and nobody is
 * charged a second time: the payment grants Pro until a year later, and
 * then the account goes back to Free unless its owner subscribes.
 *
 * The offer ends at 00:00 Eastern on Saturday 28 November 2026. Eastern is
 * on standard time that day (UTC-5), so that is 05:00 UTC. The deadline is
 * checked here, on the server, every time a checkout is started: a page left
 * open, an old email or a hand-made request gets the same answer.
 */
export const BLACK_FRIDAY = "black-friday";

/** 2026-11-28T05:00:00Z, the first instant the offer is no longer sold. */
export const BLACK_FRIDAY_ENDS_AT_MS = Date.UTC(2026, 10, 28, 5, 0, 0);

export const BLACK_FRIDAY_LOOKUP_KEY = "pro_one_year_bf2026";
export const BLACK_FRIDAY_UNIT_AMOUNT = 2700; // $27.00, once

/**
 * The offer's first form, a $27-a-year subscription price, which was never
 * sold. The "ensure price" endpoint switches it off.
 */
export const BLACK_FRIDAY_RETIRED_LOOKUP_KEY = "pro_annual_bf2026";

/** What Checkout shows beside the pay button. */
export const BLACK_FRIDAY_CHECKOUT_NOTE =
  "One payment of $27 for one year of Engram Pro. It does not renew: after a year your account goes back to the free plan unless you subscribe again.";

/** Stripe's limits on a Checkout Session's expires_at, counted from creation. */
const STRIPE_MIN_SESSION_SECONDS = 30 * 60;
const STRIPE_MAX_SESSION_SECONDS = 24 * 60 * 60;

export type OfferState =
  | { open: true; priceId: string }
  | { open: false; reason: "offer_ended" | "offer_unavailable" };

/** Whether the offer can be bought right now, and at which price. */
export function blackFridayState(
  env: Pick<Env, "STRIPE_PRICE_ID_PRO_YEAR_BF">,
  now: number = Date.now(),
): OfferState {
  if (now >= BLACK_FRIDAY_ENDS_AT_MS) return { open: false, reason: "offer_ended" };
  const priceId = env.STRIPE_PRICE_ID_PRO_YEAR_BF;
  if (!priceId) return { open: false, reason: "offer_unavailable" };
  return { open: true, priceId };
}

/** What a caller is told when the offer cannot be bought. */
export function offerClosedBody(reason: "offer_ended" | "offer_unavailable") {
  return reason === "offer_ended"
    ? { error: reason, message: "The Black Friday offer ended on November 28. Pro is available at the regular price." }
    : { error: reason, message: "The Black Friday offer is not available right now." };
}

/**
 * When a Checkout Session for the offer stops being payable, in Unix
 * seconds, or undefined to keep Stripe's own 24 hours.
 *
 * A session started in the last day of the offer expires at the deadline
 * instead of a day later, so the offer price cannot be paid long after it
 * ended. Stripe refuses an expiry under 30 minutes away, so a session
 * started in the final half hour runs its 30 minutes.
 */
export function offerSessionExpiry(now: number = Date.now()): number | undefined {
  const nowSec = Math.floor(now / 1000);
  const deadlineSec = Math.floor(BLACK_FRIDAY_ENDS_AT_MS / 1000);
  // A margin on both limits: Stripe counts from when it receives the request.
  if (deadlineSec - nowSec >= STRIPE_MAX_SESSION_SECONDS - 120) return undefined;
  return Math.max(deadlineSec, nowSec + STRIPE_MIN_SESSION_SECONDS + 120);
}

/** What a paid offer session came to. */
export type OfferPaymentOutcome =
  /** Pro is granted until `endsAt` (UTC, "YYYY-MM-DD HH:MM:SS"). */
  | { kind: "granted"; orgId: string; endsAt: string }
  /** Not a payment for this offer, or not paid yet: nothing to do. */
  | { kind: "ignored"; reason: "not_offer" | "not_paid" }
  /** Paid, but the plan could not be given. Needs a person: see the log. */
  | { kind: "not_applied"; reason: "no_org" | "org_missing" | "other_plan"; orgId?: string };

/**
 * Give the year of Pro a paid Black Friday Checkout Session bought.
 *
 * Called for every `checkout.session.completed`. Safe to run any number of
 * times for one session: the first run records the purchase and fixes its
 * end date, later runs read that date back.
 *
 * The plan is held by `grace_ends_at`, which the rest of billing already
 * respects: the Stripe sync and a stray cancellation event leave an org
 * with a future date alone, and the grace cron returns it to Free when the
 * date passes. No subscription exists, so there is nothing to renew.
 *
 * A D1 failure throws, so the webhook answers 500 and Stripe sends the
 * event again. A payment that can never be applied (the org is gone, or is
 * on Team) is logged as an error and not retried: retrying cannot fix it.
 */
export async function applyOfferPayment(
  env: Pick<Env, "DB">,
  session: Record<string, unknown>,
): Promise<OfferPaymentOutcome> {
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (session.mode !== "payment" || meta.offer !== BLACK_FRIDAY) {
    return { kind: "ignored", reason: "not_offer" };
  }
  if (session.payment_status !== "paid") return { kind: "ignored", reason: "not_paid" };

  const sessionId = String(session.id ?? "");
  const orgId = typeof meta.organization_id === "string" ? meta.organization_id : "";
  if (!sessionId || !orgId) {
    console.error(`[black-friday] PAID BUT NOT APPLIED: session ${sessionId || "?"} names no organization`);
    return { kind: "not_applied", reason: "no_org" };
  }

  const org = await env.DB.prepare("SELECT tier, deleted_at FROM organizations WHERE id = ?")
    .bind(orgId)
    .first<{ tier: string; deleted_at: string | null }>();
  if (!org || org.deleted_at) {
    console.error(`[black-friday] PAID BUT NOT APPLIED: session ${sessionId}, org ${orgId} does not exist`);
    return { kind: "not_applied", reason: "org_missing", orgId };
  }
  // Checkout refuses anyone who is not on Free, so this is an account that
  // changed plan while its checkout was open. Pro over Team would take
  // seats away; leave the plan alone and let a person sort out the $27.
  if (org.tier !== "free" && org.tier !== "pro") {
    console.error(`[black-friday] PAID BUT NOT APPLIED: session ${sessionId}, org ${orgId} is on ${org.tier}`);
    return { kind: "not_applied", reason: "other_plan", orgId };
  }

  await env.DB.prepare(
    `INSERT INTO prepaid_plans (session_id, org_id, offer, tier, amount_total, currency, ends_at)
     VALUES (?, ?, ?, 'pro', ?, ?, datetime('now', '+1 year'))
     ON CONFLICT (session_id) DO NOTHING`,
  )
    .bind(
      sessionId,
      orgId,
      BLACK_FRIDAY,
      typeof session.amount_total === "number" ? session.amount_total : null,
      typeof session.currency === "string" ? session.currency : null,
    )
    .run();
  const plan = await env.DB.prepare("SELECT ends_at FROM prepaid_plans WHERE session_id = ?")
    .bind(sessionId)
    .first<{ ends_at: string }>();
  if (!plan) throw new Error(`prepaid plan for session ${sessionId} was not recorded`);

  // Never shortens a later date already on the org (an internal account, or
  // a longer grant). A returning customer's old churn stamp is cleared.
  await env.DB.prepare(
    `UPDATE organizations
        SET tier = 'pro',
            grace_ends_at = CASE
              WHEN grace_ends_at IS NOT NULL AND grace_ends_at > ? THEN grace_ends_at
              ELSE ?
            END,
            churned_at = NULL,
            cancel_at_period_end = 0
      WHERE id = ?`,
  )
    .bind(plan.ends_at, plan.ends_at, orgId)
    .run();
  console.log(`[black-friday] org ${orgId} has Pro until ${plan.ends_at} (session ${sessionId})`);
  return { kind: "granted", orgId, endsAt: plan.ends_at };
}
