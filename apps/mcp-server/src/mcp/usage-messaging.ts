// User-facing copy for plan limits + usage, tailored for OAuth-connected apps
// (ChatGPT/Claude) vs first-party API-key/SDK callers. OAuth users are routed
// to their own dashboard to upgrade (their org was provisioned with the email
// they connected) — we never try to sell/charge inside the app.

const DASHBOARD = "https://getengram.app/dashboard";
const PRICING = "https://getengram.app/pricing";

export interface UsageMeter {
  used: number;
  limit: number;
  remaining: number;
}

/** Build a usage meter when the tier is limited; undefined for unlimited tiers. */
export function usageMeter(used?: number, limit?: number): UsageMeter | undefined {
  if (typeof used !== "number" || typeof limit !== "number" || limit < 0) {
    return undefined;
  }
  return { used, limit, remaining: Math.max(0, limit - used) };
}

/** Friendly message when a plan limit is hit. */
export function limitMessage(opts: {
  unit: "messages" | "conversations";
  tier?: string;
  limit?: number;
  used?: number;
  isOAuth: boolean;
}): string {
  const { unit, tier, limit, used, isOAuth } = opts;
  if (isOAuth) {
    return (
      `You've reached the free plan's monthly limit (${limit ?? "the included"} ${unit}). ` +
      `Everything so far is safely saved in Engram. ` +
      `Tell the user, warmly, that to keep saving memories they can upgrade their own Engram account: ` +
      `open ${DASHBOARD}, sign in with the email they used to connect this app, and choose Upgrade — ` +
      `the same account powers this connection, so the higher limit applies right away. ` +
      `Don't try to collect payment here; just point them to their dashboard.`
    );
  }
  return (
    `${unit === "messages" ? "Message" : "Conversation"} limit reached ` +
    `(${used ?? "?"}/${limit ?? "?"} this month on the ${tier ?? "free"} plan). ` +
    `Upgrade at ${PRICING} to continue.`
  );
}

/** A gentle heads-up once usage crosses 80%, so the user isn't surprised. */
export function approachingLimitNotice(
  meter: UsageMeter | undefined,
  isOAuth: boolean,
): string | undefined {
  if (!meter || meter.limit <= 0) return undefined;
  if (meter.used / meter.limit < 0.8) return undefined;
  const where = isOAuth
    ? `sign in at ${DASHBOARD} with the email you connected and upgrade`
    : `upgrade at ${PRICING}`;
  return (
    `${meter.used}/${meter.limit} free messages used this month (${meter.remaining} left). ` +
    `To avoid interruption, ${where}.`
  );
}

/**
 * Notice when archived (memory-window) results were withheld (engram#252).
 * Tone: nothing is lost, upgrading unlocks — never "deleted".
 */
export function retentionNotice(opts: {
  archivedCount: number;
  retentionDays: number;
  isOAuth: boolean;
}): string {
  const { archivedCount, retentionDays, isOAuth } = opts;
  const what =
    archivedCount === 1
      ? "1 older conversation matched"
      : `${archivedCount} older conversations matched`;
  const where = isOAuth
    ? `sign in at ${DASHBOARD} with the email used to connect this app and upgrade`
    : `upgrade at ${PRICING}`;
  return (
    `${what} but ${archivedCount === 1 ? "is" : "are"} archived — the free plan keeps a rolling ` +
    `${retentionDays}-day memory window. Nothing is deleted: ${where} to unlock your full history instantly.`
  );
}
