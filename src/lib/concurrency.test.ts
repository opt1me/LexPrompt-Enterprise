import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency';

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const out = await mapWithConcurrency([30, 10, 20], 3, async ms => {
      await tick(ms);
      return ms;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 3, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(5);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('propagates a rejection from the worker', async () => {
    await expect(
      mapWithConcurrency([1, 2], 2, async n => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('stops starting new work once aborted', async () => {
    const controller = new AbortController();
    let started = 0;
    const promise = mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async () => {
        started++;
        await tick(5);
        return null;
      },
      controller.signal,
    );
    await tick(30);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
    const startedAtAbort = started;
    await tick(40);
    expect(started).toBe(startedAtAbort);
  });

  it('handles an empty input list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });

  it('rejects when abort fires after all items dispatched but before they settle', async () => {
    const controller = new AbortController();
    const startTimes: number[] = [];
    const startTime = Date.now();

    const promise = mapWithConcurrency(
      Array.from({ length: 2 }, (_, i) => i),
      2,
      async (i) => {
        startTimes[i] = Date.now() - startTime;
        // Simulate quick startup followed by longer operation
        await tick(100);
        return i;
      },
      controller.signal,
    );

    // Wait for all items to start their fn() calls
    await tick(20);
    // Abort while fn() calls are still pending
    controller.abort();

    // Must reject, not resolve
    await expect(promise).rejects.toThrow(/abort/i);
  });

  it('stops calling fn after first rejection', async () => {
    const called: number[] = [];
    let resolveFirstFn: () => void;
    const firstFnPromise = new Promise<void>(r => { resolveFirstFn = r; });

    const promise = mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      2,
      async n => {
        called.push(n);
        if (n === 0) await firstFnPromise;
        if (n === 2) throw new Error('fail at 2');
        await tick(5);
        return n;
      },
    );

    // Let first two items (0,1) start
    await tick(1);
    // Resume first fn to let it complete and pull item 2
    resolveFirstFn!();
    // Wait for rejection
    await expect(promise).rejects.toThrow('fail at 2');

    // After 2 throws, should not call fn for items 4+
    const maxCalled = Math.max(...called, -1);
    expect(maxCalled).toBeLessThan(10);
  });
});
