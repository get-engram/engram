import type { Env } from "../types.js";
import {
  BATCH_MAX,
  BLACK_FRIDAY_RESEND,
  runBlackFridayResend,
  sendRefusal,
  type CampaignError,
  type CampaignResult,
} from "./black-friday-campaign.js";

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
 */

interface CampaignSender {
  /** Send the next batch, starting no send after `deadline` (ms since the epoch). */
  send(env: Env, opts: { limit: number; now: number; deadline: number }): Promise<CampaignResult | CampaignError>;
  /** Why the campaign may not be sent now, or null when it may. */
  refusal(env: Env, now?: number): CampaignError | null;
}

/**
 * The campaigns the cron may send. Only a send whose audience is fixed in
 * advance belongs here: the second Black Friday email goes only to
 * addresses the first one went to. The first send must never be listed:
 * its audience is every Free account, so it would now include accounts
 * created since it went out.
 */
const SENDERS: Readonly<Record<string, CampaignSender>> = {
  [BLACK_FRIDAY_RESEND]: { send: runBlackFridayResend, refusal: sendRefusal },
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

export type RunState = "running" | "paused" | "done";

export interface CampaignRun {
  campaign: string;
  state: RunState;
  /** Why the run stopped, or why the last batch failed. */
  note: string | null;
  /** True while a tick holds the run, i.e. a batch is being sent. */
  sending: boolean;
  /** Ticks in a row whose batch threw. */
  failed_ticks: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface TickOutcome {
  campaign: string;
  /** "batch": the sender ran. "busy": the last batch still held the run, so nothing was sent. */
  outcome: "batch" | "busy" | "no_sender";
  /** The run's state once this tick was done with it. */
  state: RunState;
  /** The sender's counts, when it got as far as sending. */
  result: CampaignResult | null;
  note: string | null;
}

export async function campaignRun(env: Env, campaign: string, now = Date.now()): Promise<CampaignRun | null> {
  const row = await env.DB.prepare(
    `SELECT campaign, state, note, lease_until, failed_ticks, started_at, updated_at, finished_at
     FROM campaign_runs WHERE campaign = ?`,
  )
    .bind(campaign)
    .first<Omit<CampaignRun, "sending"> & { lease_until: number | null }>();
  if (!row) return null;
  const { lease_until, ...run } = row;
  return { ...run, sending: lease_until !== null && lease_until > now };
}

/**
 * Start a run, or start it again after a pause. Refused while the campaign
 * may not be sent (the offer has ended, or mail is not configured), and
 * then nothing is written. Sends nothing itself: the next tick does.
 */
export async function startCampaignRun(
  env: Env,
  campaign: string,
  now = Date.now(),
): Promise<{ run: CampaignRun } | CampaignError> {
  const sender = SENDERS[campaign];
  if (!sender) return { error: "unknown_campaign", message: "The worker has no sender for this campaign.", status: 404 };
  const refusal = sender.refusal(env, now);
  if (refusal) return refusal;
  await env.DB.prepare(
    `INSERT INTO campaign_runs (campaign, state) VALUES (?, 'running')
     ON CONFLICT (campaign) DO UPDATE
     SET state = 'running', note = NULL, failed_ticks = 0, finished_at = NULL, updated_at = datetime('now')`,
  )
    .bind(campaign)
    .run();
  return { run: (await campaignRun(env, campaign, now)) as CampaignRun };
}

/**
 * Pause a running run. The batch being sent, if any, finishes (at most
 * BATCH_MAX emails); no batch starts after it.
 */
export async function pauseCampaignRun(
  env: Env,
  campaign: string,
): Promise<{ paused: boolean; run: CampaignRun | null }> {
  const r = await env.DB.prepare(
    `UPDATE campaign_runs SET state = 'paused', note = 'Paused from /admin.', updated_at = datetime('now')
     WHERE campaign = ? AND state = 'running'`,
  )
    .bind(campaign)
    .run();
  return { paused: (r.meta.changes ?? 0) > 0, run: await campaignRun(env, campaign) };
}

/** One cron tick: the next batch of every running campaign. */
export async function runCampaignTick(env: Env, now = Date.now()): Promise<TickOutcome[]> {
  const running = await env.DB.prepare("SELECT campaign FROM campaign_runs WHERE state = 'running' ORDER BY campaign")
    .all<{ campaign: string }>();
  const deadline = now + TICK_BUDGET_MS;
  const outcomes: TickOutcome[] = [];
  for (const { campaign } of running.results ?? []) {
    outcomes.push(await tickRun(env, campaign, now, deadline));
  }
  return outcomes;
}

async function tickRun(env: Env, campaign: string, now: number, deadline: number): Promise<TickOutcome> {
  const sender = SENDERS[campaign];
  if (!sender) {
    // A run the code cannot send (no sender, or one since removed): stop it
    // instead of finding it again every two minutes.
    const note = "The worker has no sender for this campaign; nothing was sent.";
    await env.DB.prepare(
      `UPDATE campaign_runs SET state = 'paused', note = ?, updated_at = datetime('now')
       WHERE campaign = ? AND state = 'running'`,
    )
      .bind(note, campaign)
      .run();
    console.error(`[campaign] ${campaign}: ${note}`);
    return { campaign, outcome: "no_sender", state: "paused", result: null, note };
  }

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
