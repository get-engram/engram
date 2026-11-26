import type { Env } from "../types.js";
import { lifecycleMail, offerSig, type LifecycleMail } from "./secrets.js";
import { BLACK_FRIDAY, BLACK_FRIDAY_ENDS_AT_MS, blackFridayState } from "./black-friday.js";

/**
 * The Black Friday 2026 email (engram#763): one email to every account
 * that is not a paying customer, sent in batches by hand from /admin.
 *
 * Who gets it: accounts on the Free plan with an email address. Who does
 * not: deleted and internal accounts, anyone who unsubscribed from Engram's
 * emails, and any address that also belongs to a paid account or to an
 * account that unsubscribed (the same person, two accounts).
 *
 * One email per address, ever. The address is written to campaign_sends
 * BEFORE the send (migration 0048), so a second batch, a retry after a
 * timeout, or two accounts with one address cannot send it twice.
 *
 * The second send (engram#773) is the same email again, to the addresses
 * that got the first one and have not opened it. It has its own campaign
 * value in campaign_sends, so it too goes once per address, and the
 * worker's cron sends it by itself once it is started from /admin
 * (campaign-runs.ts).
 *
 * The third send (engram#775) is the same email once more, to the same
 * kind of address: one the first email went to that has opened neither
 * email. It too has its own campaign value and is sent by the cron.
 *
 * The fourth send (engram#783) is the same again, to the addresses the
 * first email went to that have opened none of the three. Its own
 * campaign value, sent by the cron, like the second and the third.
 *
 * The last-day send (engram#785) is a different email, which says the
 * offer ends today, so it goes out on the offer's last day only. It goes
 * to every address the first email went to that could still buy, whether
 * it has opened a Black Friday email or not (engram#791). Its own campaign
 * value and its own route on engram-web, sent by the cron, which can
 * start it by itself at a time set in advance.
 *
 * The reminders (engram#787) are three more emails, each to a small group
 * that a Black Friday email has not reached as such: an unfinished
 * checkout, a plan that ended for a failed payment, a new account with
 * nothing saved. They are built in black-friday-reminders.ts from the
 * pieces exported here.
 */

const BATCH_DEFAULT = 20;
export const BATCH_MAX = 50;
/** Stop a batch after this many failures in a row: something is wrong. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Give up waiting for engram-web after this long. The email may still go
 * out, so the claim is kept ('unknown'), as for any request with no answer.
 * Bounds how long one batch can take (campaign-runs.ts holds its lease for
 * longer than a batch plus one send).
 */
export const SEND_TIMEOUT_MS = 25_000;

/** The second send's campaign value in campaign_sends and campaign_runs. */
export const BLACK_FRIDAY_RESEND = "black-friday-resend";
/** The third send's campaign value in campaign_sends and campaign_runs. */
export const BLACK_FRIDAY_THIRD = "black-friday-third";
/** The fourth send's campaign value in campaign_sends and campaign_runs. */
export const BLACK_FRIDAY_FOURTH = "black-friday-fourth";
/** The sends that go again to the first send's addresses, in order. */
export const BLACK_FRIDAY_RESENDS = [BLACK_FRIDAY_RESEND, BLACK_FRIDAY_THIRD, BLACK_FRIDAY_FOURTH] as const;
export type BlackFridayResend = (typeof BLACK_FRIDAY_RESENDS)[number];
/** The last-day send's campaign value in campaign_sends and campaign_runs. */
export const BLACK_FRIDAY_LAST_DAY = "black-friday-last-day";
/**
 * The first moment of the offer's last day: 24 hours before it ends, which
 * is Friday, November 27 in US Eastern. The last-day email says "today is
 * the last day", so it is never sent before this. Keep it equal to
 * BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS in engram-web's src/lib/black-friday.ts:
 * its route refuses the email before then too.
 */
