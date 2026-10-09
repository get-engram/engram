/**
 * Retry D1 through transient back-pressure (engram#469 / Oct 2026 incident).
 *
 * Cloudflare D1 is a single-threaded SQLite instance per database: queries
 * execute serially, and when the queue backs up D1 rejects with
 * "D1 DB is overloaded. Requests queued for too long." On 2026-10-06 four
 * concurrent searches from ONE user were enough to trigger it, and the worker
 * turned that into a 503.
 *
 * SAFETY MODEL — this is the whole design, read it before changing anything.
 *
 * A retry is only safe when the statement provably did not run. We therefore
 * split errors into two classes:
 *
 *   QUEUE_REJECTED — D1 refused the query before executing it. Nothing was
 *                    applied, so retrying is safe even for a write.
 *   TRANSIENT      — busy / timeout / connection lost / storage-layer reset.
 *                    The statement MAY have committed and only the reply was
 *                    lost. Safe for reads; retrying a write here double-applies.
 *
 * And we classify statements by their SQL, NOT by which terminal method the
 * caller used. An earlier version of this file split on the method name —
 * first/all/raw as reads, run as a write — and that was wrong in a way that
 * silently corrupts billing: this codebase increments its counters with
 * `UPDATE ... RETURNING` executed via `.first()`
 * (atomicIncrementStorage, incrementStorage, atomicIncrementMessages,
 * getOrCreateUsage). Those are writes wearing a read's clothing, and they got
 * the read policy. A lost reply after a committed `messages_stored_total += 50`
 * became +100, permanently, on the counter that gates billing.
 *
 * Classification is deliberately conservative: anything not clearly a pure
 * read is treated as a mutation, because the cost of guessing wrong in that
 * direction is only a missed retry.
 *
 * WHAT THIS DOES NOT FIX: the observed incident took ~20 seconds to clear. A
 * request cannot sit still that long, so the budget here (~3s worst case)
 * absorbs a brief collision, not a sustained overload. Sustained pressure
 * still surfaces as 503, and the real remedies are a shared per-org
 * concurrency limit and sharding the database — both tracked separately.
 */

/**
 * D1 refused the query before running it — provably not applied.
 *
 * Deliberately narrow. "storage operation exceeded timeout" is NOT here: it
 * is a storage-layer reset that can fire after a commit, so treating it as
 * pre-execution would make write retries unsafe.
 */
const QUEUE_REJECTED = /D1 DB is overloaded|Requests queued for too long/i;

/**
 * May or may not have been applied — reads only.
 * Kept at least as broad as the predicate the top-level error handler used
 * before this file existed, so the 503 + Retry-After mapping never narrows.
 */
const TRANSIENT =
  /overloaded|SQLITE_BUSY|database is locked|Network connection lost|timed out|connection reset|storage.*(unavailable|busy)|storage operation exceeded timeout|\b(7009|7429)\b/i;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The statement provably never executed. */
export function isQueueRejection(err: unknown): boolean {
  return QUEUE_REJECTED.test(message(err));
}

/** Transient D1 pressure of any kind — what the error handler maps to 503. */
export function isTransientD1Error(err: unknown): boolean {
  const m = message(err);
  return QUEUE_REJECTED.test(m) || TRANSIENT.test(m);
}

/**
 * Does this SQL modify anything?
 *
 * Conservative by construction: returns true unless the statement is clearly
 * a pure read. A false positive costs one skipped retry; a false negative
 * costs a double-applied write.
 */
export function isMutation(sql: string): boolean {
  // Strip leading whitespace and comments so the first keyword is visible.
  const head = sql
    .replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
    .slice(0, 512)
    .toUpperCase();

  if (/^(?:SELECT|PRAGMA|EXPLAIN)\b/.test(head)) return false;
  // A CTE may front either a read or a write.
  if (/^WITH\b/.test(head)) {
    return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/.test(head);
  }
  return true;
}

