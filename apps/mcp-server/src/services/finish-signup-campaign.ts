import type { Env } from "../types.js";
import {
  MAX_CONSECUTIVE_FAILURES,
  SEND_TIMEOUT_MS,
  batchLimit,
  recorded,
  type CampaignError,
  type CampaignResult,
} from "./black-friday-campaign.js";
import { lifecycleMail, userUnsubscribeUrl } from "./secrets.js";

/**
 * The finish-sign-up email (engram#781): one email to each person the
 * website's old sign-up page left stuck, saying that signing in works now
 * and how to get in. While the Black Friday offer is open, engram-web adds
 * it to the email.
 *
 * Until the fix (engram-web#326), the sign-up page made the account without
 * confirming it, so its password could not sign in. These people never got
 * in, so they have no org here. engram-web has their accounts, so it lists
 * them and writes and sends each email (src/app/api/email/finish-signup
 * there). This is the sender: it asks for the list, sends a batch at a time
 * from the cron (campaign-runs.ts), and keeps the record of who got one.
 *
 * Who gets it: everyone engram-web lists (an email-and-password account
 * made before the fix that was never confirmed and has never signed in),
 * less any address that has an org here (that person got in another way,
 * or unsubscribed as an org), any that unsubscribed through this email's
 * link (email_opt_outs, migration 0051), and any already claimed for it.
 * engram-web checks each person again just before it sends.
 *
 * One email per address, ever: the address is claimed in campaign_sends
 * before the send, as for the Black Friday sends. These people have no org,
 * so org_id in those rows holds their account id on the website. The
 * email's unsubscribe link names that id, and index.ts finds the address
 * it opts out in those rows.
 */

/** The campaign value in campaign_sends and campaign_runs, and the email's type in email_log. */
export const FINISH_SIGNUP = "finish-signup";
/** engram-web's route: GET lists who is owed the email, POST sends it to one of them. */
const ROUTE = "/api/email/finish-signup";
/** Give up waiting for the list after this long (it pages through every account). */
export const LIST_TIMEOUT_MS = 30_000;
/** The only address a test copy goes to. */
export const TEST_RECIPIENT = "hello@getengram.app";
/** The account a test copy's unsubscribe link names: nobody's, so it opts out nobody. */
export const TEST_USER = "00000000-0000-0000-0000-000000000000";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Addresses per owed query, so its one bound value stays small. */
const OWED_CHUNK = 100;

/**
 * Which of a chunk of addresses (?1, a JSON array) are still owed the
 * email. ?2 is the campaign. No subquery yields NULL, so NOT IN never
 * leaves everyone out.
 */
const OWED = `
  SELECT j.value AS email FROM json_each(?1) j
  WHERE j.value NOT IN (SELECT email FROM campaign_sends WHERE campaign = ?2)
    AND j.value NOT IN (SELECT email FROM email_opt_outs)
    AND j.value NOT IN (SELECT lower(trim(email)) FROM organizations WHERE email IS NOT NULL)`;

export type FinishSignupResult = CampaignResult & {
  /** How many people engram-web listed before this call. */
  listed: number;
};

interface Person {
  /** Their account id on the website. */
  id: string;
  /** Lower-cased and trimmed: the key the claim is written under. */
  email: string;
}

/**
 * Everyone engram-web lists as owed the email, one per address. Throws when
 * it does not answer with a list, so nothing is sent.
 */