export const BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS = BLACK_FRIDAY_ENDS_AT_MS - 24 * 60 * 60 * 1000;
/** The only address a test copy goes to. */
export const TEST_RECIPIENT = "hello@getengram.app";
/**
 * The type engram-web logs the email under in email_log, for every send,
 * the last-day one included (src/app/api/email/black-friday/route.ts and
 * black-friday-last-day/route.ts there). The tracking pixel stamps
 * opened_at on that row.
 */
const EMAIL_TYPE = "black-friday";
/** engram-web's route for the email every send but the last-day one sends. */
const EMAIL_ROUTE = "/api/email/black-friday";
/**
 * engram-web's route for the last-day email (engram-web#329). A route of
 * its own, so a website without it answers 404 and sends nothing.
 */
const LAST_DAY_ROUTE = "/api/email/black-friday-last-day";

/** FROM/WHERE for the accounts still owed the email. One bind: the campaign. */
const OWED = `
  FROM organizations o
  WHERE o.deleted_at IS NULL
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
    AND lower(trim(o.email)) NOT IN (
      SELECT email FROM campaign_sends WHERE campaign = ?1)`;

/** No address that has opened a Black Friday email. ?2 is that email's type in email_log. */
const NONE_OPENED = `
    AND s.email NOT IN (
      SELECT lower(trim(recipient)) FROM email_log INDEXED BY idx_email_log_type
      WHERE type = ?2 AND opened_at IS NOT NULL)`;

/**
 * FROM/WHERE for the addresses owed one of the emails that follow the
 * first. Binds: ?1 the first send's campaign, ?2 the email's type in
 * email_log, ?3 the campaign being sent.
 *
 * Only addresses the first email went to, so accounts created since are
 * never included. The account it went to must still be on Free, not
 * deleted, not internal, still subscribed, and still at that address. No
 * address that also belongs to a paid account, to an account that
 * unsubscribed, or to an account that bought a plan (a refund leaves the
 * row, and a buyer must not be asked to buy again). No address that
 * unsubscribed through the finish-sign-up email's link (email_opt_outs,
 * engram#781), even if no org with it has opted out.
 *
 * `unopenedOnly` keeps only the addresses that have opened no Black
 * Friday email (NONE_OPENED): true for the resends. The last-day send
 * passes false and goes to all of them, opened or not (engram#791). Its
 * statements then leave ?2 unused; SQLite numbers parameters by ?N, so
 * they take the same binds. An open is the tracking pixel's record. It is
 * read again for every batch, so an open during a resend still counts.
 */
const followUpOwed = (unopenedOnly: boolean) => `
  FROM campaign_sends s
  JOIN organizations o ON o.id = s.org_id
  WHERE s.campaign = ?1
    AND o.deleted_at IS NULL
    AND o.tier = 'free'
    AND o.digest_opt_out = 0
    AND COALESCE(o.referral_source, '') != 'internal'
    AND lower(trim(o.email)) = s.email
    AND s.email NOT IN (
      SELECT lower(trim(email)) FROM organizations
      WHERE email IS NOT NULL AND deleted_at IS NULL AND tier != 'free')
    AND s.email NOT IN (
      SELECT lower(trim(email)) FROM organizations
      WHERE email IS NOT NULL AND digest_opt_out = 1)
    AND s.org_id NOT IN (SELECT org_id FROM prepaid_plans)
    AND s.email NOT IN (
      SELECT lower(trim(b.email)) FROM prepaid_plans p JOIN organizations b ON b.id = p.org_id
      WHERE b.email IS NOT NULL)
    AND s.email NOT IN (SELECT email FROM email_opt_outs)${unopenedOnly ? NONE_OPENED : ""}
    AND s.email NOT IN (
      SELECT email FROM campaign_sends WHERE campaign = ?3)`;

/** Owed a resend (one of BLACK_FRIDAY_RESENDS): has opened no Black Friday email. */
const RESEND_OWED = followUpOwed(true);
/** Owed the last-day email: opened a Black Friday email or not (engram#791). */
const LAST_DAY_OWED = followUpOwed(false);

