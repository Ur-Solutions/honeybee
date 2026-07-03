/**
 * Run `worker` over `items` with at most `concurrency` invocations in flight.
 * Results keep the input order. A rejected worker rejects the whole map (wrap
 * the worker in .catch() for best-effort sweeps).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );
  return results;
}
