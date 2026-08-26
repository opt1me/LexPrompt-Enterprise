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
    await tick(12);
    controller.abort();
    await expect(promise).rejects.toThrow(/abort/i);
    const startedAtAbort = started;
    await tick(40);
    expect(started).toBe(startedAtAbort);
  });

  it('handles an empty input list', async () => {
    expect(await mapWithConcurrency([], 5, async () => 1)).toEqual([]);
  });
});
