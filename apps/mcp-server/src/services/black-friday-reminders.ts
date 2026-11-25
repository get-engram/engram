import type { Env } from "../types.js";
import { lifecycleMail, type LifecycleMail } from "./secrets.js";
import { BLACK_FRIDAY } from "./black-friday.js";
import {
  BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS,
  batchLimit,
  recorded,
  sendBatch,
  sendRefusal,
  sendTestCopy,
  type CampaignError,
  type CampaignResult,
  type Recipient,
} from "./black-friday-campaign.js";
import { FINISH_SIGNUP, FINISH_SIGNUP_RESEND } from "./finish-signup-campaign.js";
import { listRows } from "./stripe-list.js";

/**
 * The Black Friday reminders (engram#787): three emails about the offer,
 * each to a small group of free accounts and each through its own route on
 * engram-web (engram-web#339).
 *
 * - black-friday-unpaid: a paid plan that Stripe cancelled because a
 *   payment failed. The account is on the Free plan now.
 * - black-friday-checkout: an account whose latest checkout was left
 *   unfinished (it expired, or was still open three hours on) and that has
 *   not finished one since.
 * - black-friday-unused: an account made since the first Black Friday email
 *   went out that has saved nothing (at most one conversation, with at most
 *   one message: the admin's "never used"), and whose address no Black
 *   Friday or finish-sign-up email has gone to. Counted by address: an
 *   address with any account that has been used is left out.
 *
 * Who is in each group is fixed at REMINDER_CUTOFF_MS: only a checkout, a
 * cancellation or an account from before then counts. After it a group can
 * only shrink (a purchase, an unsubscribe, a send), so the cron may send
 * them (campaign-runs.ts). They are not sent before it, and not on the
 * offer's last day, when the last-day email goes out instead.
 *
 * Every account must also be one any Black Friday email may go to: on the
 * Free plan, not deleted or internal, subscribed, not an address that also
 * belongs to a paid account or to one that unsubscribed, and not a buyer of
 * the offer.
 *
 * One email per person across the three: none goes to an address any of
 * them has already been sent to, and one campaign runs at a time. They are
 * started one after another, in BLACK_FRIDAY_REMINDERS order, so someone in
 * two of the groups gets the first one's email.
 */

/** The cancelled-for-non-payment reminder's campaign value, and engram-web's route name for it. */
export const BLACK_FRIDAY_UNPAID = "black-friday-unpaid";
/** The unfinished-checkout reminder's campaign value, and engram-web's route name for it. */
export const BLACK_FRIDAY_CHECKOUT = "black-friday-checkout";
/** The new-and-unused reminder's campaign value, and engram-web's route name for it. */
export const BLACK_FRIDAY_UNUSED = "black-friday-unused";
/** The reminders, in the order they are sent. */
export const BLACK_FRIDAY_REMINDERS = [BLACK_FRIDAY_UNPAID, BLACK_FRIDAY_CHECKOUT, BLACK_FRIDAY_UNUSED] as const;
export type BlackFridayReminder = (typeof BLACK_FRIDAY_REMINDERS)[number];

/**
 * When the reminders' groups are fixed, and the first moment they may be
 * sent: 06:00 UTC on November 25, 2026.
 */
export const REMINDER_CUTOFF_MS = Date.UTC(2026, 10, 25, 6, 0, 0);
/** REMINDER_CUTOFF_MS as D1 writes a time, for comparing with created_at. */
const CUTOFF_SQL = new Date(REMINDER_CUTOFF_MS).toISOString().replace("T", " ").slice(0, 19);
/** REMINDER_CUTOFF_MS in Stripe's seconds. */
const CUTOFF_S = Math.floor(REMINDER_CUTOFF_MS / 1000);
/** When the first Black Friday email started going out. The unused reminder is for accounts made since. */
export const UNUSED_FROM = "2026-11-18 04:26:00";
/** A checkout still open this long before the cutoff was left, not still being filled in. */
const STALE_OPEN_S = 3 * 60 * 60;
/** Pages of a Stripe list, at 100 rows a page, before it is refused as too long to be the list we mean. */
const MAX_PAGES = 20;
/** Accounts per eligibility query, so its one bound list stays small. */
const CHUNK = 100;

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * WHERE terms for an account (o) any of the reminders may go to.
 * ?2, ?3 and ?4: the three reminders' campaign values. No subquery yields
 * NULL, so NOT IN never leaves everyone out.
 */
