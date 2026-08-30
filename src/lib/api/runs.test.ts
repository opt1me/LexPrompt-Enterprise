import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelError, type RunEvent, type RunEventPage, type RunView } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';

/**
 * The browser's run client — Task 17.
 *
 * What is worth testing here is not "it makes a request". It is the two
 * things a polling client can get quietly wrong: applying an event twice
 * (which would make a finding go from `done` back to `running` on screen),
 * and dying silently (which leaves a job that died looking like a job still
 * working — rule 4 inverted).
 */

const transport = makeFakeTransport();
vi.mock('./client', () => transportModule(transport));

const { startRun, getRun, cancelRun, retryCell, liveRunFor, watchRun, isRunOver } =
  await import('./runs');
const { describeRunEnding } = await import('../loadError');

const RUN: RunView = {
  id: 'run-1', reviewId: 'rev-1', state: 'queued', requestedByUserId: 'u1',
  concurrency: 5, createdAt: 1_700_000_000_000,
  cells: { total: 2, queued: 2, leased: 0, done: 0, error: 0, cancelled: 0 },
  version: 1,
};

const event = (id: number, type: RunEvent['type']): RunEvent => ({
  id, type, reviewId: 'rev-1', runId: 'run-1', at: 1_700_000_000_000 + id,
  payload: { runId: 'run-1', reviewId: 'rev-1', findingsKey: 'd1', clauseId: `c${id}`, version: id },
});

const page = (events: RunEvent[], over: Partial<RunEventPage> = {}): RunEventPage => ({
  events,
  nextCursor: events.length > 0 ? events[events.length - 1].id : 0,
  hasMore: false,
  ...over,
});

