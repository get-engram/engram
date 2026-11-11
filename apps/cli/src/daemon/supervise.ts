/**
 * What the Windows daemon's supervisor does (engram#613), apart from the
 * processes and files it does it with, which supervisor.ts passes in.
 *
 * Windows has nothing like launchd's KeepAlive for a program a user starts
 * without admin rights (Task Scheduler's at-sign-in trigger needs them), so
 * a daemon that crashed stayed stopped until the next sign-in, and capture
 * with it. The supervisor starts the worker, and starts it again when it
 * exits with an error, waiting longer each time, as launchd does on macOS.
 *
 * It doesn't start it again when:
 * - it exited 0: it was stopped, or another daemon has the lock;
 * - `engram stop` asked it to stop (STOP_FILE changed since it started):
 *   one that ended with an error while stopping, or that `engram stop`
 *   ended because it didn't take the request, stays stopped;
 * - another daemon answers by the time it would start it;
 * - it failed MAX_FAILURES times in a row, over about 25 minutes: something
 *   is wrong that starting again won't fix, and the log says what. `engram
 *   status` points there. Starting it again without end would also repeat,
 *   each time, any send it was making when it failed, which the server may
 *   then get twice;
 * - `engram start` is waiting on the first worker, and it exits with
 *   START_FAILED_EXIT: the supervisor exits with that code, and `engram
 *   start` reports the failure.
 *
 * IMPORTANT: no imports. worker.ts imports START_FAILED_EXIT from here
 * before its preflight; see launch.ts.
 */

/**
 * What the worker exits with when it fails before it is ready: its
 * preflight or its setup failed. Never once it is ready, so a worker that
 * exits with it can't have been reported as started. Any other error exit
 * may come from one that was, and is started again.
 */
export const START_FAILED_EXIT = 3;

/** The first wait before starting a worker again. It doubles each time, up to MAX_DELAY_MS: 10s, 20s, 40s, 80s, 160s, then 5 minutes. */
export const FIRST_DELAY_MS = 10_000;
export const MAX_DELAY_MS = 5 * 60_000;
/** A worker that ran this long before it failed counts as the first failure. */
export const STABLE_MS = 10 * 60_000;
/** Failures in a row after which the supervisor gives up: after waits of about 25 minutes in all. */
export const MAX_FAILURES = 10;
/** How often it looks for a stop request while it waits to start a worker again. */
export const POLL_MS = 1_000;

export interface SuperviseDeps {
  /**
   * Start a worker; resolves to its exit code once it exits: null when it
   * was ended without one, or couldn't be started. May throw.
   */
  start(): Promise<number | null>;
  /** Whether a daemon answers, and isn't stopping. */
  running(): Promise<boolean>;
  /** Which stop request STOP_FILE holds (its stamp), or null when it holds none. */
  stopStamp(): string | null;
  /** Remove STOP_FILE if it still holds the request with this stamp. */
  removeStop(stamp: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
}

export interface SuperviseOptions {
  /**
   * Until when (as from now()) `engram start` waits on the first worker, a
   * moment before it gives up waiting; 0 when nothing waits, as at sign-in.
   */
  reportUntil: number;
  /**
   * `engram <rest>` as the log names a command to run: as the user runs the
   * CLI that runs this supervisor (engram#727), `npx @getengram/cli start`
   * from npx's cache.
   */
  command: (rest: string) => string;
}

/** The time a `--report-until=<ms since the epoch>` argument gives, or 0 when there is none. */
export function reportUntilArg(args: readonly string[]): number {
  for (const arg of args) {
    const match = /^--report-until=(\d{1,15})$/.exec(arg);
    if (match) return Number(match[1]);
  }
  return 0;
}

/** Run workers until one of the reasons above; resolves to the supervisor's exit code. */
export async function supervise(deps: SuperviseDeps, options: SuperviseOptions): Promise<number> {
  let failures = 0;
  let reportUntil = options.reportUntil;
  const { command } = options;
  for (;;) {
    const before = deps.stopStamp();
    const startedAt = deps.now();
    let code: number | null;
    try {
      code = await deps.start();
    } catch (err) {
      deps.log(`couldn't start the daemon: ${err instanceof Error ? err.message : String(err)}`);
      code = null;
    }
    const reported = code === START_FAILED_EXIT && deps.now() < reportUntil;
    reportUntil = 0;

    if (stopRequested(deps, before)) return 0;
    if (code === 0) return 0;
    if (reported) {
      deps.log(`the daemon couldn't start (exit code ${code}); '${command("start")}' reports it, and it isn't started again`);
      return START_FAILED_EXIT;
    }
    if (deps.now() - startedAt >= STABLE_MS) failures = 0;
    failures += 1;
    if (failures >= MAX_FAILURES) {
      deps.log(
        `the daemon exited ${how(code)}, ${failures} times in a row; not starting it again until '${command("start")}' or the next sign-in`,
      );
      return code ?? 1;
    }
    const delay = Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS);
    deps.log(`the daemon exited ${how(code)}; starting it again in ${Math.round(delay / 1000)}s`);
    if (await waitUnlessStopped(deps, delay, before)) return 0;
    if (await deps.running()) {
      deps.log("another daemon is running; leaving the capture to it");
      return 0;
    }
  }
}

function how(code: number | null): string {
  return code === null ? "without an exit code" : `with code ${code}`;
}

/** `engram stop` wrote a request since `before`: remove it, and say so. */
function stopRequested(deps: SuperviseDeps, before: string | null): boolean {
  const stamp = deps.stopStamp();
  if (stamp === null || stamp === before) return false;
  deps.removeStop(stamp);
  deps.log("stopped by 'engram stop'; not starting it again");
  return true;
}

/** Wait `ms`, looking every POLL_MS for a stop request; true when one came. */
async function waitUnlessStopped(deps: SuperviseDeps, ms: number, before: string | null): Promise<boolean> {
  const until = deps.now() + ms;
  for (;;) {
    const left = until - deps.now();
    if (left <= 0) return stopRequested(deps, before);
    await deps.sleep(Math.min(POLL_MS, left));
    if (stopRequested(deps, before)) return true;
  }
}
