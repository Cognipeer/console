/**
 * Bounded concurrency helpers.
 *
 * Fan-out with `Promise.all` over an unbounded list is the shape behind most of
 * this codebase's load incidents: it looks parallel and cheap until the list is
 * user-sized, at which point it opens as many sockets, DB connections or
 * provider calls as the input happens to be long.
 */

/**
 * Run `fn` over `items` with at most `limit` in flight, preserving input order.
 *
 * Rejections propagate like `Promise.all`: the first failure rejects, and the
 * workers already running finish their current item.
 */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workerCount = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      results[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return results;
}