export interface CampaignResult {
  dry_run: boolean;
  /** Addresses still owed the email before this call. */
  owed: number;
  sent: number;
  /** Claimed by an earlier or concurrent send, so skipped. */
  skipped: number;
  failed: number;
  /** True when the batch stopped early after repeated failures. */
  stopped: boolean;
  /** Totals recorded for the campaign so far, by status. */
  recorded: Record<string, number>;
}

export type CampaignError = { error: string; message: string; status: 400 | 404 | 409 | 410 | 500 | 502 | 503 };

export interface Recipient {
  id: string;
  name: string | null;
  email: string;
  /** lower(trim(email)): the key the claim is written under. */
  address: string;
}

/** The link in the email: the offer page, signed for this account. */
export async function offerUrl(env: Env, orgId: string): Promise<string | null> {
  const sig = await offerSig(env, BLACK_FRIDAY, orgId);
  if (sig === null) return null;
  return `${env.APP_URL}/black-friday?org=${encodeURIComponent(orgId)}&sig=${sig}&utm_source=email&utm_campaign=blackfriday`;
}

/** What campaign_sends holds for a campaign so far, by status. */
export async function recorded(env: Env, campaign: string): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM campaign_sends WHERE campaign = ? GROUP BY status",
  )
    .bind(campaign)
    .all<{ status: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.status, r.n]));
}

/**
 * Why nothing may be sent right now, or null when it may: never mail an
 * offer that cannot be bought, or an email without working links.
 */
export function sendRefusal(env: Env, now?: number): CampaignError | null {
  const offer = blackFridayState(env, now);
  if (!offer.open) {
    return offer.reason === "offer_ended"
      ? { error: "offer_ended", message: "The offer has ended; nothing was sent.", status: 410 }
      : { error: "offer_unavailable", message: "STRIPE_PRICE_ID_PRO_YEAR_BF is not set; nothing was sent.", status: 503 };
  }
  if (!lifecycleMail(env) || !env.APP_URL) {
    return { error: "mail_not_configured", message: "No website bearer, signing key or APP_URL; nothing was sent.", status: 500 };
  }
  return null;
}

/**
 * Why the last-day email may not be sent at `now`, or null when it may.
 * Everything that stops any Black Friday email stops it; and since it says
 * "today is the last day", it is not sent before that day has begun.
 */
export function lastDayRefusal(env: Env, now = Date.now()): CampaignError | null {
  const refusal = sendRefusal(env, now);
  if (refusal) return refusal;
  if (now < BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS) {
    const from = new Date(BLACK_FRIDAY_LAST_DAY_STARTS_AT_MS).toISOString();
    return {
      error: "too_early",
      message: `The last-day email is sent only on the offer's last day, from ${from}; nothing was sent.`,
      status: 409,
    };
  }
  return null;
}

/** How many to send in one batch: `limit`, kept between 1 and BATCH_MAX. */
export const batchLimit = (limit: number | undefined) => Math.max(1, Math.min(BATCH_MAX, Math.floor(limit ?? BATCH_DEFAULT)));

/**
 * Ask engram-web to send one email, through `route`: the first email's
 * unless the caller names the last-day one. "refused" = it answered 4xx,
 * before sending.
 */
