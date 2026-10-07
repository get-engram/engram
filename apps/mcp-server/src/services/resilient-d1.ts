/**
 * Retry D1 through transient back-pressure (engram#469 / Oct 2026 incident).
 *
 * Cloudflare D1 is a single-threaded SQLite instance per database: queries
 * execute serially, and when the queue backs up D1 rejects with
 * "D1 DB is overloaded. Requests queued for too long." On 2026-10-06 four
 * concurrent searches from ONE user were enough to trigger it; the worker
 * turned that into a 503 and the user saw a failure. Waiting ~20s and going
 * sequential worked, which is the signature of back-pressure, not a bug.
 *
 * A rejected-from-the-queue query never ran, so retrying it is safe — that is
 * the distinction this module is built around. We separate two error classes:
 *
 *   QUEUE_REJECTED — D1 refused the query before executing it. Safe to retry
 *                    for reads AND writes; the write provably did not happen.
 *   TRANSIENT      — busy/timeout/connection-lost. The query MAY have been
 *                    applied, so only reads are retried. Retrying a write here
 *                    could double-apply it.
 *
 * Backoff is exponential with full jitter. Jitter matters more than the delay:
 * the failure mode is N concurrent queries colliding, and un-jittered retries
 * would reconverge on the same instant and collide again.
 */

/** D1 refused the query before running it — provably not applied. */
const QUEUE_REJECTED =
  /D1 DB is overloaded|Requests queued for too long|storage operation exceeded timeout|\b7429\b/i;

/** May or may not have been applied — safe to retry only for reads. */
const TRANSIENT =
  /SQLITE_BUSY|database is locked|Network connection lost|timed out|connection reset|storage.*(unavailable|busy)|\b7009\b/i;

export function isQueueRejection(err: unknown): boolean {
  return QUEUE_REJECTED.test(err instanceof Error ? err.message : String(err));
}

/** Transient D1 pressure of any kind — what the top-level handler maps to 503. */
export function isTransientD1Error(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return QUEUE_REJECTED.test(msg) || TRANSIENT.test(msg);
}

export interface RetryOptions {
  /** Attempts after the first. Default 3 → up to 4 executions. */
  maxRetries?: number;
  /** First backoff ceiling in ms; doubles each attempt. Default 50. */
  baseDelayMs?: number;
  /** Upper bound on any single sleep. Default 1000. */
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const DEFAULTS = { maxRetries: 3, baseDelayMs: 50, maxDelayMs: 1000 };

async function runWithRetry<T>(
  op: () => Promise<T>,
  writeSafeOnly: boolean,
  opts: RetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      // A statement that may have been applied is never retried on a write
      // path — at-most-once beats at-least-once when the caller is an INSERT.
      const retryable = writeSafeOnly
        ? isQueueRejection(err)
        : isTransientD1Error(err);
      if (!retryable || attempt >= maxRetries) throw err;

      // Full jitter: sleep uniformly in [0, ceiling) rather than at the
      // ceiling, so colliding callers scatter instead of re-colliding.
      const ceiling = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.floor(random() * ceiling);
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/**
 * Wrap a D1Database so transient back-pressure is retried transparently.
 * Returns a proxy — callers keep using `env.DB` exactly as before.
 */
export function withD1Retry(db: D1Database, opts: RetryOptions = {}): D1Database {
  const log =
    opts.onRetry ??
    ((attempt: number, delayMs: number, err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[d1-retry] attempt ${attempt} after ${delayMs}ms — ${msg}`);
    });
  const o: RetryOptions = { ...opts, onRetry: log };

  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      if (prop === "prepare") {
        return (query: string): D1PreparedStatement => {
          const stmt = (value as D1Database["prepare"]).call(target, query);
          return wrapStatement(stmt, o);
        };
      }

      // batch() is all-or-nothing in D1, so a queue rejection leaves nothing
      // applied — same safety argument as a single write.
      if (prop === "batch") {
        return <T = unknown>(statements: D1PreparedStatement[]) =>
          runWithRetry<D1Result<T>[]>(
            () => (value as D1Database["batch"]).call(target, statements) as Promise<D1Result<T>[]>,
            true,
            o,
          );
      }

      // exec() runs raw multi-statement SQL with no transaction — a partial
      // apply is possible, so never retry it.
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as D1Database;
}

function wrapStatement(
  stmt: D1PreparedStatement,
  opts: RetryOptions,
): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      // bind() returns a NEW statement — it must stay wrapped.
      if (prop === "bind") {
        return (...args: unknown[]) =>
          wrapStatement(
            (value as D1PreparedStatement["bind"]).apply(target, args),
            opts,
          );
      }

      // Reads: retry the whole transient class.
      if (prop === "first" || prop === "all" || prop === "raw") {
        return (...args: unknown[]) =>
          runWithRetry(() => value.apply(target, args), false, opts);
      }

      // Writes: only retry when D1 provably never ran the statement.
      if (prop === "run") {
        return (...args: unknown[]) =>
          runWithRetry(() => value.apply(target, args), true, opts);
      }

      return value.bind(target);
    },
  }) as D1PreparedStatement;
}
