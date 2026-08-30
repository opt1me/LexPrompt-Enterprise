import {
  subscriptionKey,
  WS_BEARER_PREFIX, WS_PATH, WS_SUBPROTOCOL,
  type AppEvent, type ClientFrame, type ServerFrame, type SubscriptionRef,
} from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc';
import { config } from '../config';
import { debug } from '../debug';

/**
 * ONE SOCKET PER TAB, MULTIPLEXED (§8).
 *
 * Not one per screen and not one per subscription: a review screen with a
 * document viewer and an activity panel would otherwise hold three, each
 * with its own backoff, each reporting its own staleness — and the user
 * would see three different answers to *"am I connected?"*.
 *
 * ## The three guards, and why there are three
 *
 * 1. **The cursor**, per subscription. §8: "the client keeps the highest id
 *    it has applied, per subscription". One shared cursor across two
 *    subscriptions would replay one of them from the other's position, which
 *    is a silent gap on the busier of the two.
 * 2. **The event id**, across the socket. A review subscription and a matter
 *    subscription covering the same matter both carry the same
 *    `note.added`, so a handler would otherwise see it twice and append the
 *    note twice.
 * 3. **The version**, per row. §8's idempotence rule: an event whose version
 *    is not newer than what this client holds is DROPPED. It is what makes
 *    replay safe, makes the echo of your own write a no-op, and makes
 *    out-of-order delivery survivable — and it is deliberately independent
 *    of (2), because this is the one place a dropped event leaves a human
 *    judgement on screen that the database does not hold.
 *
 * ## The fourth load state lives here too
 *
 * `ConnectionState` is what Task 20's banner and its dead controls read.
 * `stale` arrives on two unanswered server pings rather than on the first
 * `close`: a socket that closes and reconnects inside 300 ms would otherwise
 * flash a banner at a reviewer for no reason, and a banner that appears
 * spuriously is one people learn to ignore — which is how this state gets
 * shipped and then ignored.
 */

export type ConnectionState = 'connecting' | 'live' | 'stale';

export interface Subscription {
  close(): void;
}

export interface SubscriptionHandlers {
  onEvent(event: AppEvent): void;
  /** The cursor fell outside the retention window. Nothing is fabricated to
   *  fill the gap: the caller re-reads the state those events described. */
  onResync(): void;
}

/**
 * How long without a server frame before this client says it is `stale`.
 *
 * TWO PING INTERVALS PLUS SLACK. `API_WS_PING_MS` is 25s server-side and the
 * server itself closes a socket that misses two pings, so a client that has
 * heard nothing for 55s is looking at a view that has stopped being live —
 * which is §19's named defect and the reason this constant is not "on
 * close".
 */
export const WS_STALE_AFTER_MS = 55_000;

/** Reconnection backoff. Jittered, so a server coming back does not receive
 *  every tab in the firm at the same millisecond. */
const BACKOFF_MS = [500, 1_000, 2_000, 5_000, 10_000, 15_000];
const JITTER = 0.3;

/** How many applied event ids to remember. A run of forty cells emits eighty
 *  events; this is generous and bounded, which is the only property it needs
 *  — the version guard is what actually protects a judgement. */
const APPLIED_IDS_MAX = 500;

interface Entry {
  sub: SubscriptionRef;
  handlers: SubscriptionHandlers;
  /** The highest event id APPLIED for this subscription. Sent as
   *  `lastEventId` on every (re)subscribe. */
  cursor: number;
}

/** Everything one tab's socket holds. Module-level because there is one. */
const entries = new Map<string, Entry>();
const stateListeners = new Set<(s: ConnectionState) => void>();
const appliedIds: number[] = [];
const appliedIdSet = new Set<number>();
const versions = new Map<string, number>();

let socket: WebSocket | null = null;
let state: ConnectionState = 'connecting';
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let opening = false;
let closedByUs = false;

/**
 * The `WebSocket` constructor, injectable for tests.
 *
 * jsdom has no `WebSocket` and a real one would need a server; the fake is
 * installed here rather than by module mocking so the tests exercise THIS
 * module's own state machine — the reconnection, the cursors, the guards —
 * which is the whole of what there is to get wrong.
 */
