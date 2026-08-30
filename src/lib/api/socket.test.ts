import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppEvent, SubscriptionRef } from '@lexprompt/core';
import { WS_SUBPROTOCOL } from '@lexprompt/core';
import {
  closeSocket, connectionState, onConnectionState, subscribe, WS_STALE_AFTER_MS,
} from './socket';
import {
  flushMicrotasks, installFakeSockets, type FakeSocket, type SocketHarness,
} from '../../test/fakeSocket';

vi.mock('../auth/oidc', () => ({
  getAccessToken: async () => 'a-test-token',
}));

/**
 * THE BROWSER'S SOCKET, AGAINST A FAKE TRANSPORT.
 *
 * jsdom has no `WebSocket` and a real one would need a server, so the
 * constructor is injected. That is not a weaker test: what there is to get
 * wrong in this module is the state machine — one socket for many
 * subscriptions, a cursor per subscription across a reconnect, the version
 * guard, the backoff — and every one of those is exercised here against
 * frames this file controls exactly.
 */

const noop = (): void => { /* … */ };
const handlers = () => ({ onEvent: vi.fn(), onResync: vi.fn() });

const event = (
  id: number, over: Partial<AppEvent> = {}, payload: Record<string, unknown> = {},
): AppEvent => ({
  id,
  type: 'finding.done',
  workspaceId: 'ws-1',
  matterId: 'm1',
  reviewId: 'r1',
  runId: 'run-1',
  at: 1_700_000_000_000 + id,
  payload: {
    runId: 'run-1', reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', version: id, ...payload,
  } as AppEvent['payload'],
  ...over,
});

let harness: SocketHarness;
let fakeSockets: FakeSocket[];

beforeEach(() => {
  vi.useFakeTimers();
  harness = installFakeSockets();
  fakeSockets = harness.sockets;
});

afterEach(() => {
  closeSocket();
  harness.restore();
  vi.useRealTimers();
});

const opened = (index = 0): Promise<FakeSocket> => harness.opened(index);

describe('one socket per tab, multiplexed', () => {
  it('opens ONE socket for two subscriptions', async () => {
    subscribe({ review: 'r1' }, handlers());
    subscribe({ matter: 'm1' }, handlers());
    const ws = await opened();
    // Not one per screen: a review with a viewer and an activity panel would
    // otherwise hold three, each with its own backoff and its own answer to
    // "am I connected?".
    expect(fakeSockets).toHaveLength(1);
    expect(ws.sent.filter(f => f.t === 'subscribe')).toHaveLength(2);
  });

  it('sends the token in the subprotocol, never in the URL', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    // §14: no log line contains a credential. A query-string token lands in
    // every proxy access log, which is the one hop nginx logs by default.
    expect(ws.url).not.toContain('a-test-token');
    expect(ws.protocols[0]).toBe(WS_SUBPROTOCOL);
    expect(ws.protocols[1]).toBe('bearer.a-test-token');
  });

  it('re-subscribes every subscription with ITS OWN cursor after a reconnect', async () => {
    const a = handlers();
    const b = handlers();
    subscribe({ review: 'r1' }, a);
    subscribe({ matter: 'm1' }, b);
    const first = await opened();

    // Each subscription is caught up to a DIFFERENT id.
    first.deliver({ t: 'caught_up', sub: { review: 'r1' }, cursor: 7 });
    first.deliver({ t: 'caught_up', sub: { matter: 'm1' }, cursor: 2 });

    first.drop();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(() => fakeSockets.length === 2, 'the socket never reconnected');
    const second = fakeSockets[1];
    second.open();

    // ONE SHARED CURSOR would replay one of these from the other's position,
    // which is a silent gap on the busier of the two.
    expect(second.sent).toEqual([
      { t: 'subscribe', sub: { review: 'r1' }, lastEventId: 7 },
      { t: 'subscribe', sub: { matter: 'm1' }, lastEventId: 2 },
    ]);
  });

  it('answers a ping with a pong, so the server can tell a live page from a live socket', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    ws.deliver({ t: 'ping' });
    expect(ws.sent.some(f => f.t === 'pong')).toBe(true);
  });

  it('closes the socket when the last subscription goes', async () => {
    const one = subscribe({ review: 'r1' }, handlers());
    const two = subscribe({ matter: 'm1' }, handlers());
    const ws = await opened();
    one.close();
    expect(ws.readyState).toBe(1);
    two.close();
    // A tab on the matters list holds no connection at all.
    expect(ws.readyState).toBe(3);
  });
});

