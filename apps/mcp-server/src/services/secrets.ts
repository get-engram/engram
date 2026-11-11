import type { Env } from "../types.js";

/**
 * Which secret the worker uses for what (engram#456).
 *
 * ADMIN_SECRET used to do every job here: it was the owner's admin bearer for
 * this worker, the bearer the worker shows engram-web for each email and
 * report it asks it to send, and the key that signs the unsubscribe link in
 * every lifecycle email. A copy of it taken from any one of those places
 * opened all the others. Each job now has a secret of its own:
 *
 *   ADMIN_SECRET          the owner's admin access to this worker (the
 *                         /admin routes and admin API calls), nothing else
 *   INTERNAL_CRON_SECRET  the bearer for engram-web's email and report
 *                         routes (websiteBearer)
 *   UNSUBSCRIBE_HMAC_KEY  signs and checks unsubscribe links (lifecycleMail,
 *                         unsubscribeSigValid)
 *   UNSUBSCRIBE_HMAC_KEY_PREVIOUS
 *                         the signing key before the last change, so a link
 *                         already mailed keeps working. Remove it once the
 *                         last email signed with it is 60 days old (CAN-SPAM
 *                         asks for 30).
 *
 * Until INTERNAL_CRON_SECRET or UNSUBSCRIBE_HMAC_KEY is set, ADMIN_SECRET
 * stands in for it, as it always has: this deploys before the new secrets
 * exist, and nothing changes until they do. Once UNSUBSCRIBE_HMAC_KEY is set,
 * a link signed with ADMIN_SECRET still works only through
 * UNSUBSCRIBE_HMAC_KEY_PREVIOUS, so that gets ADMIN_SECRET's value first.
 *
 * An empty value counts as unset.
 */

function secret(value: string | undefined): string | null {
  return value ? value : null;
}

/**
 * The bearer for engram-web's email and report routes: INTERNAL_CRON_SECRET,
 * or ADMIN_SECRET until that is set. Null when neither is: send nothing.
 */
export function websiteBearer(env: Env): string | null {
  return secret(env.INTERNAL_CRON_SECRET) ?? secret(env.ADMIN_SECRET);
}

/** The key that signs unsubscribe links: UNSUBSCRIBE_HMAC_KEY, or ADMIN_SECRET until that is set. */
function signingKey(env: Env): string | null {
  return secret(env.UNSUBSCRIBE_HMAC_KEY) ?? secret(env.ADMIN_SECRET);
}

/** The route that takes an unsubscribe link (index.ts). */
const UNSUBSCRIBE_URL = "https://mcp.getengram.app/email/unsubscribe";

function hmacKey(key: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    usage,
  ]);
}

/** What a link's signature covers: the org it opts out of lifecycle email. */
function signed(orgId: string): Uint8Array {
  return new TextEncoder().encode(`digest:${orgId}`);
}

/**
 * The signature in an org's unsubscribe link, so the link needs no login:
 * the hex HMAC-SHA256 of `digest:<org id>`. Links mailed before engram#456
 * have the same form, signed with ADMIN_SECRET.
 */
export async function unsubscribeSig(orgId: string, key: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), signed(orgId));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An org's unsubscribe link, signed with `key`. */
async function signedLink(orgId: string, key: string): Promise<string> {
  return `${UNSUBSCRIBE_URL}?org=${encodeURIComponent(orgId)}&sig=${await unsubscribeSig(orgId, key)}`;
}

/**
 * An org's unsubscribe link, signed with the signing key, for an email sent
 * outside the crons (GET /admin/unsubscribe-link, engram#735). The same
 * link the crons put in their emails. Null when no signing key is set.
 */
export async function unsubscribeUrl(env: Env, orgId: string): Promise<string | null> {
  const key = signingKey(env);
  return key === null ? null : signedLink(orgId, key);
}

/** What the worker needs to ask engram-web for a lifecycle email. */
export interface LifecycleMail {
  /** For the Authorization header. */
  bearer: string;
  /** The signed unsubscribe link for an org. */
  unsubscribeUrl(orgId: string): Promise<string>;
}

/**
 * For the lifecycle emails (the weekly digest and the nudges): the bearer
 * for engram-web and each org's unsubscribe link. Null when either is
 * missing, so none of these emails is ever sent without a link that works.
 */
export function lifecycleMail(env: Env): LifecycleMail | null {
  const bearer = websiteBearer(env);
  const key = signingKey(env);
  if (bearer === null || key === null) return null;
  return { bearer, unsubscribeUrl: (orgId) => signedLink(orgId, key) };
}

/**
 * The emails that carry an unsubscribe link, by the type engram-web logs
 * each one under in email_log: the weekly digest, the nudges and the
 * plan-changed notice. An unsubscribe is credited only to one of these
 * (index.ts). A welcome email or a team invite has no link to click.
 */
export const UNSUBSCRIBE_LINK_EMAILS: readonly string[] = [
  "weekly-digest",
  "activation-nudge",
  "import-nudge",
  "maxout-nudge",
  "recall-nudge",
  "plan-changed",
];

/**
 * Whether `sig` signs an unsubscribe link for `orgId`, with the signing key
 * or UNSUBSCRIBE_HMAC_KEY_PREVIOUS. WebCrypto's verify compares in constant
 * time. ADMIN_SECRET checks a link only while it is the signing key.
 */
export async function unsubscribeSigValid(env: Env, orgId: string, sig: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const mac = new Uint8Array(32);
  for (let i = 0; i < mac.length; i++) mac[i] = parseInt(sig.slice(i * 2, i * 2 + 2), 16);
  const keys = [signingKey(env), secret(env.UNSUBSCRIBE_HMAC_KEY_PREVIOUS)].filter((k): k is string => k !== null);
  // Every key, so how long this takes doesn't say which one signed it.
  const valid = await Promise.all(
    keys.map(async (k) => crypto.subtle.verify("HMAC", await hmacKey(k, "verify"), mac, signed(orgId))),
  );
  return valid.includes(true);
}
