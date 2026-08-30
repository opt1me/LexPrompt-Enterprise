import {
  subscriptionKey,
  WS_BEARER_PREFIX, WS_CLOSE_UNAUTHENTICATED, WS_PATH, WS_SUBPROTOCOL,
  type AppEvent, type ClientFrame, type PresenceMember, type PresenceScreen,
  type ServerFrame, type SubscriptionRef,
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

/**
 * How often to say *"I am still here"*, until the server says otherwise.
 *
 * A FALLBACK, not the number. The server states the interval it wants on the
 * `hello` frame (`API_PRESENCE_HEARTBEAT_MS`) and this client beats at that;
 * this constant covers the window before the first `hello` arrives. Two
 * independent numbers — one in a deployment's environment, one compiled into
 * this bundle — is how a raised TTL silently becomes a roster that expires
 * between beats, and a colleague flickering in and out reads as somebody
 * repeatedly opening and closing the review.
 */
const PRESENCE_BEAT_FALLBACK_MS = 10_000;

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

/**
 * WHERE THIS TAB SAYS IT IS, and who it has been told is here with it.
 *
 * `report` is what the heartbeat sends: one place, one screen, one selected
 * clause. Null when this tab is on no screen presence covers — and then
 * nothing is sent at all, because *"I am somewhere"* with no somewhere is
 * a claim with no content.
 */
interface PresenceReport {
  sub: SubscriptionRef;
  screen: PresenceScreen;
  /** The clause the reader SELECTED. Never the one nearest the top of the
   *  viewport: a scroll-derived presence broadcasts a stream of clause
   *  changes and tells a colleague something the reader never chose to say. */
  clauseId?: string;
}

/** Everything one tab's socket holds. Module-level because there is one. */
const entries = new Map<string, Entry>();
const stateListeners = new Set<(s: ConnectionState) => void>();
/** subscription key -> whoever wants that subscription's roster. */
const presenceListeners = new Map<string, Set<(members: PresenceMember[]) => void>>();
let presenceReport: PresenceReport | null = null;
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let presenceBeatMs = PRESENCE_BEAT_FALLBACK_MS;
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

/**
 * A SOCKET THAT NEVER OPENS MUST STILL GO STALE.
 *
 * `armStale` used to have two callers — `ws.onopen` and `heard()` — so
 * `stale` was reachable only from a connection that had once succeeded.
 * Every failure of the UPGRADE ITSELF lands on `onclose` or the `catch`
 * below, both of which set `connecting` and schedule a retry, and
 * `connecting` renders no banner and disables no control. A 429 from
 * `API_WS_MAX_CONNECTIONS`, a 403 from a role below `reviewer`, or a proxy
 * that does not forward `Upgrade` therefore left a reviewer looking at a
 * full set of live-looking findings and live Verify/Flag/Reject controls
 * with not one colleague's change ever arriving — this project's founding
 * defect wearing a websocket, and the exact state the `stale` banner was
 * built to prevent.
 *
 * IF IDLE, and that half is load-bearing too. `ensureSocket` runs again on
 * every backoff tick; re-arming there would push the deadline out on each
 * retry and `stale` would never fire at all — the same silence by a
 * different route. So the countdown starts at the FIRST attempt and is
 * reset only by evidence of a live connection: `onopen`, and any frame.
 */
function armStaleIfIdle(): void {
  if (staleTimer !== null) return;
  armStale();
}

/**
 * `connecting` NEVER OVERWRITES `stale`.
 *
 * Both `ensureSocket` and `ws.onclose` announce `connecting`, and both run
 * on every backoff tick — so a tab that has been stale for ten minutes
 * against a server refusing every upgrade flipped back to `connecting` on
 * each retry, which renders no banner and disables no control. The reader
 * would have seen the warning for a few seconds in every reconnect cycle and
 * a normal-looking review the rest of the time, which is worse than never
 * showing it: an intermittent warning is one people learn to disbelieve.
 *
 * A retry attempt is not evidence of anything. Only a frame from the server
 * clears `stale`, and `hello`/`caught_up` are where that happens.
 */
function setConnecting(): void {
  if (state === 'stale') return;
  setState('connecting');
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
  // AFTER the subscribes, and it has to be: the server refuses a beat on a
  // subscription this socket has not joined, so a beat sent first would be
  // refused and the reader would be invisible to their colleagues until the
  // next interval.
  sendBeat();
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
      // THE SERVER'S INTERVAL, adopted before the first beat goes out. See
      // `PRESENCE_BEAT_FALLBACK_MS`.
      if (typeof frame.presenceHeartbeatMs === 'number' && frame.presenceHeartbeatMs > 0) {
        presenceBeatMs = frame.presenceHeartbeatMs;
        if (presenceTimer) {
          clearInterval(presenceTimer);
          presenceTimer = setInterval(sendBeat, presenceBeatMs);
        }
      }
      setState('live');
      return;
    case 'presence':
      // THE SERVER'S ROSTER, rendered as given. No merge with what this
      // client last held: the merge is what would keep somebody on a clause
      // after they left it.
      emitPresence(frame.sub, frame.members);
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
  setConnecting();
  // BEFORE the token, before the constructor. `getAccessToken()` can hang or
  // reject, and the upgrade can be refused outright; neither of those paths
  // ever reaches `onopen`, and both used to leave this tab in `connecting`
  // for the life of the page. See `armStaleIfIdle`.
  armStaleIfIdle();
  try {
    // THE TOKEN AT CONNECT TIME, in the subprotocol.
    //
    // A token expiring mid-connection closes the socket — the SERVER closes
    // it, with `WS_CLOSE_UNAUTHENTICATED`, off the `exp` it carried away
    // from the upgrade (`apps/api/src/realtime/socket.ts`). The client then
    // refreshes and reconnects, which is the same path as any other drop.
    // There is deliberately no re-authentication of a live socket from this
    // end: one path, exercised constantly, beats two of which one runs
    // hourly.
    //
    // That sentence was here before anything implemented it — nothing closed
    // an expired socket at all, so a signed-out or disabled person's open
    // tab went on receiving the workspace's live changes until it was
    // closed. A justification for omitting a mechanism, resting on a
    // mechanism that does not exist, is its own defect; the server now
    // closes on `exp` and re-checks the account on its own timer.
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
    ws.onclose = (closed?: { code?: number }) => {
      socket = null;
      /*
       * 4001 IS THE ONE THIS CLIENT ACTS ON DIFFERENTLY, and now it can.
       *
       * `WS_CLOSE_UNAUTHENTICATED` means the token this socket was upgraded
       * with has expired, or the account behind it is no longer allowed —
       * not that the network or the server is in trouble. Backing off from
       * 500 ms to fifteen seconds over an expiry the very next
       * `getAccessToken()` refreshes would leave a reader watching a stale
       * review for no reason, so the attempt counter is reset and the
       * ordinary first-retry delay applies. The refusal, if the account
       * really is gone, arrives as a plain 401 at the upgrade.
       *
       * The constant was exported and documented as "the one the browser
       * acts on differently" while nothing sent it and nothing read it.
       * Both ends of that sentence are now true.
       */
      if (closed?.code === WS_CLOSE_UNAUTHENTICATED) attempt = 0;
      // NOBODY IS HERE THAT THIS TAB CAN VOUCH FOR. The roster it last held
      // was a claim about a few seconds ago on a connection that is now
      // gone; keeping it on screen is exactly the stale indicator S6 exists
      // to prevent. The findings stay — *"never show disconnected data as
      // though it were current"* is not "show nothing" — but a claim about
      // who is here cannot outlive the connection that carried it.
      clearPresence();
      // NOT `stale` here. A socket that closes and reconnects inside 300 ms
      // must not flash a banner; `armStale`'s timer is what decides, and it
      // is still running.
      if (!closedByUs) {
        setConnecting();
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
 * WHO ELSE IS HERE, for one subscription (§8, Task 23).
 *
 * The listener is called with the SERVER'S roster and never with this
 * client's own accumulated view — that is the whole rule. A client that
 * remembered its last known roster would keep a colleague's face on a clause
 * after the frame that removed them, and *"a stale presence indicator that
 * claims someone is there is worse than no indicator"*: a reviewer might
 * defer to somebody who left. So there is no merge here, no cache, and the
 * empty roster on a disconnect below is the same rule at the other end.
 *
 * Called immediately with an EMPTY roster, for the reason
 * `onConnectionState` calls immediately with the current state: a component
 * that mounts before any frame has arrived must render "nobody else that I
 * know of" rather than wait, and empty is the honest starting claim — an
 * absent name never meant nobody is there.
 */
export function onPresence(
  sub: SubscriptionRef, fn: (members: PresenceMember[]) => void,
): () => void {
  const key = subscriptionKey(sub);
  let listeners = presenceListeners.get(key);
  if (!listeners) {
    listeners = new Set();
    presenceListeners.set(key, listeners);
  }
  listeners.add(fn);
  fn([]);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) presenceListeners.delete(key);
  };
}

function emitPresence(sub: SubscriptionRef, members: PresenceMember[]): void {
  for (const fn of presenceListeners.get(subscriptionKey(sub)) ?? []) fn(members);
}

/** Everybody this tab has been told about, told nothing. Used when the
 *  socket goes: see `onPresence`. */
function clearPresence(): void {
  for (const listeners of presenceListeners.values()) {
    for (const fn of listeners) fn([]);
  }
}

function sendBeat(): void {
  if (!presenceReport) return;
  send({
    t: 'presence',
    sub: presenceReport.sub,
    screen: presenceReport.screen,
    ...(presenceReport.clauseId === undefined ? {} : { clauseId: presenceReport.clauseId }),
  });
}

/**
 * Says where this tab is, from now on. `null` stops saying anything.
 *
 * Sent IMMEDIATELY on every change and then repeated on the server's own
 * interval. Immediately, because the change is the information — a colleague
 * moving to clause 14 is worth knowing now rather than in ten seconds; on an
 * interval, because the server expires a roster entry that stops arriving,
 * which is what stops a crashed tab claiming a person is still reading.
 *
 * Nothing is sent while the socket is closed. The next `subscribeAll` sends
 * the report again, so a reconnection restores a reader's place without
 * anything here remembering that it has to.
 */
export function reportPresence(report: PresenceReport | null): void {
  const changed = JSON.stringify(presenceReport) !== JSON.stringify(report);
  presenceReport = report;
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  if (!report) return;
  if (changed) sendBeat();
  presenceTimer = setInterval(sendBeat, presenceBeatMs);
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
  clearPresence();
  presenceListeners.clear();
  presenceReport = null;
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = null;
  presenceBeatMs = PRESENCE_BEAT_FALLBACK_MS;
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
