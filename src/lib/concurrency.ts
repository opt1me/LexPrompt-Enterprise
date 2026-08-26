/** Runs `fn` over `items` with at most `limit` promises in flight, preserving
 *  input order in the result. Rejects on the first worker rejection, and stops
 *  starting new work once `signal` aborts. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const width = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (failed) throw new DOMException('Aborted', 'AbortError');
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, worker));
  // Defensive check for abort fired in the microtask gap between the last worker's return
  // and this line resuming. The in-loop check catches every abort reachable with real
  // (macrotask) timing; this one guards only the microtask-gap case a future refactor could widen.
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  return results;
}