async function listed(env: Env, bearer: string, timeoutMs: number): Promise<Person[]> {
  const res = await fetch(`${env.APP_URL}${ROUTE}`, {
    headers: { Authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`engram-web answered ${res.status} for the finish-sign-up list`);
  const body = (await res.json().catch(() => null)) as { users?: unknown } | null;
  if (body === null || typeof body !== "object" || !Array.isArray(body.users)) {
    throw new Error("engram-web sent no finish-sign-up list");
  }
  const people: Person[] = [];
  const seen = new Set<string>();
  for (const entry of body.users) {
    if (entry === null || typeof entry !== "object") continue;
    const { id, email } = entry as { id?: unknown; email?: unknown };
    if (typeof id !== "string" || !UUID.test(id) || typeof email !== "string") continue;
    const address = email.trim().toLowerCase();
    if (!address.includes("@") || seen.has(address)) continue;
    seen.add(address);
    people.push({ id, email: address });
  }
  return people;
}

/** The people still owed the email, in the order engram-web listed them. */
async function owedOf(env: Env, people: Person[]): Promise<Person[]> {
  const owed = new Set<string>();
  for (let i = 0; i < people.length; i += OWED_CHUNK) {
    const chunk = people.slice(i, i + OWED_CHUNK).map((p) => p.email);
    const rows = await env.DB.prepare(OWED).bind(JSON.stringify(chunk), FINISH_SIGNUP).all<{ email: string }>();
    for (const row of rows.results ?? []) owed.add(row.email);
  }
  return people.filter((p) => owed.has(p.email));
}

/** The bearer for engram-web, or why nothing may be sent: never an email without a link that works. */
function configured(env: Env): { bearer: string } | CampaignError {
  const mail = lifecycleMail(env);
  if (mail === null || !env.APP_URL) {
    return { error: "mail_not_configured", message: "No website bearer, signing key or APP_URL; nothing was sent.", status: 500 };
  }
  return { bearer: mail.bearer };
}

/** Why nothing may be sent right now, or null when it may. */
export function finishSignupRefusal(env: Env): CampaignError | null {
  const mail = configured(env);
  return "error" in mail ? mail : null;
}

/**
 * Ask engram-web to send the email to one person. Its answer, by status:
 * "sent"; "not_owed" (409: they are no longer stuck, most likely signed in
 * since the list was read, and nothing was sent); "refused" (any other 4xx,
 * nothing was sent); "unknown" (5xx or no answer: it may have gone out).
 * The log names the account, never the address.
 */
async function deliver(
  env: Env,
  bearer: string,
  person: Person,
  unsubscribeUrl: string,
): Promise<"sent" | "not_owed" | "refused" | "unknown"> {
  try {
    const res = await fetch(`${env.APP_URL}${ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ to: person.email, user_id: person.id, unsubscribe_url: unsubscribeUrl }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.ok) return "sent";
    if (res.status === 409) {
      const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown } | null;
      if (body?.error === "not_owed") {
        console.log(`[finish-signup] user ${person.id} is no longer owed it (${String(body.reason)}); nothing sent`);
        return "not_owed";
      }
    }
    console.error(`[finish-signup] engram-web answered ${res.status} for user ${person.id}`);
    return res.status >= 400 && res.status < 500 ? "refused" : "unknown";
  } catch (err) {
    console.error(`[finish-signup] request failed for user ${person.id}:`, err);
    return "unknown";
  }
}

/**
 * Send to each person in turn, claiming their address first. Starts no
 * send once `deadline` (ms since the epoch) has passed, and stops after
 * three answers in a row that sent nothing.
 */
async function sendBatch(
  env: Env,
  bearer: string,
  people: Person[],
  deadline: number,
): Promise<Pick<CampaignResult, "sent" | "skipped" | "failed" | "stopped">> {
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let nothingSentInARow = 0;
  let stopped = false;

  for (const person of people) {
    if (Date.now() >= deadline) break;
    const link = await userUnsubscribeUrl(env, person.id);
    if (link === null) {
      stopped = true;
      break;
    }
    // The claim. Losing it means this address already has the email, or a
    // send to it is in flight.
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO campaign_sends (campaign, email, org_id) VALUES (?, ?, ?)",
    )
      .bind(FINISH_SIGNUP, person.email, person.id)
      .run();
    if (!claim.meta.changes) {
      skipped++;
      continue;
    }

    const outcome = await deliver(env, bearer, person, link);
    if (outcome === "sent") {
      await env.DB.prepare("UPDATE campaign_sends SET status = 'sent' WHERE campaign = ? AND email = ?")
        .bind(FINISH_SIGNUP, person.email)
        .run();
      sent++;
      nothingSentInARow = 0;
      continue;
    }

    if (outcome === "unknown") {
      // No answer, or a server error: the email may have gone out. Keep the
      // claim so it is never sent twice.
      await env.DB.prepare("UPDATE campaign_sends SET status = 'unknown' WHERE campaign = ? AND email = ?")
        .bind(FINISH_SIGNUP, person.email)
        .run();
    } else {
      // Nothing was sent: release the claim. Someone no longer owed it drops
      // off engram-web's list by themselves; anyone else is tried again by
      // a later batch.
      await env.DB.prepare("DELETE FROM campaign_sends WHERE campaign = ? AND email = ? AND status = 'claimed'")
        .bind(FINISH_SIGNUP, person.email)
        .run();
    }
    if (outcome === "not_owed") skipped++;
    else failed++;
    // Someone signing in between the list and their send is rare. Several in
    // a row means engram-web is turning everyone away: stop, so the run
    // pauses instead of asking again every two minutes.
    nothingSentInARow++;
    if (nothingSentInARow >= MAX_CONSECUTIVE_FAILURES) {
      stopped = true;
      break;
    }
  }

  return { sent, skipped, failed, stopped };
}

/**
 * Count (dryRun) or send the next batch. Throws when engram-web does not
 * list who is owed the email, or D1 fails; the cron tries again next tick.
 */
export async function runFinishSignup(
  env: Env,
  opts: { dryRun?: boolean; limit?: number; deadline?: number } = {},
): Promise<FinishSignupResult | CampaignError> {
  const mail = configured(env);
  if ("error" in mail) return mail;
  const { bearer } = mail;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const listTimeout = Math.max(1, Math.min(LIST_TIMEOUT_MS, deadline - Date.now()));

  const people = await listed(env, bearer, listTimeout);
  const owed = await owedOf(env, people);
  const counts = { listed: people.length, owed: owed.length };
  if (opts.dryRun) {
    return { dry_run: true, ...counts, sent: 0, skipped: 0, failed: 0, stopped: false, recorded: await recorded(env, FINISH_SIGNUP) };
  }
  const batch = await sendBatch(env, bearer, owed.slice(0, batchLimit(opts.limit)), deadline);
  return { dry_run: false, ...counts, ...batch, recorded: await recorded(env, FINISH_SIGNUP) };
}

/**
 * A test copy to hello@getengram.app only (engram-web skips the account
 * check for it and files it in Sent). Its unsubscribe link names
 * TEST_USER, so it opts out nobody. Nothing is recorded.
 */
export async function sendFinishSignupTest(env: Env, to: string): Promise<{ sent: true; offer: boolean } | CampaignError> {
  const mail = configured(env);
  if ("error" in mail) return mail;
  if (to.trim().toLowerCase() !== TEST_RECIPIENT) {
    return { error: "bad_request", message: `A test copy goes to ${TEST_RECIPIENT} only.`, status: 400 };
  }
  const { bearer } = mail;
  const failedTest: CampaignError = {
    error: "test_send_failed",
    message: "engram-web did not send the test copy; see its log.",
    status: 502,
  };
  try {
    const res = await fetch(`${env.APP_URL}${ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({
        to: TEST_RECIPIENT,
        user_id: TEST_USER,
        unsubscribe_url: await userUnsubscribeUrl(env, TEST_USER),
        test: true,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[finish-signup] engram-web answered ${res.status} for the test copy`);
      return failedTest;
    }
    const body = (await res.json().catch(() => null)) as { offer?: unknown } | null;
    return { sent: true, offer: body?.offer === true };
  } catch (err) {
    console.error("[finish-signup] the test copy request failed:", err);
    return failedTest;
  }
}
