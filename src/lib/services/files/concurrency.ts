/**
 * Runs `work` over `items` with at most `limit` calls in flight and returns the results in the order of the items.
 *
 * It stops starting calls after the first one that throws and rejects with that error once the calls in flight have
 * finished; a caller that wants every item to run (a batch that reports what failed) catches inside `work`.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;

  const worker = async (): Promise<void> => {
    while (!failure) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await work(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };

  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  if (failure) throw failure.error;
  return results;
}
