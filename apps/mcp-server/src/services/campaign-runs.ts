import type { Env } from "../types.js";
import {
  BATCH_MAX,
  BLACK_FRIDAY_FOURTH,
  BLACK_FRIDAY_LAST_DAY,
  BLACK_FRIDAY_RESEND,
  BLACK_FRIDAY_THIRD,
  lastDayRefusal,
  runBlackFridayLastDay,
  runBlackFridayResend,
  sendRefusal,
  type CampaignError,
  type CampaignResult,
} from "./black-friday-campaign.js";
import {
  FINISH_SIGNUP,
  FINISH_SIGNUP_RESEND,
  finishSignupRefusal,
  runFinishSignup,
} from "./finish-signup-campaign.js";

/**
 * Campaign email the worker sends by itself (engram#773).
 *
 * A run is started from /admin and kept in campaign_runs (migration 0050).
 * From then on the cron that fires every two minutes calls runCampaignTick,
 * which sends the next batch of each running campaign. The run ends
 * itself: 'done' once its sender finds nobody left to send to or the offer
 * has ended, 'paused' when sending keeps failing (the note says why).
 * Nothing is sent from the computer that started it.
 *
 * Batches never overlap. A tick takes the run's lease before it sends and
 * gives it back after; a tick that finds the lease taken sends nothing.
 * engram-web sends one email per request over SMTP and does not retry an
 * email the mail provider refuses for coming too fast, so two senders at
 * once would lose emails.
 *
 * One campaign runs at a time: a run cannot be started while another is
 * running (engram#775). Two Black Friday sends running together could
 * also mail one person twice within minutes.
 *
 * A run can also be given a time to start by itself (engram#785, migration
 * 0052). Until then it is 'scheduled' and nothing is sent. The first tick
 * at or after that time makes it a running one and sends its first batch.
 * Whether the campaign may be sent is checked again at that moment, and
 * one campaign at a time still holds: a run whose time has come while
 * another campaign is running waits for that one to end.
 */

interface CampaignSender {
  /** Send the next batch, starting no send after `deadline` (ms since the epoch). */
  send(env: Env, opts: { limit: number; now: number; deadline: number }): Promise<CampaignResult | CampaignError>;
  /** Why the campaign may not be sent at `now`, or null when it may. */
  refusal(env: Env, now?: number): CampaignError | null;
}

/**
 * The campaigns the cron may send. Only a send whose audience is fixed in
 * advance belongs here: the second, third and fourth Black Friday emails
 * go only to addresses the first one went to, and so does the last-day
 * email (engram#785). The first send must never be listed: its audience
 * is every Free account, so it would now include accounts created since
 * it went out. The finish-sign-up email's audience is fixed too
 * (engram#781): accounts made before the sign-up fix that never got in.
 * Nobody can join it, and it only shrinks. Its second send (engram#783)
 * goes only to people the first one reached.
 */
const SENDERS: Readonly<Record<string, CampaignSender>> = {
  [BLACK_FRIDAY_RESEND]: {
    send: (env, opts) => runBlackFridayResend(env, { ...opts, campaign: BLACK_FRIDAY_RESEND }),
    refusal: sendRefusal,
  },
  [BLACK_FRIDAY_THIRD]: {
    send: (env, opts) => runBlackFridayResend(env, { ...opts, campaign: BLACK_FRIDAY_THIRD }),
    refusal: sendRefusal,
  },
  [BLACK_FRIDAY_FOURTH]: {
    send: (env, opts) => runBlackFridayResend(env, { ...opts, campaign: BLACK_FRIDAY_FOURTH }),
    refusal: sendRefusal,
  },
  [BLACK_FRIDAY_LAST_DAY]: {
    send: (env, opts) => runBlackFridayLastDay(env, opts),
    refusal: lastDayRefusal,
  },
  [FINISH_SIGNUP]: {
    send: (env, opts) => runFinishSignup(env, opts),
    refusal: finishSignupRefusal,
  },
  [FINISH_SIGNUP_RESEND]: {
    send: (env, opts) => runFinishSignup(env, { ...opts, campaign: FINISH_SIGNUP_RESEND }),
    refusal: finishSignupRefusal,
  },
};