const ELIGIBLE = `
    o.deleted_at IS NULL
    AND o.tier = 'free'
    AND o.email IS NOT NULL
    AND trim(o.email) != ''
    AND o.digest_opt_out = 0
    AND COALESCE(o.referral_source, '') != 'internal'
    AND lower(trim(o.email)) NOT IN (
      SELECT lower(trim(email)) FROM organizations
      WHERE email IS NOT NULL AND deleted_at IS NULL AND tier != 'free')
    AND lower(trim(o.email)) NOT IN (
      SELECT lower(trim(email)) FROM organizations
      WHERE email IS NOT NULL AND digest_opt_out = 1)
    AND o.id NOT IN (SELECT org_id FROM prepaid_plans)
    AND lower(trim(o.email)) NOT IN (
      SELECT lower(trim(b.email)) FROM prepaid_plans p JOIN organizations b ON b.id = p.org_id
      WHERE b.email IS NOT NULL)
    AND lower(trim(o.email)) NOT IN (SELECT email FROM email_opt_outs)
    AND lower(trim(o.email)) NOT IN (
      SELECT email FROM campaign_sends WHERE campaign IN (?2, ?3, ?4))`;

/** Which of a list of accounts (?1, a JSON array of ids) a reminder may go to. */
const LISTED_OWED = `
  SELECT o.id, o.name, o.email, lower(trim(o.email)) AS address, julianday(o.created_at) AS jd
  FROM json_each(?1) j
  JOIN organizations o ON o.id = j.value
  WHERE ${ELIGIBLE}`;

/**
 * The accounts owed the unused reminder. ?1 the first Black Friday email's
 * campaign, ?5 and ?6 the finish-sign-up emails', ?7 and ?8 the window the
 * account was made in.
 *
 * `used` holds every address with an account that has two conversations or
 * more, or one with more than one message. It reads at most two
 * conversations of an account to count them.
 */
const UNUSED_OWED = `
  WITH fresh AS MATERIALIZED (
    SELECT o.id, o.name, o.email, lower(trim(o.email)) AS address, julianday(o.created_at) AS jd
    FROM organizations o
    WHERE ${ELIGIBLE}
      AND julianday(o.created_at) >= julianday(?7)
      AND julianday(o.created_at) < julianday(?8)
      AND lower(trim(o.email)) NOT IN (
        SELECT email FROM campaign_sends WHERE campaign IN (?1, ?5, ?6))
  ),
  same_address AS MATERIALIZED (
    SELECT id, lower(trim(email)) AS address FROM organizations
    WHERE deleted_at IS NULL AND email IS NOT NULL
      AND lower(trim(email)) IN (SELECT address FROM fresh)
  ),
  used AS MATERIALIZED (
    SELECT DISTINCT a.address FROM same_address a
    WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM conversations c WHERE c.organization_id = a.id LIMIT 2)) > 1
       OR EXISTS (SELECT 1 FROM conversations c WHERE c.organization_id = a.id AND c.message_count > 1)
  )
  SELECT id, name, email, address, jd FROM fresh
  WHERE address NOT IN (SELECT address FROM used)
  ORDER BY address, jd, id`;

/** An account a reminder may go to, with when it was made (a Julian day number). */
interface Candidate extends Recipient {
  jd: number | null;
}

/** The Checkout Session fields read here. */
interface StripeCheckoutSession {
  id: string;
  status: string | null;
  created: number;
  metadata?: Record<string, string> | null;
}