type SocketFactory = (url: string, protocols: string[]) => WebSocket;
let makeSocket: SocketFactory = (url, protocols) => new WebSocket(url, protocols);

/** Test seam. Returns the previous factory so a suite can restore it. */
export function setSocketFactory(factory: SocketFactory): SocketFactory {
  const previous = makeSocket;
  makeSocket = factory;
  return previous;
}

function setState(next: ConnectionState): void {
  if (state === next) return;
  state = next;
  for (const listener of stateListeners) listener(next);
}

export function connectionState(): ConnectionState {
  return state;
}

export function onConnectionState(fn: (s: ConnectionState) => void): () => void {
  stateListeners.add(fn);
  // Called immediately with the current state: a component that mounts while
  // the socket is already stale must render stale, not wait for a change
  // that has already happened.
  fn(state);
  return () => { stateListeners.delete(fn); };
}

function armStale(): void {
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = setTimeout(() => { setState('stale'); }, WS_STALE_AFTER_MS);
}

function heard(): void {
  armStale();
}

/**
 * A key for the row an event describes, or `undefined` for an event that
 * describes no versioned row.
 *
 * `note.added` has none by design: a note is insert-only, so its own id is
 * its identity and guard (2) covers it. Returning a key here for a note
 * would invent a version nothing increments.
 */
function versionKeyOf(event: AppEvent): { key: string; version: number } | undefined {
  const payload = event.payload as unknown as Record<string, unknown>;
  const version = typeof payload.version === 'number' ? payload.version : undefined;
  if (version === undefined) return undefined;
  if (event.type === 'run.started' || event.type === 'run.finished') {
    return { key: `run:${String(payload.runId)}`, version };
  }
  const cell = `${String(payload.reviewId)}:${String(payload.findingsKey)}`
    + `:${String(payload.clauseId)}`;
  // A disposition and the finding under it have SEPARATE version counters —
  // one is `finding_disposition.version`, the other is `finding.version` —
  // so they get separate keys. Sharing one would let an engine event's
  // version suppress a person's judgement, or the reverse.
  return {
    key: event.type === 'finding.disposition_changed' ? `disposition:${cell}` : `finding:${cell}`,
    version,
  };
}

function alreadyApplied(id: number): boolean {
  return appliedIdSet.has(id);
}

function rememberApplied(id: number): void {
  if (appliedIdSet.has(id)) return;
  appliedIdSet.add(id);
  appliedIds.push(id);
  if (appliedIds.length > APPLIED_IDS_MAX) {
    const dropped = appliedIds.shift();
    if (dropped !== undefined) appliedIdSet.delete(dropped);
  }
}

function deliver(entry: Entry, event: AppEvent): void {
  // GUARD 2: this socket has already handed this event to a handler, on this
  // subscription or another one covering the same rows.
  if (alreadyApplied(event.id)) {
    entry.cursor = Math.max(entry.cursor, event.id);
    return;
  }
  // GUARD 3: the version. An event that is not newer than what this client
  // holds is dropped, and the cursor still moves — the event WAS seen, it
  // just said nothing new.
  const versioned = versionKeyOf(event);
  if (versioned) {
    const held = versions.get(versioned.key);
    if (held !== undefined && versioned.version <= held) {
      entry.cursor = Math.max(entry.cursor, event.id);
      rememberApplied(event.id);
      return;
    }
    versions.set(versioned.key, versioned.version);
  }
  rememberApplied(event.id);
  entry.cursor = Math.max(entry.cursor, event.id);
  entry.handlers.onEvent(event);
}

function send(frame: ClientFrame): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

function subscribeAll(): void {
  // Every subscription, each with ITS OWN cursor. In insertion order, so a
  // test can assert the frames it sent rather than a set.
  for (const entry of entries.values()) {
    send({ t: 'subscribe', sub: entry.sub, lastEventId: entry.cursor });
  }
}