/** A tick starts no send after this long, well inside the cron's 2 minutes. */
export const TICK_BUDGET_MS = 90_000;
/**
 * How long a tick holds a run: more than the budget plus one send that
 * runs to its timeout, so the next tick never sends while this one still
 * is. If a tick dies without giving the lease back, the run waits this
 * long, then carries on.
 */
export const LEASE_MS = 180_000;
/** Ticks in a row whose batch threw before the run is paused. */
export const MAX_FAILED_TICKS = 3;

export type RunState = "scheduled" | "running" | "paused" | "done";

export interface CampaignRun {
  campaign: string;
  state: RunState;
  /** Why the run stopped, why the last batch failed, or what a scheduled run is waiting for. */
  note: string | null;
  /** True while a tick holds the run, i.e. a batch is being sent. */
  sending: boolean;
  /** Ticks in a row whose batch threw. */
  failed_ticks: number;
  /** When a scheduled run starts (ISO 8601, UTC). Null in every other state. */
  start_at: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TickOutcome {
  campaign: string;
  /**
   * "batch": the sender ran. "busy": the last batch still held the run, so
   * nothing was sent. "not_started": a scheduled run's time had come and it
   * did not start; `state` and `note` say whether it waits or has stopped.
   */
  outcome: "batch" | "busy" | "no_sender" | "not_started";
  /** The run's state once this tick was done with it. */
  state: RunState;
  /** The sender's counts, when it got as far as sending. */
  result: CampaignResult | null;
  note: string | null;
}

const UNKNOWN_CAMPAIGN: CampaignError = {
  error: "unknown_campaign",
  message: "The worker has no sender for this campaign.",
  status: 404,
};

export async function campaignRun(env: Env, campaign: string, now = Date.now()): Promise<CampaignRun | null> {
  const row = await env.DB.prepare(
    `SELECT campaign, state, note, lease_until, failed_ticks, start_at, started_at, updated_at, finished_at
     FROM campaign_runs WHERE campaign = ?`,
  )
    .bind(campaign)
    .first<Omit<CampaignRun, "sending" | "start_at"> & { lease_until: number | null; start_at: number | null }>();
  if (!row) return null;
  const { lease_until, start_at, ...run } = row;
  return {
    ...run,
    sending: lease_until !== null && lease_until > now,
    start_at: start_at === null ? null : new Date(start_at).toISOString(),
  };
}

/** The other campaign that is running, if one is. */
async function otherRunning(env: Env, campaign: string): Promise<string | null> {
  const other = await env.DB.prepare(
    "SELECT campaign FROM campaign_runs WHERE state = 'running' AND campaign != ? ORDER BY campaign LIMIT 1",
  )
    .bind(campaign)
    .first<{ campaign: string }>();
  return other?.campaign ?? null;
}

/**
 * Start a run now, or start it again after a pause. Refused while the
 * campaign may not be sent (the offer has ended, mail is not configured,
 * or it is not yet the day for it), or while another campaign's run is
 * running, and then nothing is written. A time the run was scheduled for
 * is dropped. Sends nothing itself: the next tick does.
 */
export async function startCampaignRun(
  env: Env,
  campaign: string,
  now = Date.now(),
): Promise<{ run: CampaignRun } | CampaignError> {
  const sender = SENDERS[campaign];
  if (!sender) return UNKNOWN_CAMPAIGN;
  const refusal = sender.refusal(env, now);
  if (refusal) return refusal;
  const other = await otherRunning(env, campaign);
  if (other) {
    return {
      error: "another_campaign_running",
      message: `${other} is still running; start this one after it is done or paused.`,
      status: 409,
    };
  }
  await env.DB.prepare(
    `INSERT INTO campaign_runs (campaign, state) VALUES (?, 'running')
     ON CONFLICT (campaign) DO UPDATE
     SET state = 'running', note = NULL, failed_ticks = 0, start_at = NULL, finished_at = NULL,
         updated_at = datetime('now')`,
  )
    .bind(campaign)
    .run();
  return { run: (await campaignRun(env, campaign, now)) as CampaignRun };
}

/**
 * Give a run a time to start by itself (engram#785), or move the time it
 * has. `startAt` is in ms since the epoch and must be in the future.
 *
 * Refused if the campaign could not be sent at that time: whatever stops a
 * start now is checked as of `startAt`, so a time after the offer has
 * ended, or before the day an email is for, is not accepted. Refused too
 * while the run is running. Then nothing is written.
 *
 * Nothing is sent until the first tick at or after `startAt`. Another
 * campaign running now does not matter; one running at that time does,
 * and the run waits for it (startScheduledRun).
 */
export async function scheduleCampaignRun(
  env: Env,
  campaign: string,
  startAt: number,
  now = Date.now(),
): Promise<{ run: CampaignRun } | CampaignError> {
  const sender = SENDERS[campaign];
  if (!sender) return UNKNOWN_CAMPAIGN;
  if (!Number.isInteger(startAt) || Number.isNaN(new Date(startAt).getTime()) || startAt <= now) {
    return { error: "bad_request", message: "The start time must be a time in the future.", status: 400 };
  }
  const refusal = sender.refusal(env, startAt);
  if (refusal) return refusal;
  // One statement, so a run that a tick or /admin has just started is not
  // turned back into a scheduled one.
  const set = await env.DB.prepare(
    `INSERT INTO campaign_runs (campaign, state, start_at) VALUES (?1, 'scheduled', ?2)
     ON CONFLICT (campaign) DO UPDATE
     SET state = 'scheduled', start_at = ?2, note = NULL, failed_ticks = 0, finished_at = NULL,
         updated_at = datetime('now')
     WHERE campaign_runs.state != 'running'`,
  )
    .bind(campaign, startAt)
    .run();
  if (!(set.meta.changes ?? 0)) {
    return {
      error: "already_running",
      message: "This campaign is running; pause it before giving it a start time.",
      status: 409,
    };
  }
  return { run: (await campaignRun(env, campaign, now)) as CampaignRun };
}

/**
 * Pause a running run, or cancel a scheduled start. The batch being sent,
 * if any, finishes (at most BATCH_MAX emails); no batch starts after it. A
 * scheduled run has sent nothing yet, and now will not start by itself.
 */
export async function pauseCampaignRun(
  env: Env,
  campaign: string,
): Promise<{ paused: boolean; run: CampaignRun | null }> {
  // Every SET expression reads the row as it was, so the note is chosen by
  // the state the run had.
  const r = await env.DB.prepare(
    `UPDATE campaign_runs
     SET state = 'paused',
         note = CASE WHEN state = 'scheduled' THEN 'Scheduled start cancelled from /admin.' ELSE 'Paused from /admin.' END,
         start_at = NULL,
         updated_at = datetime('now')
     WHERE campaign = ? AND state IN ('running', 'scheduled')`,
  )
    .bind(campaign)
    .run();
  return { paused: (r.meta.changes ?? 0) > 0, run: await campaignRun(env, campaign) };
}

/**
 * One cron tick: the next batch of every running campaign, then every
 * scheduled run whose time has come. One small query when there is neither.
 */
export async function runCampaignTick(env: Env, now = Date.now()): Promise<TickOutcome[]> {
  const due = await env.DB.prepare(
    `SELECT campaign, state FROM campaign_runs
     WHERE state = 'running' OR (state = 'scheduled' AND start_at <= ?)
     ORDER BY state = 'scheduled', campaign`,
  )
    .bind(now)
    .all<{ campaign: string; state: RunState }>();
  const deadline = now + TICK_BUDGET_MS;
  const outcomes: TickOutcome[] = [];
  for (const { campaign, state } of due.results ?? []) {
    // A scheduled run is made a running one first. If that does not happen,
    // that is this tick's outcome for it; if it does, its first batch goes now.
    const notStarted = state === "scheduled" ? await startScheduledRun(env, campaign, now) : null;
    outcomes.push(notStarted ?? (await tickRun(env, campaign, now, deadline)));
  }
  return outcomes;
}

/**
 * A run the code cannot send (no sender, or one since removed): stop it
 * instead of finding it again every two minutes.
 */
async function stopUnsendable(env: Env, campaign: string): Promise<TickOutcome> {
  const note = "The worker has no sender for this campaign; nothing was sent.";
  await env.DB.prepare(
    `UPDATE campaign_runs SET state = 'paused', note = ?, start_at = NULL, updated_at = datetime('now')
     WHERE campaign = ? AND state IN ('running', 'scheduled')`,
  )
    .bind(note, campaign)
    .run();
  console.error(`[campaign] ${campaign}: ${note}`);
  return { campaign, outcome: "no_sender", state: "paused", result: null, note };
}

/**
 * Make a scheduled run whose time has come a running one. Returns null
 * when it is running now, so the caller sends its first batch; otherwise
 * what happened instead:
 *
 * - The campaign may not be sent at this moment: the run stops, 'done' if
 *   the offer has ended and 'paused' for anything else, and the note says
 *   why. It was checked when the time was set; this is the check that
 *   counts.
 * - Another campaign is running: the run stays scheduled and the note says
 *   what it waits for. Each tick tries again, and a tick sends its running
 *   campaigns first, so the run starts in the very tick that ends the
 *   other one.
 * - /admin cancelled it or moved its time while this tick was at work:
 *   that stands, and nothing is sent.
 */
async function startScheduledRun(env: Env, campaign: string, now: number): Promise<TickOutcome | null> {
  const sender = SENDERS[campaign];
  if (!sender) return stopUnsendable(env, campaign);

  let state: RunState = "scheduled";
  let note: string | null = null;
  // True when this tick stopped the run for a reason someone has to look at.
  let stopped = false;
  const refusal = sender.refusal(env, now);
  if (refusal) {
    state = refusal.error === "offer_ended" ? "done" : "paused";
    note = refusal.message;
    const ended = await env.DB.prepare(
      `UPDATE campaign_runs
       SET state = ?1, note = ?2, start_at = NULL,
           finished_at = CASE WHEN ?1 = 'done' THEN datetime('now') ELSE finished_at END,
           updated_at = datetime('now')
       WHERE campaign = ?3 AND state = 'scheduled'`,
    )
      .bind(state, note, campaign)
      .run();
    stopped = state === "paused" && (ended.meta.changes ?? 0) > 0;
  } else {
    // One statement decides it, so two ticks cannot both start it, and it
    // cannot start beside a campaign that /admin started a moment ago. The
    // lease is left alone: a batch from before a pause may still hold it.
    const started = await env.DB.prepare(
      `UPDATE campaign_runs
       SET state = 'running', start_at = NULL, note = NULL, failed_ticks = 0,
           started_at = datetime('now'), finished_at = NULL, updated_at = datetime('now')
       WHERE campaign = ?1 AND state = 'scheduled' AND start_at <= ?2
         AND NOT EXISTS (SELECT 1 FROM campaign_runs r WHERE r.state = 'running' AND r.campaign != ?1)`,
    )
      .bind(campaign, now)
      .run();
    if ((started.meta.changes ?? 0) > 0) {
      console.log(`[campaign] ${campaign}: started at its scheduled time`);
      return null;
    }
    const other = await otherRunning(env, campaign);
    if (other) {
      // Written when the wait begins, not again at every tick of it.
      note = `Waiting for ${other} to end; this one starts after it.`;
      await env.DB.prepare(
        `UPDATE campaign_runs SET note = ?1, updated_at = datetime('now')
         WHERE campaign = ?2 AND state = 'scheduled' AND note IS NOT ?1`,
      )
        .bind(note, campaign)
        .run();
    }
  }

  // Read back what the run is now: /admin, or a tick that ran beside this
  // one, may have changed it in the meantime, and then that stands.
  const run = await campaignRun(env, campaign, now);
  // Started in the meantime: it is a running run like any other now, so
  // the caller sends its batch, or finds the other tick still sending it.
  if (run?.state === "running") return null;
  const settled = run?.state ?? state;
  const settledNote = run ? run.note : note;
  const line = `[campaign] ${campaign}: not started at its scheduled time -> ${settled}${settledNote ? ` (${settledNote})` : ""}`;
  // An error when this tick stopped the run, as in tickRun; a wait is not one.
  if (stopped) console.error(line);
  else console.log(line);
  return { campaign, outcome: "not_started", state: settled, result: null, note: settledNote };
}

async function tickRun(env: Env, campaign: string, now: number, deadline: number): Promise<TickOutcome> {
  const sender = SENDERS[campaign];
  if (!sender) return stopUnsendable(env, campaign);

  const lease = now + LEASE_MS;
  const took = await env.DB.prepare(
    `UPDATE campaign_runs SET lease_until = ?1, updated_at = datetime('now')
     WHERE campaign = ?2 AND state = 'running' AND (lease_until IS NULL OR lease_until <= ?3)
     RETURNING failed_ticks`,
  )
    .bind(lease, campaign, now)
    .first<{ failed_ticks: number }>();
  if (!took) {
    console.log(`[campaign] ${campaign}: the last batch is still sending; nothing sent this tick`);
    return { campaign, outcome: "busy", state: "running", result: null, note: null };
  }

  let state: RunState = "running";
  let note: string | null = null;
  let result: CampaignResult | null = null;
  let failedTicks = 0;
  try {
    const r = await sender.send(env, { limit: BATCH_MAX, now, deadline });
    if ("error" in r) {
      state = r.error === "offer_ended" ? "done" : "paused";
      note = r.message;
    } else {
      result = r;
      if (r.owed === 0) {
        state = "done";
        note = "Sent to everyone it was owed to.";
      } else if (r.stopped) {
        state = "paused";
        note = "Stopped after repeated failed sends; see the worker log.";
      } else if (r.sent === 0 && r.failed > 0) {
        state = "paused";
        note = "No send in the last batch went through; see the worker log.";
      }
    }
  } catch (err) {
    // Most likely D1 under load. Nothing claimed is sent again, so the next
    // tick can simply try again; a fault that keeps happening pauses it.
    failedTicks = took.failed_ticks + 1;
    note = `The batch failed: ${err instanceof Error ? err.message : String(err)}`;
    if (failedTicks >= MAX_FAILED_TICKS) {
      state = "paused";
      note = `${note} (${failedTicks} ticks in a row)`;
    }
  }

  // Every SET expression reads the row as it was, so a pause from /admin
  // during the batch (state no longer 'running') is kept, note and all.
  // The lease is given back only if it is still this tick's.
  await env.DB.prepare(
    `UPDATE campaign_runs
     SET lease_until = CASE WHEN lease_until = ?1 THEN NULL ELSE lease_until END,
         failed_ticks = ?5,
         state = CASE WHEN state = 'running' THEN ?2 ELSE state END,
         note = CASE WHEN state = 'running' THEN ?3 ELSE note END,
         finished_at = CASE WHEN state = 'running' AND ?2 = 'done' THEN datetime('now') ELSE finished_at END,
         updated_at = datetime('now')
     WHERE campaign = ?4`,
  )
    .bind(lease, state, note, campaign, failedTicks)
    .run();
  const run = await campaignRun(env, campaign);
  const settled = run?.state ?? state;
  const settledNote = run ? run.note : note;

  const counts = result
    ? `sent ${result.sent}, failed ${result.failed}, skipped ${result.skipped} (${result.owed} owed before)`
    : "sent nothing";
  const line = `[campaign] ${campaign}: ${counts} -> ${settled}${settledNote ? ` (${settledNote})` : ""}`;
  // An error when this tick stopped the run or its batch threw, not when /admin paused it.
  if (state === "paused" || failedTicks > 0) console.error(line);
  else console.log(line);
  return { campaign, outcome: "batch", state: settled, result, note: settledNote };
}
