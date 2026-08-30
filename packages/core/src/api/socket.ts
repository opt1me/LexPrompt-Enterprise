import type { AppEvent, SubscriptionRef } from './records.ts';

/**
 * §8'S TRANSPORT, AS ONE UNION BOTH SIDES READ.
 *
 * The browser and `apps/api` are two programs that have to agree exactly on
 * a wire format, and this file is the only place that agreement is written
 * down — the same argument `RUN_EVENT_TYPES` is here for, one layer out. A
 * second frame union in `src/lib/` would be a client that silently drops
 * whichever frame the two copies disagree about, and the frame most likely
 * to be dropped is `resync_required`, which is the one that says a hole
 * exists.
 *
 * ## The subprotocol, and why the token travels in it
 *
 * A browser cannot set an `Authorization` header on a `WebSocket`. Three
 * options existed:
 *
 *  - a token in the QUERY STRING — which lands in every proxy access log and
 *    would make §14's *"no log line contains a credential"* false at the one
 *    hop nginx logs by default;
 *  - a single-use TICKET — which needs shared state across replicas, and so
 *    becomes a table holding a credential;
 *  - the token in `Sec-WebSocket-Protocol` — a header, absent from nginx's
 *    `combined` log format, needing no state, and identical at any replica
 *    count.
 *
 * The third. `new WebSocket(url, [WS_SUBPROTOCOL, `bearer.${token}`])`.
 *
 * THE SERVER MUST ECHO BACK EXACTLY ONE ACCEPTED SUBPROTOCOL — this one —
 * or the browser closes the connection immediately with no error a developer
 * can read. That is the single most common way this pattern ships broken,
 * and it fails identically to a network problem.
 */
export const WS_SUBPROTOCOL = 'lexprompt.v1';

/** The prefix the access token travels under, in the same header. Declared
 *  here so the client that writes it and the server that reads it cannot
 *  spell it two ways. */
export const WS_BEARER_PREFIX = 'bearer.';

/** The path, in one place, for the same reason. */
export const WS_PATH = '/v1/ws';

/**
 * What a client sends.
 *
 * `lastEventId` is the client's cursor for THAT subscription, and it is per
 * subscription rather than per socket (§8: "the client keeps the highest id
 * it has applied, per subscription"). One shared cursor across two
 * subscriptions would replay one of them from the other's position, which is
 * a silent gap on the busier of the two.
 */
export type ClientFrame =
  | { t: 'subscribe'; sub: SubscriptionRef; lastEventId: number }
  | { t: 'unsubscribe'; sub: SubscriptionRef }
  | { t: 'pong' };

/**
 * What the server sends.
 *
 * `refused` rather than silence, and `resync_required` rather than a short
 * replay, are the two frames this whole design turns on. A subscription that
 * is quietly never fed is indistinguishable from a review where nothing is
 * happening; a replay that silently returns only what survives hands the
 * client a hole it cannot see. Both are the founding defect wearing a
 * websocket.
 */
export type ServerFrame =
  | { t: 'hello'; instanceId: string; userId: string }
  | { t: 'event'; sub: SubscriptionRef; event: AppEvent }
  | { t: 'caught_up'; sub: SubscriptionRef; cursor: number }
  | { t: 'resync_required'; sub: SubscriptionRef }
  | { t: 'refused'; sub?: SubscriptionRef; reason: string }
  | { t: 'ping' };

/**
 * The close codes this server uses, and what each means to a client.
 *
 * 4001 is the one the browser acts on differently: the token expired or was
 * refused mid-connection, so the client refreshes and reconnects rather than
 * backing off as it would from a transport failure. Every other close is the
 * ordinary drop path.
 *
 * In the 4000-4999 range, which RFC 6455 reserves for the application: a
 * code below 4000 would collide with a meaning the protocol already gives it.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4001;
export const WS_CLOSE_UNRESPONSIVE = 4002;
export const WS_CLOSE_TOO_MANY = 4003;

/** Whether a parsed value is a frame this server will act on. Narrowing
 *  rather than casting: a frame arriving from a client is untrusted input,
 *  and a `t` nothing matches must produce a `refused` rather than a silent
 *  drop. */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { t?: unknown }).t;
  if (t === 'pong') return true;
  if (t !== 'subscribe' && t !== 'unsubscribe') return false;
  const sub = (value as { sub?: unknown }).sub;
  if (!isSubscriptionRef(sub)) return false;
  if (t === 'unsubscribe') return true;
  return typeof (value as { lastEventId?: unknown }).lastEventId === 'number';
}

/**
 * Whether a value is one of §8's three subscription shapes — EXACTLY one.
 *
 * `{ review: 'r', matter: 'm' }` is refused rather than resolved to
 * whichever key is checked first: a client that sent both meant something
 * this server cannot honour, and picking one silently is how a reader ends
 * up watching a subscription they did not ask for.
 */
export function isSubscriptionRef(value: unknown): value is SubscriptionRef {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1) return false;
  const [key] = keys;
  if (key !== 'review' && key !== 'matter' && key !== 'run') return false;
  return typeof (value as Record<string, unknown>)[key] === 'string'
    && (value as Record<string, string>)[key].length > 0;
}
