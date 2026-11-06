import { getMaxChunkRowid } from "@getengram/db";
import {
  ChunkRestoreError,
  CLEAR_PAGE,
  emptyCounts,
  runChunkClearBatch,
  runChunkMoverBatch,
  runOrphanSweepBatch,
  type ChunkMoverCounts,
  type ChunkMoverMode,
} from "./chunk-mover.js";
import { withD1Retry } from "./resilient-d1.js";
import type { Env } from "../types.js";

/**
 * ChunkMoverDO — runs the engram#384 chunk job (chunk-mover.ts) over the
 * whole table, or one organization, as self-rescheduling alarms. One named
 * instance ("chunk-mover"), one run at a time; the cursor and counts live in
 * durable storage, so it survives deploys and restarts.
 *
 * Paced for a database that runs one statement at a time (engram#552): a
 * few pages per alarm, each a bounded rowid-range read (or, for orphans,
 * one bucket listing and primary-key lookups), then a pause before the next
 * alarm, backing off on errors and stopping after a run of them.
 *
 * Control via fetch (behind /admin/chunk-mover/*):
 *   POST /start {mode: "copy"|"verify", org?, start?, repair?, force?}
 *   POST /start {mode: "clear", maxClears, org?, start?, force?}
 *   POST /start {mode: "orphans", delete?, maxDeletes?, force?}
 *   POST /stop
 *   GET  /status
 *
 * A clear run must name `maxClears`, the most rows it may clear, so the
 * clear can roll out in steps: a few rows of one organization, then more.
 * It walks only the rows that existed when it started (up to `upto`, the
 * highest rowid then) and stops when it has cleared maxClears rows; resume
 * with `start` set to the stopped run's `cur`. It also stops at the first
 * page that finds a cleared row with no object (`lost`), and when it could
 * not give a row its text back (ChunkRestoreError): either means some text
 * may exist nowhere, and nothing more is cleared until that is understood.
 *
 * An orphans run reports unless `delete` is true, and a deleting run must
 * name `maxDeletes`, the most objects it may remove — set it from a report
 * run's `orphans`. A page whose orphans would pass it deletes nothing and
 * stops the run.
 */

const BATCHES_PER_ALARM = 4;
const REARM_MS = 750;
const MAX_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 50;
const MAX_SAMPLES = 20;
/** Upper bound on an orphans run's maxDeletes. */
const MAX_DELETES_LIMIT = 100_000;
/** Upper bound on a clear run's maxClears. */
const MAX_CLEARS_LIMIT = 10_000_000;

export interface ChunkMoverState extends ChunkMoverCounts {
  runId: string;
  mode: ChunkMoverMode;
  org: string | null;
  repair: boolean;
  /** copy, verify, clear: last rowid done. */
  cur: number;
  /** clear: the highest rowid when the run started; the walk stops there. */
  upto: number | null;
  /** clear: most rows the run may clear. */
  maxClears: number;
  /** orphans: last object key done; null before the first page. */
  listAfter: string | null;
  /** orphans: delete what the sweep finds (report only otherwise). */
  deleteOrphans: boolean;
  /** orphans: most objects the run may delete. */
  maxDeletes: number;
  active: boolean;
  startedAt: string;
  finishedAt: string | null;
  stoppedReason: string | null;
  batches: number;
  errors: number;
  consecutiveErrors: number;
  lastError: string | null;
  /** First problem chunk ids (copy, verify, clear) or object keys (orphans) seen — ids only, never text. */
  samples: string[];
}

interface StartBody {
  mode?: unknown;
  org?: unknown;
  start?: unknown;
  repair?: unknown;
  delete?: unknown;
  maxDeletes?: unknown;
  maxClears?: unknown;
  force?: unknown;
}

export interface StartOptions {
  mode: ChunkMoverMode;
  org: string | null;
  start: number;
  repair: boolean;
  deleteOrphans: boolean;
  maxDeletes: number;
  maxClears: number;
  force: boolean;
}

