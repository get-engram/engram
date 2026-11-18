import type { Env } from "../types.js";

/**
 * Black Friday 2026 (engram#763): Pro for $27 a year, in place of $9 a month.
 *
 * The offer ends at 00:00 Eastern on Saturday 28 November 2026. Eastern is
 * on standard time that day (UTC-5), so that is 05:00 UTC. The deadline is
 * checked here, on the server, every time a checkout is started: a page left
 * open, an old email or a hand-made request gets the same answer.
 */
export const BLACK_FRIDAY = "black-friday";

/** 2026-11-28T05:00:00Z, the first instant the offer is no longer sold. */
export const BLACK_FRIDAY_ENDS_AT_MS = Date.UTC(2026, 10, 28, 5, 0, 0);

export const BLACK_FRIDAY_LOOKUP_KEY = "pro_annual_bf2026";
export const BLACK_FRIDAY_UNIT_AMOUNT = 2700; // $27.00 a year

/** Stripe's limits on a Checkout Session's expires_at, counted from creation. */
const STRIPE_MIN_SESSION_SECONDS = 30 * 60;
const STRIPE_MAX_SESSION_SECONDS = 24 * 60 * 60;

export type OfferState =
  | { open: true; priceId: string }
  | { open: false; reason: "offer_ended" | "offer_unavailable" };

/** Whether the offer can be bought right now, and at which price. */
export function blackFridayState(
  env: Pick<Env, "STRIPE_PRICE_ID_PRO_ANNUAL_BF">,
  now: number = Date.now(),
): OfferState {
  if (now >= BLACK_FRIDAY_ENDS_AT_MS) return { open: false, reason: "offer_ended" };
  const priceId = env.STRIPE_PRICE_ID_PRO_ANNUAL_BF;
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