/** The Subscription fields read here. */
interface StripeSubscription {
  id: string;
  canceled_at: number | null;
  cancellation_details?: { reason?: string | null } | null;
  metadata?: Record<string, string> | null;
}

/**
 * The accounts whose latest checkout before the cutoff was left unfinished:
 * it expired, or was still open STALE_OPEN_S before the cutoff. An account
 * that finished a checkout at or after that one's start, at any time, is
 * left out. A checkout names its account in metadata.organization_id
 * (createCheckoutSession); one without it is not counted.
 */
async function checkoutOrgs(key: string): Promise<string[]> {
  const unfinished = new Map<string, number>();
  const finished = new Map<string, number>();
  for await (const s of listRows<StripeCheckoutSession>(key, "/v1/checkout/sessions", {}, MAX_PAGES)) {
    const org = s.metadata?.organization_id;
    if (!org || typeof s.created !== "number") continue;
    if (s.status === "complete") {
      finished.set(org, Math.max(finished.get(org) ?? Number.NEGATIVE_INFINITY, s.created));
      continue;
    }
    if (s.created >= CUTOFF_S) continue;
    const left = s.status === "expired" || (s.status === "open" && s.created <= CUTOFF_S - STALE_OPEN_S);
    if (left) unfinished.set(org, Math.max(unfinished.get(org) ?? Number.NEGATIVE_INFINITY, s.created));
  }
  return [...unfinished]
    .filter(([org, at]) => (finished.get(org) ?? Number.NEGATIVE_INFINITY) < at)
    .map(([org]) => org);
}

/**
 * The accounts with a subscription Stripe cancelled before the cutoff
 * because a payment failed. Whether the account is on the Free plan now is
 * D1's to say (LISTED_OWED).
 */
async function unpaidOrgs(key: string): Promise<string[]> {
  const orgs = new Set<string>();
  for await (const s of listRows<StripeSubscription>(key, "/v1/subscriptions", { status: "canceled" }, MAX_PAGES)) {
    const org = s.metadata?.organization_id;
    if (!org) continue;
    if (s.cancellation_details?.reason !== "payment_failed") continue;
    if (typeof s.canceled_at !== "number" || s.canceled_at >= CUTOFF_S) continue;
    orgs.add(org);
  }
  return [...orgs];
}