/** Local copy of index.ts's wrapper — importing index here would cycle. */
function resilient(env: Env): Env {
  return env?.DB ? { ...env, DB: withD1Retry(env.DB) } : env;
}

export function parseStart(body: StartBody): StartOptions | string {
  if (body.mode === "orphans") return parseOrphansStart(body);
  if (body.mode !== "copy" && body.mode !== "verify" && body.mode !== "clear") {
    return 'mode must be "copy", "verify", "clear" or "orphans"';
  }
  if (body.delete !== undefined || body.maxDeletes !== undefined) return "delete and maxDeletes apply to orphans only";
  let maxClears = 0;
  if (body.mode === "clear") {
    if (
      typeof body.maxClears !== "number" ||
      !Number.isSafeInteger(body.maxClears) ||
      body.maxClears < 1 ||
      body.maxClears > MAX_CLEARS_LIMIT
    ) {
      return `clear needs maxClears, an integer from 1 to ${MAX_CLEARS_LIMIT}: the most rows this run may clear`;
    }
    maxClears = body.maxClears;
  } else if (body.maxClears !== undefined) {
    return "maxClears applies to clear only";
  }
  let org: string | null = null;
  if (body.org !== undefined && body.org !== null) {
    if (typeof body.org !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(body.org)) return "org must be an organization id";
    org = body.org;
  }
  let start = 0;
  if (body.start !== undefined) {
    if (typeof body.start !== "number" || !Number.isSafeInteger(body.start) || body.start < 0) {
      return "start must be a non-negative integer rowid";
    }
    start = body.start;
  }
  if (body.repair !== undefined && typeof body.repair !== "boolean") return "repair must be a boolean";
  if (body.repair === true && body.mode !== "verify") return "repair applies to verify only";
  return {
    mode: body.mode,
    org,
    start,
    repair: body.repair === true,
    deleteOrphans: false,
    maxDeletes: 0,
    maxClears,
    force: body.force === true,
  };
}

/**
 * The sweep lists the whole bucket — keys are not grouped by organization —
 * so org and start do not apply, and it never writes a copy, so repair does
 * not either. Refused rather than ignored: an operator who passes org
 * expects a run limited to it.
 */
function parseOrphansStart(body: StartBody): StartOptions | string {
  if (body.org !== undefined || body.start !== undefined || body.repair !== undefined) {
    return "org, start and repair do not apply to orphans: the sweep lists the whole bucket";
  }
  if (body.maxClears !== undefined) return "maxClears applies to clear only";
  if (body.delete !== undefined && typeof body.delete !== "boolean") return "delete must be a boolean";
  const deleteOrphans = body.delete === true;
  let maxDeletes = 0;
  if (deleteOrphans) {
    if (
      typeof body.maxDeletes !== "number" ||
      !Number.isSafeInteger(body.maxDeletes) ||
      body.maxDeletes < 1 ||
      body.maxDeletes > MAX_DELETES_LIMIT
    ) {
      return `delete needs maxDeletes, an integer from 1 to ${MAX_DELETES_LIMIT}: the most objects this run may remove (take it from a report run's orphans)`;
    }
    maxDeletes = body.maxDeletes;
  } else if (body.maxDeletes !== undefined) {
    return "maxDeletes applies only with delete: true";
  }
  return {
    mode: "orphans",
    org: null,
    start: 0,
    repair: false,
    deleteOrphans,
    maxDeletes,
    maxClears: 0,
    force: body.force === true,
  };
}