describe('the guards that make replay safe', () => {
  it('drops an event whose version is not newer than what it holds', async () => {
    /*
     * §8's idempotence rule — what makes replay safe and makes your own
     * write's echo a no-op. THE MUTATION: remove the version comparison in
     * `deliver` and confirm this fails; without it a reader watches a finding
     * go from done back to running on every reconnect.
     */
    const h = handlers();
    subscribe({ review: 'r1' }, h);
    const ws = await opened();
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: event(10, {}, { version: 5 }) });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    // A DIFFERENT event id — so guard 2 cannot be what refuses it — carrying
    // the SAME version of the same row.
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: event(11, {}, { version: 5 }) });
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    // …and a newer version does get through, so the drop above is about the
    // number rather than about the handler never being called twice.
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: event(12, {}, { version: 6 }) });
    expect(h.onEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps a disposition version and a finding version apart', async () => {
    // They are two counters on two tables. Sharing one key would let an
    // engine event's version suppress a person's judgement, or the reverse
    // — which is the one direction this app must never fail in.
    const h = handlers();
    subscribe({ review: 'r1' }, h);
    const ws = await opened();
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: event(20, {}, { version: 9 }) });
    ws.deliver({
      t: 'event',
      sub: { review: 'r1' },
      event: event(21, { type: 'finding.disposition_changed' }, { version: 2 }),
    });
    expect(h.onEvent).toHaveBeenCalledTimes(2);
  });

  it('hands one event to a handler once, even on two subscriptions covering it', async () => {
    const a = handlers();
    const b = handlers();
    subscribe({ review: 'r1' }, a);
    subscribe({ matter: 'm1' }, b);
    const ws = await opened();
    const note: AppEvent = {
      id: 30, type: 'note.added', workspaceId: 'ws-1', matterId: 'm1', reviewId: 'r1',
      at: 1, payload: {
        reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1',
        note: { id: 'n1', findingId: 'd1::c1', text: 't', byUserId: 'u1', at: 1 },
      },
    };
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: note });
    ws.deliver({ t: 'event', sub: { matter: 'm1' }, event: note });
    // A note has no version, so guard 3 cannot help: the event id is what
    // stops the same remark being appended twice.
    expect(a.onEvent).toHaveBeenCalledTimes(1);
    expect(b.onEvent).toHaveBeenCalledTimes(0);
  });

  it('passes resync_required through to the subscription that asked', async () => {
    const a = handlers();
    const b = handlers();
    subscribe({ review: 'r1' }, a);
    subscribe({ matter: 'm1' }, b);
    const ws = await opened();
    ws.deliver({ t: 'resync_required', sub: { review: 'r1' } });
    expect(a.onResync).toHaveBeenCalledTimes(1);
    // …and NOT to the other one, which has lost nothing.
    expect(b.onResync).toHaveBeenCalledTimes(0);
  });
});

describe('the connection state, and the backoff', () => {
  it('reports live on hello and stale only after the threshold', async () => {
    const seen: string[] = [];
    const off = onConnectionState(s => seen.push(s));
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    ws.deliver({ t: 'hello', instanceId: 'api-1', userId: 'u1', presenceHeartbeatMs: 10_000 });
    expect(connectionState()).toBe('live');

    // A drop is NOT stale. A socket that closes and reconnects inside 300 ms
    // must not flash a banner at a reviewer.
    ws.drop();
    await vi.advanceTimersByTimeAsync(300);
    expect(seen).not.toContain('stale');

    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS);
    expect(connectionState()).toBe('stale');
    off();
  });

  it('calls a new listener immediately with the state it is already in', () => {
    // A component that mounts while the socket is already stale must render
    // stale, not wait for a change that has already happened.
    const fn = vi.fn();
    const off = onConnectionState(fn);
    expect(fn).toHaveBeenCalledWith(connectionState());
    off();
  });

  it('backs off with jitter, and never spins', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    ws.drop();
    // Nothing at all in the first 300 ms: an immediate retry loop against a
    // server that is down is the shape that takes it further down.
    await vi.advanceTimersByTimeAsync(300);
    expect(fakeSockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks(() => fakeSockets.length === 2, 'the first retry never happened');

    // …and each subsequent failure waits longer.
    fakeSockets[1].drop();
    await vi.advanceTimersByTimeAsync(400);
    expect(fakeSockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks(() => fakeSockets.length === 3, 'the second retry never happened');
  });

  it('stops reconnecting once closeSocket has been called', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    closeSocket();
    ws.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    // Sign-out must not leave a socket crawling back with the previous
    // person's subscriptions on it.
    expect(fakeSockets).toHaveLength(1);
  });

  it('forgets the version cache on sign-out', async () => {
    const h = handlers();
    subscribe({ review: 'r1' }, h);
    const ws = await opened();
    ws.deliver({ t: 'event', sub: { review: 'r1' }, event: event(40, {}, { version: 3 }) });
    expect(h.onEvent).toHaveBeenCalledTimes(1);

    closeSocket();
    const next = handlers();
    subscribe({ review: 'r1' }, next);
    const ws2 = await opened(1);
    // The SAME version, to a new session. A cache surviving sign-out would
    // silently suppress the first change the next person was shown.
    ws2.deliver({ t: 'event', sub: { review: 'r1' }, event: event(40, {}, { version: 3 }) });
    expect(next.onEvent).toHaveBeenCalledTimes(1);
  });
});

describe('the subscription reference', () => {
  it('keys review, matter and run apart', async () => {
    const r = handlers();
    const m = handlers();
    subscribe({ review: 'x' } as SubscriptionRef, r);
    subscribe({ matter: 'x' } as SubscriptionRef, m);
    const ws = await opened();
    ws.deliver({ t: 'event', sub: { review: 'x' }, event: event(50) });
    expect(r.onEvent).toHaveBeenCalledTimes(1);
    expect(m.onEvent).toHaveBeenCalledTimes(0);
    expect(noop).toBeTruthy();
  });
});