export async function deliver(
  env: Env,
  bearer: string,
  payload: { to: string; name: string | null; org_id: string; unsubscribe_url: string; offer_url: string; test?: boolean },
  route = EMAIL_ROUTE,
): Promise<"sent" | "refused" | "unknown"> {
  try {
    const res = await fetch(`${env.APP_URL}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return "sent";
    console.error(`[black-friday] engram-web answered ${res.status} for org ${payload.org_id}`);
    return res.status >= 400 && res.status < 500 ? "refused" : "unknown";
  } catch (err) {
    console.error(`[black-friday] request failed for org ${payload.org_id}:`, err);
    return "unknown";
  }
}

/**
 * Send to each recipient in turn, claiming its address under `campaign`
 * first. Stops after three failures in a row, and starts no send once
 * `deadline` (ms since the epoch) has passed. `route` is engram-web's
 * route for the email being sent.
 */
export async function sendBatch(
  env: Env,
  mail: LifecycleMail,
  campaign: string,
  rows: Recipient[],
  deadline = Number.POSITIVE_INFINITY,
  route = EMAIL_ROUTE,
): Promise<Pick<CampaignResult, "sent" | "skipped" | "failed" | "stopped">> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let failuresInARow = 0;
  let stopped = false;

  for (const org of rows) {
    if (Date.now() >= deadline) break;
    const link = await offerUrl(env, org.id);
    if (link === null) {
      stopped = true;
      break;
    }
    // The claim. Losing it means this address already has the email, or a
    // send to it is in flight.
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO campaign_sends (campaign, email, org_id) VALUES (?, ?, ?)",
    )
      .bind(campaign, org.address, org.id)
      .run();
    if (!claim.meta.changes) {
      skipped++;
      continue;
    }

    const outcome = await deliver(
      env,
      mail.bearer,
      {
        to: org.email.trim(),
        name: org.name,
        org_id: org.id,
        unsubscribe_url: await mail.unsubscribeUrl(org.id),
        offer_url: link,
      },
      route,
    );

    if (outcome === "sent") {
      await env.DB.prepare("UPDATE campaign_sends SET status = 'sent' WHERE campaign = ? AND email = ?")
        .bind(campaign, org.address)
        .run();
      sent++;
      failuresInARow = 0;
      continue;
    }

    failed++;
    failuresInARow++;
    if (outcome === "refused") {
      // engram-web turned the request down before sending: release the
      // claim so a later batch can try this address again.
      await env.DB.prepare("DELETE FROM campaign_sends WHERE campaign = ? AND email = ? AND status = 'claimed'")
        .bind(campaign, org.address)
        .run();
    } else {
      // No answer, or a server error: the email may have gone out. Keep the
      // claim so it is never sent twice.
      await env.DB.prepare("UPDATE campaign_sends SET status = 'unknown' WHERE campaign = ? AND email = ?")
        .bind(campaign, org.address)
        .run();
    }
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      stopped = true;
      break;
    }
  }

  return { sent, skipped, failed, stopped };
}

/**
 * Count, test or send.
 *
 * - `dryRun`: count the addresses still owed the email; send nothing.
 * - `testTo` + `testOrg`: send ONE copy to `testTo`, with the name and the
 *   signed link of `testOrg`. Records nothing, so it can be repeated.
 * - otherwise: send to the next `limit` addresses.
 */
export async function runBlackFridayCampaign(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; testTo?: string; testOrg?: string; now?: number },
): Promise<CampaignResult | CampaignError> {
  const owedRow = await env.DB.prepare(`SELECT COUNT(DISTINCT lower(trim(o.email))) AS n ${OWED}`)
    .bind(BLACK_FRIDAY)
    .first<{ n: number }>();
  const owed = owedRow?.n ?? 0;

  if (opts.dryRun) {
    return { dry_run: true, owed, sent: 0, skipped: 0, failed: 0, stopped: false, recorded: await recorded(env, BLACK_FRIDAY) };
  }

  const refusal = sendRefusal(env, opts.now);
  if (refusal) return refusal;
  const mail = lifecycleMail(env) as LifecycleMail;

  if (opts.testTo !== undefined || opts.testOrg !== undefined) {
    if (!opts.testTo || !opts.testOrg) {
      return { error: "bad_request", message: "A test needs both test_to and test_org.", status: 400 };
    }
    const org = await env.DB.prepare("SELECT id, name FROM organizations WHERE id = ? AND deleted_at IS NULL")
      .bind(opts.testOrg)
      .first<{ id: string; name: string | null }>();
    if (!org) return { error: "organization_not_found", message: "test_org does not exist.", status: 404 };
    const link = await offerUrl(env, org.id);
    if (link === null) return { error: "mail_not_configured", message: "No signing key.", status: 500 };
    const outcome = await deliver(env, mail.bearer, {
      to: opts.testTo,
      name: org.name,
      org_id: org.id,
      unsubscribe_url: await mail.unsubscribeUrl(org.id),
      offer_url: link,
      test: true,
    });
    if (outcome !== "sent") {
      return { error: "test_send_failed", message: `engram-web did not send the test (${outcome}).`, status: 502 };
    }
    return { dry_run: false, owed, sent: 1, skipped: 0, failed: 0, stopped: false, recorded: await recorded(env, BLACK_FRIDAY) };
  }

  const batch = await env.DB.prepare(
    `SELECT o.id, o.name, o.email, lower(trim(o.email)) AS address ${OWED}
     ORDER BY o.created_at, o.id
     LIMIT ?2`,
  )
    .bind(BLACK_FRIDAY, batchLimit(opts.limit))
    .all<Recipient>();

  const result = await sendBatch(env, mail, BLACK_FRIDAY, batch.results ?? []);
  return { dry_run: false, owed, ...result, recorded: await recorded(env, BLACK_FRIDAY) };
}

/** One of the emails that follow the first, as runFollowUp sends it. */
interface FollowUp {
  /** Its value in campaign_sends and campaign_runs. */
  campaign: string;
  /** FROM/WHERE for the addresses owed it (followUpOwed). */
  owed: string;
  /** engram-web's route for the email. */
  route: string;
  /** Why it may not be sent at `now`, or null when it may. */
  refusal(env: Env, now?: number): CampaignError | null;
}

/**
 * Count who is owed one of the emails that follow the first, or send its
 * next batch. `deadline` (ms since the epoch) stops a batch from starting
 * another send after it.
 */
async function runFollowUp(
  env: Env,
  email: FollowUp,
  opts: { dryRun?: boolean; limit?: number; now?: number; deadline?: number },
): Promise<CampaignResult | CampaignError> {
  const binds = [BLACK_FRIDAY, EMAIL_TYPE, email.campaign] as const;
  const owedRow = await env.DB.prepare(`SELECT COUNT(*) AS n ${email.owed}`)
    .bind(...binds)
    .first<{ n: number }>();
  const owed = owedRow?.n ?? 0;

  if (opts.dryRun) {
    return {
      dry_run: true,
      owed,
      sent: 0,
      skipped: 0,
      failed: 0,
      stopped: false,
      recorded: await recorded(env, email.campaign),
    };
  }

  const refusal = email.refusal(env, opts.now);
  if (refusal) return refusal;
  const mail = lifecycleMail(env) as LifecycleMail;

  const batch = await env.DB.prepare(
    `SELECT s.org_id AS id, o.name, o.email, s.email AS address ${email.owed}
     ORDER BY s.email
     LIMIT ?4`,
  )
    .bind(...binds, batchLimit(opts.limit))
    .all<Recipient>();

  const result = await sendBatch(env, mail, email.campaign, batch.results ?? [], opts.deadline, email.route);
  return { dry_run: false, owed, ...result, recorded: await recorded(env, email.campaign) };
}

/**
 * The Black Friday email again: the second send (engram#773) unless
 * `campaign` names the third (engram#775) or the fourth (engram#783).
 * Count who is owed it, or send the next batch. Only the cron sends it,
 * through campaign-runs.ts; /admin can count it, start the run and pause
 * it.
 */
export async function runBlackFridayResend(
  env: Env,
  opts: { campaign?: BlackFridayResend; dryRun?: boolean; limit?: number; now?: number; deadline?: number },
): Promise<CampaignResult | CampaignError> {
  return runFollowUp(
    env,
    { campaign: opts.campaign ?? BLACK_FRIDAY_RESEND, owed: RESEND_OWED, route: EMAIL_ROUTE, refusal: sendRefusal },
    opts,
  );
}

/**
 * The last-day email (engram#785): count who is owed it, or send the next
 * batch. Refused before the offer's last day (lastDayRefusal); the count
 * is not. Only the cron sends it, through campaign-runs.ts; /admin can
 * count it, start the run, set a time for it to start, and pause it.
 */
export async function runBlackFridayLastDay(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; now?: number; deadline?: number },
): Promise<CampaignResult | CampaignError> {
  return runFollowUp(
    env,
    { campaign: BLACK_FRIDAY_LAST_DAY, owed: LAST_DAY_OWED, route: LAST_DAY_ROUTE, refusal: lastDayRefusal },
    opts,
  );
}

/**
 * A test copy of the email the resends send, to hello@getengram.app only
 * (engram#783). That address has its own account on the Free plan, so the
 * copy carries that account's name and signed links, as the real email
 * would. engram-web files it in Sent. Nothing is claimed in
 * campaign_sends, so it can be repeated and leaves no address out of a
 * send. Refused, like the send, once the offer has ended.
 */
export function sendBlackFridayResendTest(
  env: Env,
  to: string,
  now?: number,
): Promise<{ sent: true } | CampaignError> {
  return sendTestCopy(env, to, EMAIL_ROUTE, now);
}

/**
 * A test copy of the last-day email (engram#785), under the same rules.
 * It may go before the offer's last day, which the send may not:
 * engram-web sends a test copy to that one address on any day while the
 * offer is open, so the email can be read before it goes out.
 */
export function sendBlackFridayLastDayTest(
  env: Env,
  to: string,
  now?: number,
): Promise<{ sent: true } | CampaignError> {
  return sendTestCopy(env, to, LAST_DAY_ROUTE, now);
}

/** One test copy to hello@getengram.app, through engram-web's `route`. */
export async function sendTestCopy(
  env: Env,
  to: string,
  route: string,
  now?: number,
): Promise<{ sent: true } | CampaignError> {
  if (to.trim().toLowerCase() !== TEST_RECIPIENT) {
    return { error: "bad_request", message: `A test copy goes to ${TEST_RECIPIENT} only.`, status: 400 };
  }
  const refusal = sendRefusal(env, now);
  if (refusal) return refusal;
  const mail = lifecycleMail(env) as LifecycleMail;
  const org = await env.DB.prepare(
    `SELECT id, name FROM organizations
     WHERE lower(trim(email)) = ? AND deleted_at IS NULL
     ORDER BY created_at, id
     LIMIT 1`,
  )
    .bind(TEST_RECIPIENT)
    .first<{ id: string; name: string | null }>();
  if (!org) {
    return {
      error: "organization_not_found",
      message: `${TEST_RECIPIENT} has no account to take the name and links from.`,
      status: 404,
    };
  }
  const link = await offerUrl(env, org.id);
  if (link === null) return { error: "mail_not_configured", message: "No signing key.", status: 500 };
  const outcome = await deliver(
    env,
    mail.bearer,
    {
      to: TEST_RECIPIENT,
      name: org.name,
      org_id: org.id,
      unsubscribe_url: await mail.unsubscribeUrl(org.id),
      offer_url: link,
      test: true,
    },
    route,
  );
  if (outcome !== "sent") {
    return { error: "test_send_failed", message: `engram-web did not send the test copy (${outcome}).`, status: 502 };
  }
  return { sent: true };
}

/**
 * For /admin: how many addresses the first email went to, and how many of
 * those have opened a Black Friday email (any send).
 */
export async function blackFridayOpens(env: Env): Promise<{ first_send: number; opened: number }> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS first_send,
            COALESCE(SUM(CASE WHEN s.email IN (
              SELECT lower(trim(recipient)) FROM email_log INDEXED BY idx_email_log_type
              WHERE type = ?2 AND opened_at IS NOT NULL) THEN 1 ELSE 0 END), 0) AS opened
     FROM campaign_sends s
     WHERE s.campaign = ?1`,
  )
    .bind(BLACK_FRIDAY, EMAIL_TYPE)
    .first<{ first_send: number; opened: number }>();
  return { first_send: row?.first_send ?? 0, opened: row?.opened ?? 0 };
}
