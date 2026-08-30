import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ModelError, type AppEvent, type RunView } from '@lexprompt/core';
import { makeFakeTransport, transportModule } from '../../test/fakeTransport';
import { installFakeSockets, type FakeSocket, type SocketHarness } from '../../test/fakeSocket';

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
// The socket authenticates with the access token at connect time; this suite
// is about `watchRun`'s contract, not about the sign-in.
vi.mock('../auth/oidc', () => ({ getAccessToken: async () => 'a-test-token' }));

const { startRun, getRun, cancelRun, retryCell, liveRunFor, watchRun, isRunOver } =
  await import('./runs');
const { describeRunEnding } = await import('../loadError');
const { closeSocket, WS_STALE_AFTER_MS } = await import('./socket');

const RUN: RunView = {
  id: 'run-1', reviewId: 'rev-1', state: 'queued', requestedByUserId: 'u1',
  concurrency: 5, createdAt: 1_700_000_000_000,
  cells: { total: 2, queued: 2, leased: 0, done: 0, error: 0, cancelled: 0 },
  version: 1,
};

const event = (id: number, type: AppEvent['type']): AppEvent => ({
  id, type, workspaceId: 'ws-1', matterId: 'm-1', reviewId: 'rev-1', runId: 'run-1',
  at: 1_700_000_000_000 + id,
  payload: { runId: 'run-1', reviewId: 'rev-1', findingsKey: 'd1', clauseId: `c${id}`, version: id },
});

let harness: SocketHarness;

beforeEach(() => {
  transport.reset();
  vi.useFakeTimers();
  harness = installFakeSockets();
});
afterEach(() => {
  closeSocket();
  harness.restore();
  vi.useRealTimers();
});

const openedSocket = (index = 0): Promise<FakeSocket> => harness.opened(index);

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

/**
 * `watchRun` OVER THE SOCKET — Stage 4 Task 19.
 *
 * ## Why these assertions changed and the signature did not
 *
 * Stage 3's cases here drove the POLL: capped pages, three consecutive
 * failed `GET`s, a cursor advanced across a retention gap. That transport is
 * gone — Stage 3's own docstring in `runs.ts` promised it would be
 * ("Stage 4 replaces the transport INSIDE this function and changes no
 * caller") — so the cases that described the poll's mechanics describe
 * nothing now, and keeping them would be asserting about a `setTimeout` this
 * module no longer contains.
 *
 * What is asserted instead is the CONTRACT, which is unchanged: four
 * parameters, `onEvent` per event in id order, `onResync` when the cursor
 * falls outside the window, `onError` when this client can no longer vouch
 * for what it is showing, and a `stop` that stops it. `App.tsx`'s
 * `attachRun` is not touched by this change, and that is the property the
 * whole interface note was about.
 */
describe('watchRun keeps its signature over the socket', () => {
  it('reports the run s events through the existing callback shape', async () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const stop = watchRun('run-1', onEvent, onError);
    const ws = await openedSocket();

    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(1, 'finding.done') });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect((onEvent.mock.calls[0][0] as AppEvent).id).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    stop();
  });

  it('subscribes to the RUN, not to the review it belongs to', async () => {
    const stop = watchRun('run-1', vi.fn(), vi.fn());
    const ws = await openedSocket();
    expect(ws.sent).toContainEqual({ t: 'subscribe', sub: { run: 'run-1' }, lastEventId: 0 });
    stop();
  });

  it('stops on run.finished, and applies nothing after it', async () => {
    const onEvent = vi.fn();
    const stop = watchRun('run-1', onEvent, vi.fn());
    const ws = await openedSocket();

    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(1, 'finding.done') });
    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(2, 'run.finished') });
    // The ending IS delivered — the caller's `finishRun` runs off it — and
    // the watch ends after it.
    expect(onEvent).toHaveBeenCalledTimes(2);
    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(3, 'finding.done') });
    expect(onEvent).toHaveBeenCalledTimes(2);
    stop();
  });

  it('unsubscribes: after stop(), nothing more is applied', async () => {
    const onEvent = vi.fn();
    const stop = watchRun('run-1', onEvent, vi.fn());
    const ws = await openedSocket();
    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(1, 'finding.done') });
    stop();
    ws.deliver({ t: 'event', sub: { run: 'run-1' }, event: event(2, 'finding.done') });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('passes onResync straight through, and fabricates no event to fill the gap', async () => {
    const onResync = vi.fn();
    const stop = watchRun('run-1', vi.fn(), vi.fn(), { onResync });
    const ws = await openedSocket();
    ws.deliver({ t: 'resync_required', sub: { run: 'run-1' } });
    expect(onResync).toHaveBeenCalledTimes(1);
    stop();
  });

  it('accepts intervalMs and ignores it, so no caller breaks', async () => {
    // The poll's knob. Removing it from `WatchOptions` would be a signature
    // change, which is the one thing this function promised not to make.
    const stop = watchRun('run-1', vi.fn(), vi.fn(), { intervalMs: 250 });
    const ws = await openedSocket();
    expect(ws.sent).toHaveLength(1);
    stop();
  });
});

describe('a watch that has stopped being live says so', () => {
  it('calls onError when the connection goes stale, ONCE', async () => {
    /*
     * The poll called `onError` after three consecutive failures because that
     * was the only thing it could know. A socket knows directly, and `stale`
     * is the same fact at the same moment: a run whose updates have stopped
     * looks exactly like a run that has stopped producing them.
     *
     * ONCE per stale period, not once per frame of it — a notice repeated
     * every second is a notice nobody reads, which was the whole argument for
     * three strikes.
     */
    const onError = vi.fn();
    const stop = watchRun('run-1', vi.fn(), onError);
    const ws = await openedSocket();
    ws.deliver({ t: 'hello', instanceId: 'api-1', userId: 'u1', presenceHeartbeatMs: 10_000 });

    ws.drop();
    await vi.advanceTimersByTimeAsync(300);
    // NOT on the drop. A socket that closes and reconnects inside 300 ms
    // must not put a notice in front of a reviewer.
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS + 1_000);
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS + 1_000);
    expect(onError).toHaveBeenCalledTimes(1);
    stop();
  });

  it('says nothing to a watch that has already been stopped', async () => {
    const onError = vi.fn();
    const stop = watchRun('run-1', vi.fn(), onError);
    const ws = await openedSocket();
    stop();
    ws.drop();
    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS + 5_000);
    expect(onError).not.toHaveBeenCalled();
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

  it('does NOT tell the reader a REAPED run reviewed every clause', () => {
    /*
     * FINAL REVIEW M3, and it is this project's founding defect in one
     * sentence: a partial run reading as a complete one.
     *
     * The reaper's `failRunCells` moves every remaining `queued` and
     * `leased` cell to `error`, so a reaped run's counts always satisfy
     * `done + error === total`. The count was `done + error`, so a run that
     * died after three of forty clauses said *"40 of 40 clauses were
     * reviewed"* — with thirty-seven never attempted.
     *
     * The shape below is a REAPED run's, which is what the old test's
     * hand-built `{ done: 12, error: 0, cancelled: 28 }` could never be:
     * a reaped run has no cancelled cells at all.
     */
    const reaped = { total: 40, queued: 0, leased: 0, done: 3, error: 37, cancelled: 0 };
    const message = describeRunEnding({
      state: 'failed',
      error: 'This run stopped without finishing. No worker has reported on it since 09:12.',
      cells: reaped,
    })!.message;
    expect(message, 'a reaped run reported every clause as reviewed').toContain('3 of 40');
    expect(message).not.toContain('40 of 40');
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