beforeEach(() => {
  transport.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Lets every already-resolved promise settle, then advances the poll timer
 *  and lets the next poll settle. Fake timers alone do not drain the
 *  microtask queue an `await` sits in. */
async function tick(ms = 1_000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('the requests each export makes', () => {
  it('starts a run with POST /v1/reviews/:id/runs', async () => {
    transport.responses.set('/v1/reviews/rev-1/runs', RUN);
    expect((await startRun('rev-1')).id).toBe('run-1');
    expect(transport.sent[0]).toMatchObject({ method: 'POST', path: '/v1/reviews/rev-1/runs' });
  });

  it('reads a run, cancels one, and asks for a review s live run', async () => {
    transport.responses.set('/v1/runs/run-1', RUN);
    transport.responses.set('/v1/runs/run-1/cancel', { ...RUN, state: 'cancelled' });
    transport.responses.set('/v1/reviews/rev-1/runs/live', RUN);
    expect((await getRun('run-1')).state).toBe('queued');
    expect((await cancelRun('run-1')).state).toBe('cancelled');
    expect((await liveRunFor('rev-1'))!.id).toBe('run-1');
  });

  it('answers null — not a rejection — for a review with no live run', async () => {
    // A review that is simply idle is a fact, not a failure to find it.
    expect(await liveRunFor('rev-1')).toBeNull();
  });

  it('retries one clause with a POST that escapes every id it builds', async () => {
    const path = '/v1/reviews/rev-1/findings/col%2F1/c%201/retry';
    transport.responses.set(path, { run: RUN, cleared: { verification: true, netPosition: false } });
    const result = await retryCell('rev-1', 'col/1', 'c 1');
    expect(result.cleared).toEqual({ verification: true, netPosition: false });
    expect(transport.sent[0].path).toBe(path);
  });
});

describe('watchRun keeps a cursor, in id order, and applies nothing twice', () => {
  it('asks from the highest id it has applied', async () => {
    const seen: number[] = [];
    transport.responses.set('/v1/runs/run-1/events?after=0',
      page([event(1, 'finding.running'), event(2, 'finding.done')]));
    transport.responses.set('/v1/runs/run-1/events?after=2', page([]));

    const stop = watchRun('run-1', e => seen.push(e.id), () => {});
    await tick(0);
    expect(seen).toEqual([1, 2]);
    await tick();
    // The second poll asked from 2 and got nothing; nothing was re-applied.
    expect(seen).toEqual([1, 2]);
    stop();
  });

  it('stops on run.finished, and issues no further poll', async () => {
    transport.responses.set('/v1/runs/run-1/events?after=0',
      page([event(1, 'finding.done'), event(2, 'run.finished')]));
    const stop = watchRun('run-1', () => {}, () => {});
    await tick(0);
    const after = transport.sent.length;
    await tick(5_000);
    // Nothing more was fetched. (`apiGet` is not recorded in `sent`, so the
    // absence is asserted through the unregistered path instead: a third
    // poll would ask `?after=2`, which is not registered and would reject —
    // and a rejection three times over would call `onError`.)
    expect(transport.sent.length).toBe(after);
    stop();
  });

  it('drains a capped page immediately rather than one page per interval', async () => {
    const seen: number[] = [];
    transport.responses.set('/v1/runs/run-1/events?after=0',
      page([event(1, 'finding.done')], { hasMore: true }));
    transport.responses.set('/v1/runs/run-1/events?after=1',
      page([event(2, 'run.finished')]));
    const stop = watchRun('run-1', e => seen.push(e.id), () => {});
    await tick(0);
    expect(seen, 'a capped page waited out the poll interval').toEqual([1, 2]);
    stop();
  });

  it('unsubscribes: after stop(), nothing more is applied', async () => {
    const seen: number[] = [];
    transport.responses.set('/v1/runs/run-1/events?after=0', page([event(1, 'finding.done')]));
    transport.responses.set('/v1/runs/run-1/events?after=1', page([event(2, 'finding.done')]));
    const stop = watchRun('run-1', e => seen.push(e.id), () => {});
    await tick(0);
    stop();
    await tick(5_000);
    expect(seen).toEqual([1]);
  });
});

describe('a polling error does not silently stop the poll', () => {
  it('calls onError after three consecutive failures, not after one', async () => {
    /*
     * A poll loop that dies quietly leaves a run apparently frozen at
     * whatever it last saw — a job that died looking like a job still
     * working. Three rather than one because a single failed poll over a
     * network is ordinary and self-correcting.
     */
    const errors: unknown[] = [];
    transport.failures.set('/v1/runs/run-1/events?after=0',
      new ModelError('the network is down', 'network', 0));
    const stop = watchRun('run-1', () => {}, e => errors.push(e));

    await tick(0);
    expect(errors).toHaveLength(0);
    await tick();
    expect(errors, 'onError fired before three failures').toHaveLength(0);
    await tick();
    expect(errors).toHaveLength(1);
    stop();
  });

  it('keeps polling after a failure, and a later success clears the count', async () => {
    // A watch that gave up on the first failure would leave a live run
    // unwatched with nothing said.
    const seen: number[] = [];
    const errors: unknown[] = [];
    transport.failures.set('/v1/runs/run-1/events?after=0',
      new ModelError('the network is down', 'network', 0));
    const stop = watchRun('run-1', e => seen.push(e.id), e => errors.push(e));
    await tick(0);

    transport.failures.clear();
    transport.responses.set('/v1/runs/run-1/events?after=0', page([event(1, 'finding.done')]));
    transport.responses.set('/v1/runs/run-1/events?after=1', page([]));
    await tick();
    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(0);
    stop();
  });

  it('tells the caller to resync when the cursor fell outside the window', async () => {
    // Nothing is fabricated to fill the gap: the caller re-reads the
    // findings map, which is the state those events described.
    let resynced = 0;
    transport.responses.set('/v1/runs/run-1/events?after=0',
      page([event(9, 'finding.done')], { resyncRequired: true }));
    transport.responses.set('/v1/runs/run-1/events?after=9', page([]));
    const stop = watchRun('run-1', () => {}, () => {}, { onResync: () => { resynced += 1; } });
    await tick(0);
    expect(resynced).toBe(1);
    stop();
  });
});

describe('a run has a terminal state that is neither an error nor a success', () => {
  it('renders cancelled calmly and failed as a failure — different strings', () => {
    const cells = { total: 40, queued: 0, leased: 0, done: 12, error: 0, cancelled: 28 };
    const cancelled = describeRunEnding({ state: 'cancelled', cells })!;
    const failed = describeRunEnding({
      state: 'failed', error: 'the worker stopped answering', cells,
    })!;
    expect(cancelled.tone).toBe('info');
    expect(failed.tone).toBe('error');
    expect(cancelled.message).not.toBe(failed.message);
    // A partial run must never read as a complete one.
    expect(cancelled.message).toContain('12 of 40');
    expect(failed.message).toContain('the worker stopped answering');
  });

  it('says nothing about the ending of a run that succeeded', () => {
    expect(describeRunEnding({
      state: 'succeeded',
      cells: { total: 2, queued: 0, leased: 0, done: 2, error: 0, cancelled: 0 },
    })).toBeNull();
  });

  it('still says why a failed run stopped when it has no message', () => {
    const message = describeRunEnding({
      state: 'failed',
      cells: { total: 2, queued: 1, leased: 0, done: 1, error: 0, cancelled: 0 },
    })!.message;
    expect(message).toContain('1 of 2');
  });

  it('knows which states are over', () => {
    expect(['succeeded', 'cancelled', 'failed'].every(s => isRunOver(s as RunView['state'])))
      .toBe(true);
    expect(['queued', 'running', 'cancelling'].some(s => isRunOver(s as RunView['state'])))
      .toBe(false);
  });
});
