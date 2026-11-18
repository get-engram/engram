import type { Env } from "../types.js";
import { lifecycleMail, offerSig } from "./secrets.js";
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
 */

const BATCH_DEFAULT = 20;
const BATCH_MAX = 50;
/** Stop a batch after this many failures in a row: something is wrong. */
const MAX_CONSECUTIVE_FAILURES = 3;

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

export type CampaignError = { error: string; message: string; status: 400 | 404 | 410 | 500 | 502 | 503 };

/** The link in the email: the offer page, signed for this account. */
async function offerUrl(env: Env, orgId: string): Promise<string | null> {
  const sig = await offerSig(env, BLACK_FRIDAY, orgId);
  if (sig === null) return null;
  return `${env.APP_URL}/black-friday?org=${encodeURIComponent(orgId)}&sig=${sig}&utm_source=email&utm_campaign=blackfriday`;
}

async function recorded(env: Env): Promise<Record<string, number>> {
  const rows = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM campaign_sends WHERE campaign = ? GROUP BY status",
  )
    .bind(BLACK_FRIDAY)
    .all<{ status: string; n: number }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.status, r.n]));
}

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
    return { dry_run: true, owed, sent: 0, skipped: 0, failed: 0, stopped: false, recorded: await recorded(env) };
  }

  // Never mail an offer that cannot be bought.
  const offer = blackFridayState(env, opts.now);
  if (!offer.open) {
    return offer.reason === "offer_ended"
      ? { error: "offer_ended", message: "The offer has ended; nothing was sent.", status: 410 }
      : { error: "offer_unavailable", message: "STRIPE_PRICE_ID_PRO_YEAR_BF is not set; nothing was sent.", status: 503 };
  }
  const mail = lifecycleMail(env);
  if (!mail || !env.APP_URL) {
    return { error: "mail_not_configured", message: "No website bearer, signing key or APP_URL; nothing was sent.", status: 500 };
  }

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
    return { dry_run: false, owed, sent: 1, skipped: 0, failed: 0, stopped: false, recorded: await recorded(env) };
  }

  const limit = Math.max(1, Math.min(BATCH_MAX, Math.floor(opts.limit ?? BATCH_DEFAULT)));
  const batch = await env.DB.prepare(
    `SELECT o.id, o.name, o.email, lower(trim(o.email)) AS address ${OWED}
     ORDER BY o.created_at, o.id
     LIMIT ?2`,
  )
    .bind(BLACK_FRIDAY, limit)
    .all<{ id: string; name: string | null; email: string; address: string }>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let failuresInARow = 0;
  let stopped = false;

  for (const org of batch.results ?? []) {
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
      .bind(BLACK_FRIDAY, org.address, org.id)
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
        .bind(BLACK_FRIDAY, org.address)
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
        .bind(BLACK_FRIDAY, org.address)
        .run();
    } else {
      // No answer, or a server error: the email may have gone out. Keep the
      // claim so it is never sent twice.
      await env.DB.prepare("UPDATE campaign_sends SET status = 'unknown' WHERE campaign = ? AND email = ?")
        .bind(BLACK_FRIDAY, org.address)
        .run();
    }
    if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      stopped = true;
      break;
    }
  }

  return { dry_run: false, owed, sent, skipped, failed, stopped, recorded: await recorded(env) };
}
