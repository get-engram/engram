import {
  emptyCounts,
  runChunkMoverBatch,
  type ChunkMoverCounts,
  type ChunkMoverMode,
} from "./chunk-mover.js";
import { withD1Retry } from "./resilient-d1.js";
import type { Env } from "../types.js";

/**
 * ChunkMoverDO — runs the engram#384 chunk job (chunk-mover.ts) over the
 * whole table, or one organization, as self-rescheduling alarms. One named
 * instance ("chunk-mover"); the cursor and counts live in durable storage,
 * so it survives deploys and restarts.
 *
 * Paced for a database that runs one statement at a time (engram#552): a
 * few pages per alarm, each a bounded rowid-range read, then a pause before
 * the next alarm, backing off on errors and stopping after a run of them.
 *
 * Control via fetch (behind /admin/chunk-mover/*):
 *   POST /start {mode: "copy"|"verify", org?, start?, repair?, force?}
 *   POST /stop
 *   GET  /status
 */

const BATCHES_PER_ALARM = 4;
const REARM_MS = 750;
const MAX_BACKOFF_MS = 60_000;
const MAX_CONSECUTIVE_ERRORS = 50;
const MAX_SAMPLES = 20;

export interface ChunkMoverState extends ChunkMoverCounts {
  runId: string;
  mode: ChunkMoverMode;
  org: string | null;
  repair: boolean;
  /** Last rowid done. */
  cur: number;
  active: boolean;
  startedAt: string;
  finishedAt: string | null;
  stoppedReason: string | null;
  batches: number;
  errors: number;
  consecutiveErrors: number;
  lastError: string | null;
  /** First problem chunk ids seen (ids only, never text). */
  samples: string[];
}

interface StartBody {
  mode?: unknown;
  org?: unknown;
  start?: unknown;
  repair?: unknown;
  force?: unknown;
}

/** Local copy of index.ts's wrapper — importing index here would cycle. */
function resilient(env: Env): Env {
  return env?.DB ? { ...env, DB: withD1Retry(env.DB) } : env;
}

export function parseStart(body: StartBody): { mode: ChunkMoverMode; org: string | null; start: number; repair: boolean; force: boolean } | string {
  if (body.mode !== "copy" && body.mode !== "verify") return 'mode must be "copy" or "verify"';
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
  return { mode: body.mode, org, start, repair: body.repair === true, force: body.force === true };
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
      const next: ChunkMoverState = {
        ...emptyCounts(),
        runId: crypto.randomUUID(),
        mode: parsed.mode,
        org: parsed.org,
        repair: parsed.repair,
        cur: parsed.start,
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
        const b = await runChunkMoverBatch(this.env, {
          mode: s.mode,
          org: s.org,
          after: s.cur,
          repair: s.repair,
        });
        if (!live()) return;
        for (const k of Object.keys(emptyCounts()) as Array<keyof ChunkMoverCounts>) s[k] += b[k];
        for (const id of b.problems) if (s.samples.length < MAX_SAMPLES) s.samples.push(id);
        s.cur = b.nextAfter;
        s.batches++;
        s.consecutiveErrors = 0;
        if (b.done) {
          s.active = false;
          s.finishedAt = new Date().toISOString();
          s.stoppedReason = "finished";
        }
        await this.save(s);
        if (!s.active) break;
      } catch (err) {
        if (!live()) return;
        s.errors++;
        s.consecutiveErrors++;
        s.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        console.error(`[chunk-mover] page after rowid ${s.cur} failed (${s.consecutiveErrors} in a row): ${s.lastError}`);
        if (s.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          s.active = false;
          s.finishedAt = new Date().toISOString();
          s.stoppedReason = `stopped after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`;
        }
        await this.save(s);
        break;
      }
    }

    if (!live()) {
      console.log(
        `[chunk-mover] ${s.mode} ${s.stoppedReason ?? "ended"}: scanned=${s.scanned} copied=${s.copied} ok=${s.ok} missing=${s.missing} mismatched=${s.mismatched} repaired=${s.repaired} putFailed=${s.putFailed} raced=${s.raced} orphansRemoved=${s.orphansRemoved} clearedOk=${s.clearedOk} lost=${s.lost} errors=${s.errors}`,
      );
      return;
    }
    const delay =
      s.consecutiveErrors > 0
        ? Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (s.consecutiveErrors - 1))
        : REARM_MS;
    await this.state.storage.setAlarm(Date.now() + delay);
  }
}
