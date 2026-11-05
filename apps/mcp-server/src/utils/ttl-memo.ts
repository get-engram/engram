/**
 * A single-value memo with a TTL, in-flight de-duplication and
 * serve-stale-on-error (engram#551).
 *
 * Built for figures that are expensive to compute and fine to be a few
 * minutes old. The admin activation funnel is ~1.7 s of D1 time and ~5.5M
 * rows read per run, the admin page asks for it every 30 s, and nothing on
 * that page needs lifetime cohort counts fresher than minutes.
 *
 * - Within `ttlMs` of a successful compute, callers get the stored value.
 * - Past the TTL, concurrent callers share ONE compute; a second one never
 *   starts while the first is in flight.
 * - When a recompute throws and a previous value exists, the previous value
 *   is served and no recompute is attempted for `errorBackoffMs`. When the
 *   database is overloaded, the one thing not to do is send it the heaviest
 *   query in the codebase again every 30 seconds.
 * - When a compute throws and there is nothing to fall back on, the error
 *   propagates: a cold isolate behaves exactly as the uncached code did.
 *
 * One instance holds one value. Keep it at module scope: Workers bindings
 * (and the per-request retry wrapper around D1) differ per request, so a
 * memo keyed on them would never hit.
 */
export interface TtlMemoOptions {
  /** How long a computed value is served without recomputing. */
  ttlMs: number;
  /**
   * After a failed recompute, how long the stale value is served before the
   * next call tries again. Default 0: retry on the next call.
   */
  errorBackoffMs?: number;
  /** Clock, injectable for tests. Defaults to Date.now, read lazily. */
  now?: () => number;
  /** Called when a recompute fails and a stale value is served instead. */
  onStale?: (err: unknown, ageMs: number) => void;
}

export interface TtlMemo<T> {
  /** The stored value if fresh, else the result of `compute` (shared with concurrent callers). */
  get(compute: () => Promise<T>): Promise<T>;
  /** The stored value and its age without computing anything. */
  peek(): { value: T; ageMs: number; fresh: boolean } | null;
  /** Forget everything, including a compute in flight. */
  reset(): void;
}

export function createTtlMemo<T>(opts: TtlMemoOptions): TtlMemo<T> {
  const now = opts.now ?? (() => Date.now());
  const backoffMs = opts.errorBackoffMs ?? 0;

  let entry: { value: T; at: number } | null = null;
  let inFlight: Promise<T> | null = null;
  let failedAt: number | null = null;

  async function run(compute: () => Promise<T>): Promise<T> {
    try {
      const value = await compute();
      entry = { value, at: now() };
      failedAt = null;
      return value;
    } catch (err) {
      failedAt = now();
      if (entry) {
        opts.onStale?.(err, failedAt - entry.at);
        return entry.value;
      }
      throw err;
    }
  }

  return {
    get(compute) {
      const t = now();
      if (entry && t - entry.at < opts.ttlMs) return Promise.resolve(entry.value);
      if (inFlight) return inFlight;
      if (entry && failedAt !== null && t - failedAt < backoffMs) {
        return Promise.resolve(entry.value);
      }
      const p = run(compute).finally(() => {
        // Only clear our own flight: reset() may have replaced it meanwhile.
        if (inFlight === p) inFlight = null;
      });
      inFlight = p;
      return p;
    },
    peek() {
      if (!entry) return null;
      const ageMs = now() - entry.at;
      return { value: entry.value, ageMs, fresh: ageMs < opts.ttlMs };
    },
    reset() {
      entry = null;
      inFlight = null;
      failedAt = null;
    },
  };
}