export interface RetryOptions {
  /** Attempts after the first. Default 5. */
  maxRetries?: number;
  /** First backoff ceiling in ms; doubles each attempt. Default 100. */
  baseDelayMs?: number;
  /** Upper bound on any single sleep. Default 2000. */
  maxDelayMs?: number;
  /** Give up once cumulative sleep exceeds this, so a request can't hang. */
  totalBudgetMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const DEFAULTS = {
  maxRetries: 5,
  baseDelayMs: 100,
  maxDelayMs: 2000,
  totalBudgetMs: 3000,
};

async function runWithRetry<T>(
  op: () => Promise<T>,
  mutation: boolean,
  opts: RetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const totalBudgetMs = opts.totalBudgetMs ?? DEFAULTS.totalBudgetMs;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;

  let slept = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      // A statement that may have been applied is never retried when it
      // mutates — at-most-once beats at-least-once for an INSERT.
      const retryable = mutation
        ? isQueueRejection(err)
        : isTransientD1Error(err);
      if (!retryable || attempt >= maxRetries) throw err;

      // Full jitter: sleep uniformly in [0, ceiling). The failure mode is N
      // callers colliding, and un-jittered backoff would reconverge on the
      // same instant and collide again.
      const ceiling = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const delay = Math.floor(random() * ceiling);
      if (slept + delay > totalBudgetMs) throw err;
      slept += delay;
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/**
 * Wrap a D1Database so transient back-pressure is retried transparently.
 * Callers keep using the handle exactly as before.
 */
export function withD1Retry(db: D1Database, opts: RetryOptions = {}): D1Database {
  const onRetry =
    opts.onRetry ??
    ((attempt: number, delayMs: number, err: unknown) =>
      console.warn(`[d1-retry] attempt ${attempt} after ${delayMs}ms — ${message(err)}`));
  const o: RetryOptions = { ...opts, onRetry };

  return new Proxy(db, {
    get(target, prop) {
      // NB: no receiver argument. Passing the proxy as receiver re-enters this
      // trap for accessor-backed properties and throws on some runtimes.
      const value = Reflect.get(target, prop);

      if (prop === "prepare") {
        return (query: string): D1PreparedStatement =>
          wrapStatement(
            (value as D1Database["prepare"]).call(target, query),
            isMutation(query),
            o,
          );
      }

      // batch() is atomic, but atomicity is not idempotency: a batch that
      // COMMITTED and then lost its reply would be re-applied. Only a queue
      // rejection — where nothing ran — is safe here.
      if (prop === "batch") {
        return <T = unknown>(statements: D1PreparedStatement[]) =>
          runWithRetry<D1Result<T>[]>(
            () =>
              (value as D1Database["batch"]).call(target, statements) as Promise<
                D1Result<T>[]
              >,
            true,
            o,
          );
      }

      // A session is a handle in its own right — wrap it or every query made
      // through it silently escapes the retry layer.
      if (prop === "withSession") {
        return (...args: unknown[]) => {
          const session = (value as (...a: unknown[]) => unknown).apply(target, args);
          return wrapSession(session as D1DatabaseSession, o);
        };
      }

      // exec() runs raw multi-statement SQL outside a transaction, so a
      // partial apply is possible. Never retried.
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as D1Database;
}

type D1DatabaseSession = { prepare(query: string): D1PreparedStatement };

function wrapSession<S extends D1DatabaseSession>(session: S, opts: RetryOptions): S {
  return new Proxy(session, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === "prepare") {
        return (query: string) =>
          wrapStatement(
            (value as S["prepare"]).call(target, query),
            isMutation(query),
            opts,
          );
      }
      if (typeof value === "function") return value.bind(target);
      return value;
    },
  }) as S;
}

function wrapStatement(
  stmt: D1PreparedStatement,
  mutation: boolean,
  opts: RetryOptions,
): D1PreparedStatement {
  return new Proxy(stmt, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== "function") return value;

      // bind() returns a NEW statement — it must stay wrapped, and must carry
      // the same mutation classification as the SQL it came from.
      if (prop === "bind") {
        return (...args: unknown[]) =>
          wrapStatement(
            (value as D1PreparedStatement["bind"]).apply(target, args),
            mutation,
            opts,
          );
      }

      // Every terminal method gets the SAME policy, derived from the SQL.
      // `.first()` on an `UPDATE ... RETURNING` is a write.
      if (prop === "first" || prop === "all" || prop === "raw" || prop === "run") {
        return (...args: unknown[]) =>
          runWithRetry(() => value.apply(target, args), mutation, opts);
      }

      return value.bind(target);
    },
  }) as D1PreparedStatement;
}
