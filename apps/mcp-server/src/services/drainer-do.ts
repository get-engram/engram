import { drainBatch } from "./drain-batch.js";
import type { Env } from "../types.js";

/**
 * DrainerDO — one autonomous drain worker as a Durable Object. Each instance
 * owns a rowid window and drains it via self-rescheduling alarms. An alarm
 * invocation is a top-level invocation with its own full subrequest budget,
 * so N instances give true N-way parallelism, entirely on Cloudflare — no
 * external driver, survives laptops, deploys, and restarts (alarm + cursor
 * live in durable storage).
 *
 * Control via fetch: POST /start {start,end}, POST /stop, GET /status.
 * Each alarm runs ~25s of batches, persists the cursor, then re-arms itself
 * until its window is empty (drainBatch.done or cursor past end).
 */
const BATCH = 120;
const ALARM_BUDGET_MS = 25_000;
const REARM_DELAY_MS = 250;

interface DrainerState {
  cur: number;
  end: number;
  active: boolean;
  moved: number;
  errors: number;
}

export class DrainerDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async load(): Promise<DrainerState> {
    return (
      ((await this.state.storage.get("s")) as DrainerState | undefined) ?? {
        cur: 0,
        end: 0,
        active: false,
        moved: 0,
        errors: 0,
      }
    );
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/start") {
      const body = (await req.json()) as { start: number; end: number };
      const s: DrainerState = {
        cur: body.start,
        end: body.end,
        active: true,
        moved: 0,
        errors: 0,
      };
      await this.state.storage.put("s", s);
      await this.state.storage.setAlarm(Date.now() + 100);
      return Response.json({ started: true, ...s });
    }
    if (req.method === "POST" && url.pathname === "/stop") {
      const s = await this.load();
      s.active = false;
      await this.state.storage.put("s", s);
      await this.state.storage.deleteAlarm();
      return Response.json({ stopped: true, moved: s.moved });
    }
    // GET /status
    const s = await this.load();
    const alarm = await this.state.storage.getAlarm();
    return Response.json({ ...s, alarmSet: alarm !== null });
  }

  async alarm(): Promise<void> {
    const s = await this.load();
    if (!s.active) return;

    const started = Date.now();
    let windowDone = false;
    while (Date.now() - started < ALARM_BUDGET_MS) {
      try {
        const r = await drainBatch(this.env, s.cur, BATCH);
        s.moved += r.swapped;
        if (r.done) {
          windowDone = true; // nothing left anywhere past cursor
          break;
        }
        s.cur = r.nextAfter;
        if (s.cur >= s.end) {
          windowDone = true; // window complete; the next window owns the rest
          break;
        }
      } catch (err) {
        s.errors += 1;
        console.error(
          `[drainer-do] batch failed at cur=${s.cur}: ${err instanceof Error ? err.message : err}`,
        );
        break; // persist state, re-arm, retry same cursor next alarm
      }
    }

    if (windowDone) s.active = false;
    await this.state.storage.put("s", s);
    if (s.active) {
      await this.state.storage.setAlarm(Date.now() + REARM_DELAY_MS);
    } else {
      console.log(`[drainer-do] window finished: moved=${s.moved} errors=${s.errors}`);
    }
  }
}
