import type { Env } from "../types.js";
import { lifecycleMail, offerSig, type LifecycleMail } from "./secrets.js";
import { BLACK_FRIDAY, blackFridayState } from "./black-friday.js";

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
 */

const BATCH_DEFAULT = 20;
export const BATCH_MAX = 50;
/** Stop a batch after this many failures in a row: something is wrong. */
const MAX_CONSECUTIVE_FAILURES = 3;
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
/** The sends that go again to the first send's addresses, in order. */
export const BLACK_FRIDAY_RESENDS = [BLACK_FRIDAY_RESEND, BLACK_FRIDAY_THIRD] as const;
export type BlackFridayResend = (typeof BLACK_FRIDAY_RESENDS)[number];
/**
 * The type engram-web logs the email under in email_log, for every send
 * (src/app/api/email/black-friday/route.ts there). The tracking pixel
 * stamps opened_at on that row.
 */
const EMAIL_TYPE = "black-friday";

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

/**
 * FROM/WHERE for the addresses owed the second or the third email. Binds:
 * ?1 the first send's campaign, ?2 the email's type in email_log, ?3 the
 * campaign being sent (one of BLACK_FRIDAY_RESENDS).
 *
 * Only addresses the first email went to, so accounts created since are
 * never included. The account it went to must still be on Free, not
 * deleted, not internal, still subscribed, and still at that address. No
 * address that also belongs to a paid account, to an account that
 * unsubscribed, or to an account that bought a plan (a refund leaves the
 * row, and a buyer must not be asked to buy again). And no address that
 * has opened a Black Friday email, by the tracking pixel's record; that is
 * read again for every batch, so an open during the send still counts.
 */
const RESEND_OWED = `
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
    AND s.email NOT IN (
      SELECT lower(trim(recipient)) FROM email_log INDEXED BY idx_email_log_type
      WHERE type = ?2 AND opened_at IS NOT NULL)
    AND s.email NOT IN (
      SELECT email FROM campaign_sends WHERE campaign = ?3)`;

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

interface Recipient {
  id: string;
  name: string | null;
  email: string;
  /** lower(trim(email)): the key the claim is written under. */
  address: string;
}

/** The link in the email: the offer page, signed for this account. */
async function offerUrl(env: Env, orgId: string): Promise<string | null> {
  const sig = await offerSig(env, BLACK_FRIDAY, orgId);
  if (sig === null) return null;
  return `${env.APP_URL}/black-friday?org=${encodeURIComponent(orgId)}&sig=${sig}&utm_source=email&utm_campaign=blackfriday`;
}

async function recorded(env: Env, campaign: string): Promise<Record<string, number>> {
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

const batchLimit = (limit: number | undefined) => Math.max(1, Math.min(BATCH_MAX, Math.floor(limit ?? BATCH_DEFAULT)));

/** Ask engram-web to send one email. "refused" = it answered 4xx, before sending. */
async function deliver(
  env: Env,
  bearer: string,
  payload: { to: string; name: string | null; org_id: string; unsubscribe_url: string; offer_url: string; test?: boolean },
): Promise<"sent" | "refused" | "unknown"> {
  try {
    const res = await fetch(`${env.APP_URL}/api/email/black-friday`, {
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
 * `deadline` (ms since the epoch) has passed.
 */
async function sendBatch(
  env: Env,
  mail: LifecycleMail,
  campaign: string,
  rows: Recipient[],
  deadline = Number.POSITIVE_INFINITY,
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

    const outcome = await deliver(env, mail.bearer, {
      to: org.email.trim(),
      name: org.name,
      org_id: org.id,
      unsubscribe_url: await mail.unsubscribeUrl(org.id),
      offer_url: link,
    });

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

/**
 * The Black Friday email again: the second send (engram#773) unless
 * `campaign` names the third (engram#775). Count who is owed it, or send
 * the next batch. `deadline` (ms since the epoch) stops a batch from
 * starting another send after it. Only the cron sends it, through
 * campaign-runs.ts; /admin can count it, start the run and pause it.
 */
export async function runBlackFridayResend(
  env: Env,
  opts: { campaign?: BlackFridayResend; dryRun?: boolean; limit?: number; now?: number; deadline?: number },
): Promise<CampaignResult | CampaignError> {
  const campaign = opts.campaign ?? BLACK_FRIDAY_RESEND;
  const binds = [BLACK_FRIDAY, EMAIL_TYPE, campaign] as const;
  const owedRow = await env.DB.prepare(`SELECT COUNT(*) AS n ${RESEND_OWED}`)
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
      recorded: await recorded(env, campaign),
    };
  }

  const refusal = sendRefusal(env, opts.now);
  if (refusal) return refusal;
  const mail = lifecycleMail(env) as LifecycleMail;

  const batch = await env.DB.prepare(
    `SELECT s.org_id AS id, o.name, o.email, s.email AS address ${RESEND_OWED}
     ORDER BY s.email
     LIMIT ?4`,
  )
    .bind(...binds, batchLimit(opts.limit))
    .all<Recipient>();

  const result = await sendBatch(env, mail, campaign, batch.results ?? [], opts.deadline);
  return { dry_run: false, owed, ...result, recorded: await recorded(env, campaign) };
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
