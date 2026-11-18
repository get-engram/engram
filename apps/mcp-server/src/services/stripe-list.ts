/**
 * Reading a whole Stripe list for a figure the admin page or the daily
 * report prints: one page at a time, each request bounded by a timeout and
 * given one retry, and a page cap instead of an endless loop.
 *
 * Shared by the subscription read (services/mrr.ts) and the payments read
 * (services/sales.ts) so both fail the same way: with a short reason, and
 * never with part of a list that a caller would add up as the whole.
 */

/** Stripe's largest page. */
export const STRIPE_PAGE_SIZE = 100;
/** Bounds a hung request. Stripe answers these lists in well under a second. */
const STRIPE_TIMEOUT_MS = 10_000;
/** A transient failure (network, timeout, 429, 5xx) gets one more try. */
const STRIPE_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;

interface StripePage<T> {
  data: T[];
  has_more?: boolean;
}

export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The list did not end within its page cap. `limit` is the rows read. */
export class StripeListTooLong extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} rows`);
    this.name = "StripeListTooLong";
  }
}

/**
 * One page of a list. Retries a transient failure once; a refusal such as
 * 401 is not retried, since it would only be refused again. Throws with a
 * short reason that never holds the key.
 */
async function fetchPage<T>(
  key: string,
  path: string,
  query: Record<string, string>,
  startingAfter: string | null,
): Promise<StripePage<T>> {
  const url = new URL(`https://api.stripe.com${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  url.searchParams.set("limit", String(STRIPE_PAGE_SIZE));
  if (startingAfter) url.searchParams.set("starting_after", startingAfter);

  let reason = "";
  for (let attempt = 1; attempt <= STRIPE_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
      });
    } catch (err) {
      reason = `Stripe request failed: ${describeError(err)}`;
      continue;
    }
    if (res.ok) return (await res.json()) as StripePage<T>;
    reason = `Stripe answered ${res.status}`;
    // Drain the body so the connection is released before any retry.
    await res.text().catch(() => "");
    if (res.status !== 429 && res.status < 500) break;
  }
  throw new Error(reason);
}

/**
 * Every row of a Stripe list, a page at a time, so a caller that only adds
 * rows up never holds more than one page.
 *
 * Throws with a short reason when a page fails, and StripeListTooLong when
 * the list runs past `maxPages` pages. Either way the caller has not been
 * told the list ended, and must not report what it has read so far.
 */
export async function* listRows<T extends { id: string }>(
  key: string,
  path: string,
  query: Record<string, string>,
  maxPages: number,
): AsyncGenerator<T, void, void> {
  let startingAfter: string | null = null;
  for (let page = 0; ; page++) {
    if (page === maxPages) throw new StripeListTooLong(maxPages * STRIPE_PAGE_SIZE);
    const batch: StripePage<T> = await fetchPage<T>(key, path, query, startingAfter);
    const data = batch.data ?? [];
    yield* data;
    const last = data[data.length - 1];
    if (!batch.has_more || !last) return;
    startingAfter = last.id;
  }
}