function onFrame(raw: string): void {
  heard();
  let frame: ServerFrame;
  try {
    frame = JSON.parse(raw) as ServerFrame;
  } catch {
    debug('socket: a frame was not JSON');
    return;
  }
  switch (frame.t) {
    case 'ping':
      send({ t: 'pong' });
      return;
    case 'hello':
      setState('live');
      return;
    case 'caught_up': {
      const entry = entries.get(subscriptionKey(frame.sub));
      if (entry) entry.cursor = Math.max(entry.cursor, frame.cursor);
      setState('live');
      return;
    }
    case 'resync_required': {
      const entry = entries.get(subscriptionKey(frame.sub));
      entry?.handlers.onResync();
      return;
    }
    case 'event': {
      const entry = entries.get(subscriptionKey(frame.sub));
      if (entry) deliver(entry, frame.event);
      return;
    }
    case 'refused':
      // REPORTED, never swallowed. A refused subscription that said nothing
      // would leave a screen looking like a review where nothing is
      // happening — which is what the server's own `refused` frame exists to
      // prevent, and dropping it here would undo that at the last hop.
      debug('socket: subscription refused', frame.sub, frame.reason);
      return;
    default:
      debug('socket: unknown frame');
  }
}

function scheduleReconnect(): void {
  if (closedByUs || reconnectTimer !== null || entries.size === 0) return;
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  // JITTERED. Without it every tab in the firm reconnects on the same
  // millisecond after a deploy, which is the one moment the server can least
  // afford it.
  const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * JITTER));
  attempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureSocket();
  }, delay);
}

async function ensureSocket(): Promise<void> {
  if (opening || socket !== null || entries.size === 0 || closedByUs) return;
  opening = true;
  setState('connecting');
  try {
    // THE TOKEN AT CONNECT TIME, in the subprotocol. A token expiring
    // mid-connection closes the socket; the client refreshes and reconnects,
    // which is the same path as any other drop. There is deliberately no
    // re-authentication of a live socket: one path, exercised constantly,
    // beats two of which one runs hourly.
    const token = await getAccessToken();
    const base = config.apiBaseUrl.startsWith('http')
      ? config.apiBaseUrl
      : `${window.location.origin}${config.apiBaseUrl}`;
    const url = `${base.replace(/^http/, 'ws')}${WS_PATH}`;
    const ws = makeSocket(url, [WS_SUBPROTOCOL, `${WS_BEARER_PREFIX}${token}`]);
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      armStale();
      subscribeAll();
    };
    ws.onmessage = (event: MessageEvent) => { onFrame(String(event.data)); };
    ws.onerror = () => { debug('socket: transport error'); };
    ws.onclose = () => {
      socket = null;
      // NOT `stale` here. A socket that closes and reconnects inside 300 ms
      // must not flash a banner; `armStale`'s timer is what decides, and it
      // is still running.
      if (!closedByUs) {
        setState('connecting');
        scheduleReconnect();
      }
    };
  } catch (err) {
    debug('socket: could not open', err);
    socket = null;
    scheduleReconnect();
  } finally {
    opening = false;
  }
}

/**
 * Watch one subscription. Returns an unsubscribe.
 *
 * The socket is opened lazily on the first subscription and closed when the
 * last one goes: a tab on the matters list holds no connection at all.
 */
export function subscribe(sub: SubscriptionRef, handlers: SubscriptionHandlers): Subscription {
  const key = subscriptionKey(sub);
  const entry: Entry = { sub, handlers, cursor: 0 };
  entries.set(key, entry);
  closedByUs = false;
  if (socket && socket.readyState === WebSocket.OPEN) {
    send({ t: 'subscribe', sub, lastEventId: 0 });
  } else {
    void ensureSocket();
  }
  return {
    close() {
      if (entries.get(key) !== entry) return;
      entries.delete(key);
      send({ t: 'unsubscribe', sub });
      if (entries.size === 0) closeSocket();
    },
  };
}

/**
 * Closes the socket and forgets everything this tab held.
 *
 * Called on sign-out, or the next user's tab inherits the previous one's
 * subscriptions — and, worse, the previous one's cached versions, which
 * would silently suppress the first change they were shown.
 */
export function closeSocket(): void {
  closedByUs = true;
  entries.clear();
  versions.clear();
  appliedIds.length = 0;
  appliedIdSet.clear();
  attempt = 0;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (staleTimer) clearTimeout(staleTimer);
  staleTimer = null;
  const ws = socket;
  socket = null;
  ws?.close();
  setState('connecting');
}