/** Which of `ids` a reminder may go to. */
async function eligibleOf(env: Env, ids: string[]): Promise<Candidate[]> {
  const rows: Candidate[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = await env.DB.prepare(LISTED_OWED)
      .bind(JSON.stringify(ids.slice(i, i + CHUNK)), ...BLACK_FRIDAY_REMINDERS)
      .all<Candidate>();
    rows.push(...(chunk.results ?? []));
  }
  return rows;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * One account per address: the address's oldest account, by when it was
 * made, then by id. In address order, so a send's order does not depend on
 * how Stripe or D1 listed them.
 */
function onePerAddress(rows: Candidate[]): Recipient[] {
  const sorted = [...rows].sort(
    (a, b) => compare(a.address, b.address) || (a.jd ?? 0) - (b.jd ?? 0) || compare(a.id, b.id),
  );
  const people: Recipient[] = [];
  for (const r of sorted) {
    if (people.length > 0 && people[people.length - 1].address === r.address) continue;
    people.push({ id: r.id, name: r.name, email: r.email, address: r.address });
  }
  return people;
}

/** Everyone still owed `campaign`, one account per address. Throws when Stripe or D1 cannot say. */
async function owedOf(env: Env, campaign: BlackFridayReminder): Promise<Recipient[]> {
  if (campaign === BLACK_FRIDAY_UNUSED) {
    const rows = await env.DB.prepare(UNUSED_OWED)
      .bind(BLACK_FRIDAY, ...BLACK_FRIDAY_REMINDERS, FINISH_SIGNUP, FINISH_SIGNUP_RESEND, UNUSED_FROM, CUTOFF_SQL)
      .all<Candidate>();
    return onePerAddress(rows.results ?? []);
  }
  const ids =
    campaign === BLACK_FRIDAY_CHECKOUT ? await checkoutOrgs(env.STRIPE_SECRET_KEY) : await unpaidOrgs(env.STRIPE_SECRET_KEY);
  return onePerAddress(await eligibleOf(env, ids));
}

const NO_STRIPE: CampaignError = {
  error: "stripe_not_configured",
  message: "STRIPE_SECRET_KEY is not set, so who is owed this email cannot be read; nothing was sent.",
  status: 500,
};

/**
 * Why `campaign` may not be sent at `now`, or null when it may. Everything
 * that stops any Black Friday email stops it. The unpaid and checkout
 * reminders read Stripe, so they need its key. And none goes before its
 * group is fixed, or on the offer's last day.
 */
export function blackFridayReminderRefusal(
  env: Env,
  campaign: BlackFridayReminder,
  now = Date.now(),
): CampaignError | null {
  const refusal = sendRefusal(env, now);
  if (refusal) return refusal;
  if (campaign !== BLACK_FRIDAY_UNUSED && !env.STRIPE_SECRET_KEY) return NO_STRIPE;
  if (now < REMINDER_CUTOFF_MS) {
    return {
      error: "too_early",
      message: `The reminders go out from ${iso(REMINDER_CUTOFF_MS)}, once who gets them is fixed; nothing was sent.`,
      status: 409,
    };
  }
  if (now >= BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS) {
    return {
      error: "too_late",
      message: `The reminders are not sent on the offer's last day, from ${iso(BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS)}; nothing was sent.`,
      status: 409,
    };
  }
  return null;
}

/**
 * Count who is owed a reminder, or send its next batch. `deadline` (ms
 * since the epoch) stops a batch from starting another send after it. Only
 * the cron sends it, through campaign-runs.ts; /admin can count it, start
 * the run and pause it.
 *
 * Throws when Stripe or D1 cannot list who is owed it, with a message that
 * holds no key, address or id.
 */
export async function runBlackFridayReminder(
  env: Env,
  opts: { campaign: BlackFridayReminder; dryRun?: boolean; limit?: number; now?: number; deadline?: number },
): Promise<CampaignResult | CampaignError> {
  const { campaign } = opts;
  if (opts.dryRun) {
    // Counting reads Stripe too, but is not refused for the time.
    if (campaign !== BLACK_FRIDAY_UNUSED && !env.STRIPE_SECRET_KEY) return NO_STRIPE;
  } else {
    const refusal = blackFridayReminderRefusal(env, campaign, opts.now);
    if (refusal) return refusal;
  }
  const owed = await owedOf(env, campaign);
  if (opts.dryRun) {
    return {
      dry_run: true,
      owed: owed.length,
      sent: 0,
      skipped: 0,
      failed: 0,
      stopped: false,
      recorded: await recorded(env, campaign),
    };
  }
  const mail = lifecycleMail(env) as LifecycleMail;
  const result = await sendBatch(
    env,
    mail,
    campaign,
    owed.slice(0, batchLimit(opts.limit)),
    opts.deadline,
    `/api/email/${campaign}`,
  );
  return { dry_run: false, owed: owed.length, ...result, recorded: await recorded(env, campaign) };
}

/**
 * A test copy of a reminder, to hello@getengram.app only, with that
 * address's own account's name and signed links. It may go before the
 * cutoff, so the email can be read before it goes out, and on any day while
 * the offer is open. Nothing is claimed in campaign_sends, so it can be
 * repeated and leaves nobody out of the send.
 */
export function sendBlackFridayReminderTest(
  env: Env,
  campaign: BlackFridayReminder,
  to: string,
  now?: number,
): Promise<{ sent: true } | CampaignError> {
  return sendTestCopy(env, to, `/api/email/${campaign}`, now);
}
