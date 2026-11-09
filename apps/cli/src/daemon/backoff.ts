/**
 * How long the daemon waits before trying again after a request failed in
 * a way that passes on its own (engram#596): an error on the server's
 * side, a timeout, the server out of reach, a rate limit, a maintenance
 * pause. Each of these was retried at the next flush, every 2 s, for as
 * long as it lasted, by every daemon running.
 *
 * The wait doubles with each failure in a row, from RETRY_BASE_MS up to
 * RETRY_CAP_MS, and is drawn at random between half and all of that
 * ("equal jitter"). Daemons that failed together, in an outage or a
 * maintenance pause, come back spread out rather than all at once, and
 * until the cap a wait is never shorter than the one before it.
 */

/** The longest first wait. */
export const RETRY_BASE_MS = 5_000;
/** The longest wait. A few minutes: what the daemon queued meanwhile goes
 *  out soon after the server is back. */
export const RETRY_CAP_MS = 5 * 60_000;

/**
 * The wait after `failures` failures in a row (1 for the first), in ms.
 * `random` is for tests.
 */
export function retryDelay(failures: number, random: () => number = Math.random): number {
  const doublings = Math.min(Math.max(failures - 1, 0), 30);
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** doublings);
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** A wait in words, for the log and `engram status`: "4s", "2m 30s". */
export function formatWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
