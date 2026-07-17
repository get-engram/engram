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
    const planName = tier && tier !== "free" ? `${tier} plan's` : "free plan's";
    const remedy =
      tier && tier !== "free"
        ? `open ${DASHBOARD}, sign in with the email they used to connect this app, and manage their plan (add capacity or seats)`
        : `open ${DASHBOARD}, sign in with the email they used to connect this app, and choose Upgrade`;
    return (
      `You've reached the ${planName} monthly limit (${limit ?? "the included"} ${unit}). ` +
      `Everything so far is safely saved in Engram. ` +
      `Tell the user, warmly, that to keep saving memories they can ${remedy} — ` +
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

/**
 * Warm copy when the lifetime storage cap is reached (engram#275).
 * Nothing is ever deleted or expired — saving NEW memories pauses until
 * the user upgrades for more space or deletes old conversations.
 */
export function storageFullMessage(opts: {
  limit?: number;
  isOAuth: boolean;
}): string {
  const { limit, isOAuth } = opts;
  const size = limit ? `${limit.toLocaleString("en-US")} messages` : "its current size";
  if (isOAuth) {
    return (
      `Engram's memory is full (${size}). Everything already saved is safe, ` +
      `searchable, and never expires. Tell the user, warmly: to keep saving new ` +
      `memories they can upgrade for more space — open ${DASHBOARD} and sign in ` +
      `with the email they used to connect this app — or delete old conversations ` +
      `to free room. Don't try to collect payment here; just point them to their dashboard.`
    );
  }
  return (
    `Engram's memory is full (${size}). Everything saved stays safe and searchable. ` +
    `Upgrade at ${PRICING} for more space, or delete old conversations to free room.`
  );
}

/**
 * Early warning once the storage cap crosses 80%, so "memory full" is
 * never a surprise.
 */
export function approachingStorageNotice(
  meter: UsageMeter | undefined,
  isOAuth: boolean,
): string | undefined {
  if (!meter || meter.limit <= 0) return undefined;
  if (meter.used / meter.limit < 0.8) return undefined;
  const where = isOAuth
    ? `sign in at ${DASHBOARD} with the email you connected and upgrade for more space`
    : `upgrade at ${PRICING} for more space`;
  return (
    `${meter.used.toLocaleString("en-US")}/${meter.limit.toLocaleString("en-US")} messages of memory used ` +
    `(${meter.remaining.toLocaleString("en-US")} left). Nothing ever expires — but to keep saving new ` +
    `memories past the limit, ${where}, or delete old conversations to free room.`
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
    `${meter.used}/${meter.limit} included messages used this month (${meter.remaining} left). ` +
    `To avoid interruption, ${where}.`
  );
}
