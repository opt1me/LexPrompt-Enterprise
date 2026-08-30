import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AppEvent, PresenceMember, SubscriptionRef } from '@lexprompt/core';
import { WS_CLOSE_UNAUTHENTICATED, WS_SUBPROTOCOL } from '@lexprompt/core';
import {
  closeSocket, connectionState, onConnectionState, onPresence, reportPresence, subscribe,
  WS_STALE_AFTER_MS,
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

  /*
   * A SOCKET THAT NEVER OPENS MUST STILL GO STALE (C2).
   *
   * `armStale` had exactly two callers — `ws.onopen` and `heard()` — so
   * `stale` was reachable only from a connection that had once succeeded.
   * A 429 from `API_WS_MAX_CONNECTIONS`, a 403 from a role below `reviewer`,
   * or a proxy that does not forward `Upgrade` all land on `onclose` or the
   * `catch`, which set `connecting` and retry. `connecting` renders no
   * banner and disables no control, so the reviewer sat in front of a full
   * set of live-looking findings and live Verify/Flag/Reject controls with
   * not one colleague's change ever arriving — for the life of the page.
   *
   * EVERY OTHER TEST IN THIS FILE CALLS `opened()` FIRST, which is why the
   * fourteenth guard could not fail: `heard()` re-arms on the `hello` frame
   * one line later, so deleting the `armStale()` in `onopen` left the suite
   * green. These two do not open anything.
   */
  it('goes stale when the socket NEVER opens - a refused upgrade is not a quiet review', async () => {
    subscribe({ review: 'r1' }, handlers());
    await flushMicrotasks(() => fakeSockets.length === 1, 'the socket was never constructed');
    expect(connectionState()).toBe('connecting');
    // Nothing ever completes the handshake, exactly as a 429/403/proxy
    // refusal leaves it.
    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS + 1_000);
    expect(connectionState()).toBe('stale');
  });

  it('goes stale even while it is still retrying a refused upgrade', async () => {
    subscribe({ review: 'r1' }, handlers());
    await flushMicrotasks(() => fakeSockets.length === 1, 'the socket was never constructed');
    // `ensureSocket` runs again on every backoff tick. Re-arming there would
    // push the deadline out on each retry and `stale` would never fire at
    // all — the same silence by a different route, which is why the timer is
    // armed only IF IDLE.
    for (let i = 0; i < 6; i += 1) {
      fakeSockets[fakeSockets.length - 1].drop();
      await vi.advanceTimersByTimeAsync(20_000);
    }
    expect(fakeSockets.length).toBeGreaterThan(3);
    expect(connectionState()).toBe('stale');
  });

  it('restarts the countdown when the socket actually opens', async () => {
    // The other half of the same rule: opening IS evidence of a live
    // connection, so a slow connect must not spend the reader's staleness
    // budget. Delete `armStale()` from `ws.onopen` and this fails at 55s
    // from the first attempt, ten seconds after a socket that opened fine.
    subscribe({ review: 'r1' }, handlers());
    await flushMicrotasks(() => fakeSockets.length === 1, 'the socket was never constructed');
    await vi.advanceTimersByTimeAsync(WS_STALE_AFTER_MS - 5_000);
    expect(connectionState()).toBe('connecting');
    fakeSockets[0].open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connectionState()).not.toBe('stale');
  });

  it('reconnects promptly after a 4001 close rather than backing off (m1, M3)', async () => {
    // `WS_CLOSE_UNAUTHENTICATED` was exported and documented as "the one the
    // browser acts on differently" while nothing sent it and the client's
    // `onclose` took no event at all. The server now closes an expired or
    // no-longer-permitted socket with it, and a token the next
    // `getAccessToken()` refreshes is not a reason to wait fifteen seconds.
    subscribe({ review: 'r1' }, handlers());
    await flushMicrotasks(() => fakeSockets.length === 1, 'the socket was never constructed');
    // Three ordinary failures, so the backoff has genuinely grown.
    for (const delay of [1_000, 2_000, 3_000]) {
      fakeSockets[fakeSockets.length - 1].drop();
      await vi.advanceTimersByTimeAsync(delay);
    }
    const grown = fakeSockets.length;
    // The NEXT ordinary retry would be ~5s away. This one is not ordinary.
    fakeSockets[grown - 1].drop(WS_CLOSE_UNAUTHENTICATED);
    await vi.advanceTimersByTimeAsync(700);
    expect(fakeSockets.length).toBe(grown + 1);
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

describe('presence: what this tab says, and what it is told', () => {
  it('beats immediately on a change, and then on the server s own interval', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    ws.deliver({ t: 'hello', instanceId: 'api-1', userId: 'u1', presenceHeartbeatMs: 10_000 });

    reportPresence({ sub: { review: 'r1' }, screen: 'review', clauseId: 'c1' });
    const beats = () => ws.sent.filter(f => f.t === 'presence');
    // IMMEDIATELY, because the change IS the information: a colleague moving
    // to clause 14 is worth knowing now rather than in ten seconds.
    expect(beats()).toHaveLength(1);
    expect(beats()[0]).toEqual({
      t: 'presence', sub: { review: 'r1' }, screen: 'review', clauseId: 'c1',
    });

    // …and then repeated, because the server expires a roster entry whose
    // beats stop. Without the repeat a reader still on the clause vanishes
    // from their colleague's screen after the TTL.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(beats()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(beats()).toHaveLength(3);
  });

  it('adopts the interval the SERVER asked for, rather than a compiled-in one', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    // A deployment that raised the TTL and the heartbeat together. A browser
    // beating on its own constant would expire between beats, and a
    // colleague flickering in and out reads as somebody repeatedly opening
    // and closing the review.
    ws.deliver({ t: 'hello', instanceId: 'api-1', userId: 'u1', presenceHeartbeatMs: 2_000 });
    reportPresence({ sub: { review: 'r1' }, screen: 'review' });
    const beats = () => ws.sent.filter(f => f.t === 'presence');
    expect(beats()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(beats()).toHaveLength(2);
  });

  it('sends nothing at all once the report is cleared', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    reportPresence({ sub: { review: 'r1' }, screen: 'review' });
    reportPresence(null);
    const before = ws.sent.filter(f => f.t === 'presence').length;
    await vi.advanceTimersByTimeAsync(60_000);
    // A tab that has left the review must stop claiming to be on it, and
    // must not wait out a TTL to do so.
    expect(ws.sent.filter(f => f.t === 'presence')).toHaveLength(before);
  });

  it('re-sends the beat AFTER the subscribes, on a reconnection', async () => {
    subscribe({ review: 'r1' }, handlers());
    const ws = await opened();
    reportPresence({ sub: { review: 'r1' }, screen: 'review', clauseId: 'c1' });

    ws.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    const ws2 = await opened(1);
    const kinds = ws2.sent.map(f => f.t);
    // The ORDER is load-bearing: the server refuses a beat on a subscription
    // this socket has not joined, so a beat sent first is refused and the
    // reader is invisible to their colleagues until the next interval.
    expect(kinds.indexOf('subscribe')).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf('presence')).toBeGreaterThan(kinds.indexOf('subscribe'));
  });

  it('hands a listener the server s roster, for its own subscription only', async () => {
    subscribe({ review: 'r1' }, handlers());
    const seen: PresenceMember[][] = [];
    const other: PresenceMember[][] = [];
    onPresence({ review: 'r1' }, m => seen.push(m));
    onPresence({ review: 'r2' }, m => other.push(m));
    const ws = await opened();
    // Called immediately with an empty roster, the way `onConnectionState`
    // is called immediately with the current state.
    expect(seen).toEqual([[]]);

    ws.deliver({
      t: 'presence',
      sub: { review: 'r1' },
      members: [{ userId: 'u2', screen: 'review', clauseId: 'c14' }],
    });
    expect(seen.at(-1)).toEqual([{ userId: 'u2', screen: 'review', clauseId: 'c14' }]);
    expect(other).toEqual([[]]);
  });

  it('stops claiming somebody is here once the roster says they are not', async () => {
    subscribe({ review: 'r1' }, handlers());
    const seen: PresenceMember[][] = [];
    onPresence({ review: 'r1' }, m => seen.push(m));
    const ws = await opened();
    ws.deliver({
      t: 'presence', sub: { review: 'r1' }, members: [{ userId: 'u2', screen: 'review' }],
    });
    expect(seen.at(-1)).toHaveLength(1);

    ws.deliver({ t: 'presence', sub: { review: 'r1' }, members: [] });
    // The client renders the SERVER's roster and never its own last known
    // one. A merge here is what would keep a colleague's face on a clause
    // after the frame that removed them.
    expect(seen.at(-1)).toEqual([]);
  });

  it('claims nobody the moment the socket goes', async () => {
    subscribe({ review: 'r1' }, handlers());
    const seen: PresenceMember[][] = [];
    onPresence({ review: 'r1' }, m => seen.push(m));
    const ws = await opened();
    ws.deliver({
      t: 'presence', sub: { review: 'r1' }, members: [{ userId: 'u2', screen: 'review' }],
    });
    expect(seen.at(-1)).toHaveLength(1);

    ws.drop();
    /*
     * THE MUTATION THIS TEST EXISTS FOR: delete `clearPresence()` from
     * `ws.onclose` and this goes red.
     *
     * The roster this tab held was a claim about a few seconds ago on a
     * connection that no longer exists. Leaving it on screen is exactly the
     * stale indicator S6 forbids — *"a stale presence indicator that claims
     * someone is there is worse than no indicator"* — and a reviewer might
     * defer to a colleague who is not there. The findings stay; a claim
     * about who is here does not outlive the connection that carried it.
     */
    expect(seen.at(-1)).toEqual([]);
  });
});