export class ChunkMoverDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private s: ChunkMoverState | null = null;
  private loaded = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    // Constructed straight from the module export, so it never passes
    // through index.ts's wrappers; opt in to the D1 retry like DrainerDO.
    this.env = resilient(env);
  }

  private async current(): Promise<ChunkMoverState | null> {
    if (!this.loaded) {
      this.s = ((await this.state.storage.get("s")) as ChunkMoverState | undefined) ?? null;
      this.loaded = true;
    }
    return this.s;
  }

  private async save(s: ChunkMoverState): Promise<void> {
    this.s = s;
    await this.state.storage.put("s", s);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const s = await this.current();

    if (req.method === "POST" && url.pathname === "/start") {
      let body: StartBody;
      try {
        body = (await req.json()) as StartBody;
      } catch {
        return Response.json({ error: "body must be JSON" }, { status: 400 });
      }
      const parsed = parseStart(body ?? {});
      if (typeof parsed === "string") return Response.json({ error: parsed }, { status: 400 });
      if (s?.active && !parsed.force) {
        return Response.json({ error: "a run is active; stop it or pass force", status: s }, { status: 409 });
      }
      // A clear walks only the rows there now: each row it clears moves
      // above all of them (clearChunkTexts), and rows saved after the start
      // are inside the settle window anyway.
      let upto: number | null = null;
      if (parsed.mode === "clear") {
        try {
          upto = await getMaxChunkRowid(this.env.DB);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ error: `could not read the highest rowid: ${message}` }, { status: 503 });
        }
      }
      const next: ChunkMoverState = {
        ...emptyCounts(),
        runId: crypto.randomUUID(),
        mode: parsed.mode,
        org: parsed.org,
        repair: parsed.repair,
        cur: parsed.start,
        upto,
        maxClears: parsed.maxClears,
        listAfter: null,
        deleteOrphans: parsed.deleteOrphans,
        maxDeletes: parsed.maxDeletes,
        active: true,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        stoppedReason: null,
        batches: 0,
        errors: 0,
        consecutiveErrors: 0,
        lastError: null,
        samples: [],
      };
      await this.save(next);
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({ started: true, ...next });
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      if (!s) return Response.json({ stopped: false, reason: "never started" });
      if (s.active) {
        s.active = false;
        s.stoppedReason = "stopped by admin";
        s.finishedAt = new Date().toISOString();
        await this.save(s);
      }
      await this.state.storage.deleteAlarm();
      return Response.json({ stopped: true, ...s });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      const alarm = await this.state.storage.getAlarm();
      return Response.json({ ...(s ?? { active: false, never_started: true }), alarmSet: alarm !== null });
    }

    return Response.json({ error: "not found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    const s = await this.current();
    if (!s?.active) return;
    // A /stop or a forced /start can arrive while a page is in flight (the
    // object takes requests during I/O). Both replace or deactivate this.s;
    // re-check after every page and never write over them.
    const runId = s.runId;
    const live = () => this.s !== null && this.s.runId === runId && this.s.active;

    for (let i = 0; i < BATCHES_PER_ALARM; i++) {
      try {
        // Set when this page ends the run for a reason of its own.
        let halted = false;
        let done: boolean;
        let counts: ChunkMoverCounts;
        let problems: string[];
        if (s.mode === "orphans") {
          const left = Math.max(0, s.maxDeletes - (s.orphansRemoved ?? 0));
          const b = await runOrphanSweepBatch(this.env, {
            after: s.listAfter,
            deleteOrphans: s.deleteOrphans,
            deleteBudget: left,
          });
          if (!live()) {
            // The page's deletes happened; only its counts go with it. Say
            // so, or those removals would be in no count anywhere.
            if (b.orphansRemoved > 0) {
              console.log(
                `[chunk-mover] orphans run ${runId} ended while a page was in flight; ` +
                  `that page removed ${b.orphansRemoved} orphaned objects, which are not in the run's counts`,
              );
            }
            return;
          }
          if (b.capped) {
            halted = true;
            s.stoppedReason =
              `delete cap: the page after ${position(s)} has ${b.orphans} orphans and ${left} of maxDeletes ${s.maxDeletes} ` +
              `are left; nothing on that page was deleted`;
          }
          s.listAfter = b.nextAfterKey;
          ({ done, problems } = b);
          counts = b;
        } else if (s.mode === "clear") {
          // Only a run /start set up has both its ceiling and its cap; a
          // stored run without them is stopped, never walked.
          const upto = s.upto;
          const setUp = typeof upto === "number" && Number.isSafeInteger(s.maxClears);
          // Never read more rows than the run may still clear, so a page
          // cannot take it past maxClears.
          const left = setUp ? Math.max(0, s.maxClears - (s.cleared ?? 0)) : 0;
          if (typeof upto !== "number" || left === 0) {
            s.active = false;
            s.finishedAt = new Date().toISOString();
            s.stoppedReason = setUp
              ? `clear cap: cleared ${s.cleared ?? 0} rows, the maxClears of this run; resume with start ${s.cur}`
              : "clear run has no upto or maxClears; start it again";
            await this.save(s);
            break;
          }
          const b = await runChunkClearBatch(this.env, {
            after: s.cur,
            upto,
            org: s.org,
            limit: Math.min(CLEAR_PAGE, left),
          });
          if (!live()) {
            // The page's clears happened; only its counts go with it.
            if (b.cleared > 0 || b.restored > 0) {
              console.log(
                `[chunk-mover] clear run ${runId} ended while a page was in flight; ` +
                  `that page cleared ${b.cleared} and restored ${b.restored} rows, which are not in the run's counts`,
              );
            }
            return;
          }
          if (b.lost > 0) {
            halted = true;
            s.stoppedReason =
              `lost: the page after ${position(s)} found ${b.lost} cleared rows with no object ` +
              `(their ids are in samples); clearing stopped`;
          }
          s.cur = b.nextAfter;
          ({ done, problems } = b);
          counts = b;
        } else {
          const b = await runChunkMoverBatch(this.env, {
            mode: s.mode,
            org: s.org,
            after: s.cur,
            repair: s.repair,
          });
          if (!live()) return;
          s.cur = b.nextAfter;
          ({ done, problems } = b);
          counts = b;
        }
        // `?? 0`: a run started before a count existed has no such field in
        // storage, and undefined + n would poison it with NaN.
        for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) {
          s[k] = (s[k] ?? 0) + counts[k];
        }
        for (const id of problems) if (s.samples.length < MAX_SAMPLES) s.samples.push(id);
        s.batches++;
        s.consecutiveErrors = 0;
        if (halted || done) {
          s.active = false;
          s.finishedAt = new Date().toISOString();
          if (!halted) s.stoppedReason = "finished";
        }
        await this.save(s);
        if (!s.active) break;
      } catch (err) {
        if (!live()) return;
        s.errors++;
        s.consecutiveErrors++;
        s.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        console.error(`[chunk-mover] page after ${position(s)} failed (${s.consecutiveErrors} in a row): ${s.lastError}`);
        if (err instanceof ChunkRestoreError) {
          for (const id of err.chunkIds) if (s.samples.length < MAX_SAMPLES) s.samples.push(id);
          s.active = false;
          s.finishedAt = new Date().toISOString();
          s.stoppedReason =
            `restore failed after ${position(s)}: ${err.chunkIds.length} cleared rows whose objects went missing ` +
            `or changed could not be given their text back (their ids are in samples); clearing stopped`;
        } else if (s.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          s.active = false;
          s.finishedAt = new Date().toISOString();
          s.stoppedReason = `stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`;
        }
        await this.save(s);
        break;
      }
    }

    if (!live()) {
      const counts = (Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>)
        .map((k) => `${k}=${s[k] ?? 0}`)
        .join(" ");
      console.log(`[chunk-mover] ${s.mode} ${s.stoppedReason ?? "ended"}: ${counts} errors=${s.errors}`);
      return;
    }
    const delay =
      s.consecutiveErrors > 0
        ? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (s.consecutiveErrors - 1))
        : REARM_MS;
    await this.state.storage.setAlarm(Date.now() + delay);
  }
}

/** Where a run is, for logs: a rowid, or for orphans the last key listed. */
function position(s: ChunkMoverState): string {
  if (s.mode === "orphans") return s.listAfter === null ? "the start of the bucket" : `key ${s.listAfter}`;
  return `rowid ${s.cur}`;
}
