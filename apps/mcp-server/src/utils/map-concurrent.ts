/**
 * Map `items` through `fn` with at most `limit` promises in flight, keeping
 * the output in input order. Used wherever a page of R2 reads or HEADs has
 * to fit a request's subrequest budget without going one at a time.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
