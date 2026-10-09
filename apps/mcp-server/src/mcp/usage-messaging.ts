// User-facing copy for plan limits + usage, tailored for OAuth-connected apps
// (ChatGPT/Claude) vs first-party API-key/SDK callers.
//
// Connector (isOAuth) copy is FACTUAL ONLY — it states the account's state and
// where capacity is managed, with no URLs, no scripted reply wording ("tell the
// user, warmly…"), and no directives aimed at the model. Both app directories
// rejected the listing for exactly that (Sept 2026), and Anthropic was explicit
// that an instruction moved into a tool output is still an instruction. The
// contract test scans these strings; keep them descriptive.
//
// First-party copy (API keys / SDK — the user's own agents) may carry a login
// URL: there is no app-store reviewer on that surface.

const PRICING = "https://getengram.app/pricing";
// API-key/CLI users may have no email on the account — the dashboard's
// key login ("Sign in with your API key" at /login) is their upgrade path.
const KEY_LOGIN =
  "log in at https://getengram.app/login with your API key (choose \"Sign in with your API key\") and upgrade from your dashboard";

export interface UsageMeter {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Render a 10-segment progress bar like "[████████░░] 82%" — readable in
 * chat surfaces (ChatGPT relays it verbatim) and terminals alike.
 */
export function meterBar(used?: number, limit?: number): string | undefined {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) {
    return undefined;
  }
  const pct = Math.min(100, Math.round((used / limit) * 100));
  // Any nonzero usage shows at least one filled segment so the bar never
  // reads as empty (an all-░ bar renders as a blank grey pill in many fonts).
  const filled = Math.max(used > 0 ? 1 : 0, Math.min(10, Math.round(pct / 10)));
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${pct}%`;
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
    const plan = tier && tier !== "free" ? tier : "free";
    return (
      `Monthly limit reached on the ${plan} plan (${limit ?? "the included"} ${unit} this month). ` +
      `Everything saved so far is stored and searchable. ` +
      `Additional monthly capacity is managed from the Engram account that was used to connect this app.`
    );
  }
  return (
    `${unit === "messages" ? "Message" : "Conversation"} limit reached ` +
    `(${used ?? "?"}/${limit ?? "?"} this month on the ${tier ?? "free"} plan). ` +
    `To continue, ${KEY_LOGIN}.`
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
      `Engram's memory is full (${size}). Everything already saved stays stored, ` +
      `searchable, and never expires. Saving new memories resumes when capacity is ` +
      `added from the Engram account that was used to connect this app, or when older ` +
      `conversations are deleted.`
    );
  }
  return (
    `Engram's memory is full (${size}). Everything saved stays safe and searchable. ` +
    `For more space, ${KEY_LOGIN} — Pro is $9/mo for 1,000,000 messages — or delete old conversations to free room.`
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
  const usedStr = `${meter.used.toLocaleString("en-US")}/${meter.limit.toLocaleString("en-US")} messages of memory used ` +
    `(${meter.remaining.toLocaleString("en-US")} left). Nothing ever expires`;
  if (isOAuth) {
    return (
      `${usedStr}. Past the limit, saving new memories pauses until capacity is added ` +
      `from the Engram account that was used to connect this app, or older conversations are deleted.`
    );
  }
  return (
    `${usedStr} — but to keep saving new memories past the limit, ` +
    `${KEY_LOGIN} ($9/mo for 1,000,000 messages), or delete old conversations to free room.`
  );
}

/** A gentle heads-up once usage crosses 80%, so the user isn't surprised. */
export function approachingLimitNotice(
  meter: UsageMeter | undefined,
  isOAuth: boolean,
): string | undefined {
  if (!meter || meter.limit <= 0) return undefined;
  if (meter.used / meter.limit < 0.8) return undefined;
  const usedStr = `${meter.used}/${meter.limit} included messages used this month (${meter.remaining} left).`;
  if (isOAuth) {
    return (
      `${usedStr} Past the monthly limit, saving pauses until the next cycle ` +
      `or additional capacity is added from the Engram account that was used to connect this app.`
    );
  }
  return `${usedStr} To avoid interruption, ${KEY_LOGIN}.`;
}

/**
 * The `note` field of memory_status. Connector copy names where capacity is
 * managed but carries no URL; first-party copy may point at pricing.
 */
export function storageNote(storageLimit: number, isOAuth: boolean): string {
  if (storageLimit <= 0) {
    return "Memory never expires. This plan has unlimited storage.";
  }
  return isOAuth
    ? "Memory never expires — deleting conversations frees space. Additional capacity is available on higher plans, managed from the Engram account that was used to connect this app."
    : "Memory never expires — deleting conversations frees space. More room: upgrade at getengram.app/pricing.";
}
