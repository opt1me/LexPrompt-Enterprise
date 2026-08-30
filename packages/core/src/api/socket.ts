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
 * WHERE SOMEBODY IS, COARSELY (§8).
 *
 * A closed set, narrowed on the way in, for the reason every closed set in
 * this codebase is closed: a screen name a client invented would reach a
 * roster and be rendered, and the roster is a surface about PEOPLE. Coarse
 * on purpose - "which review, which clause" is as fine as this goes, and a
 * path or a URL would be a record of where a colleague has been rather than
 * a signal that they are here now.
 */
export const PRESENCE_SCREENS = ['review', 'matter', 'playbook'] as const;
export type PresenceScreen = (typeof PRESENCE_SCREENS)[number];

export function isPresenceScreen(value: unknown): value is PresenceScreen {
  return typeof value === 'string' && (PRESENCE_SCREENS as readonly string[]).includes(value);
}

/**
 * ONE PERSON ON A ROSTER - advisory, ephemeral, and carrying no time.
 *
 * ## It carries no timestamp, deliberately
 *
 * The server holds the instant of a member's last beat (`PresenceBeat` in
 * `apps/api/src/realtime/presence.ts`) because the TTL sweep needs it. It
 * does NOT travel here. A "last seen 3m ago" is a claim about the past
 * dressed as a claim about now, and it is the first thing anybody would
 * build out of a timestamp on this shape - while the roster expires at
 * fifteen seconds, so a three-minute-old entry cannot exist and rendering
 * one would be a lie the wire made possible.
 *
 * ## It carries no name and no initials
 *
 * `userId` only. The browser resolves it through `src/lib/api/users.ts`,
 * which is the one id-to-name resolver (P32) - the same rule an event
 * payload follows. An id this workspace's directory does not hold renders as
 * an unnamed colleague, never as a raw id.
 *
 * ## A member is NOT a disposition
 *
 * Nothing on this shape says anything about a finding. A face on a clause
 * means somebody is looking at it and never that they have decided
 * anything; the day this type grows a field about a judgement is the day
 * presence starts making a claim it cannot support.
 */
export interface PresenceMember {
  userId: string;
  screen: PresenceScreen;
  /** The clause they have SELECTED, when they have selected one. */
  clauseId?: string;
}

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
  | { t: 'pong' }
  /**
   * §8'S HEARTBEAT - *"I am here, on this screen, looking at this clause."*
   *
   * It carries NO identity. The `userId` on the roster the server publishes
   * comes from the token this socket was upgraded with and from nowhere
   * else: a frame naming a user would let a client put a colleague's face on
   * a clause, which is the one thing an advisory signal must not be able to
   * do. It carries no display name either, for the reason P32 gives - a name
   * is a mutable field on `app_user` and `src/lib/api/users.ts` is the only
   * place an id becomes one.
   *
   * `clauseId` is the clause the reader SELECTED, never the one nearest the
   * top of the viewport. A scroll-derived presence would broadcast a stream
   * of clause changes and would tell a colleague something the reader never
   * chose to say.
   */
  | { t: 'presence'; sub: SubscriptionRef; screen: PresenceScreen; clauseId?: string };

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
  /**
   * `presenceHeartbeatMs` is the interval THE SERVER ASKS FOR, and the
   * client beats at it rather than at a constant of its own.
   *
   * The TTL that expires a roster entry is `API_PRESENCE_TTL_MS`, and it is
   * only meaningful relative to the interval beats actually arrive at. Two
   * numbers - one in a deployment's environment and one compiled into a
   * browser bundle - is how a raised TTL silently becomes a roster that
   * expires between beats: a colleague flickering in and out, which reads as
   * somebody repeatedly opening and closing the review.
   */
  | { t: 'hello'; instanceId: string; userId: string; presenceHeartbeatMs: number }
  | { t: 'event'; sub: SubscriptionRef; event: AppEvent }
  | { t: 'caught_up'; sub: SubscriptionRef; cursor: number }
  | { t: 'resync_required'; sub: SubscriptionRef }
  | { t: 'refused'; sub?: SubscriptionRef; reason: string }
  /**
   * WHO ELSE IS HERE - the whole roster, on change only (§8, S6).
   *
   * The whole roster rather than a join/leave delta, because a client that
   * missed one delta would claim a colleague is present for the rest of the
   * session, and *"a stale presence indicator that claims someone is there
   * is worse than no indicator"*. A snapshot cannot drift: the client
   * renders what the last frame said and never its own accumulated view.
   *
   * `members` is EMPTY, never absent, when the last person leaves. That
   * frame is the one that clears a face off a clause, and it is the reason
   * the roster is broadcast on change rather than only when somebody
   * arrives.
   */
  | { t: 'presence'; sub: SubscriptionRef; members: PresenceMember[] }
  | { t: 'ping' };

/**
 * The close codes this server uses, and what each means to a client.
 *
 * 4001 is the one the browser acts on differently: the token expired, or the
 * account behind it stopped being allowed, so the client resets its backoff
 * and reconnects on a refreshed token rather than treating it as a transport
 * failure. 4002 is two unanswered pings. Every other close is the ordinary
 * drop path.
 *
 * In the 4000-4999 range, which RFC 6455 reserves for the application: a
 * code below 4000 would collide with a meaning the protocol already gives it.
 *
 * ## There is no 4003, and there must not be one
 *
 * A `WS_CLOSE_TOO_MANY = 4003` was exported here, under the sentence "the
 * close codes this server uses", with nothing sending it and nothing reading
 * it — and nothing could: `API_WS_MAX_CONNECTIONS` is enforced BEFORE the
 * upgrade (`authenticateAndUpgrade`), as a plain HTTP 429 carrying a
 * sentence, precisely so a refused connection is legible rather than
 * arriving as a close event with no readable cause. A close code for a
 * socket that never comes into being cannot be sent, so it is gone rather
 * than left standing as documentation of behaviour that does not exist.
 */
export const WS_CLOSE_UNAUTHENTICATED = 4001;
export const WS_CLOSE_UNRESPONSIVE = 4002;

/** Whether a parsed value is a frame this server will act on. Narrowing
 *  rather than casting: a frame arriving from a client is untrusted input,
 *  and a `t` nothing matches must produce a `refused` rather than a silent
 *  drop. */
export function isClientFrame(value: unknown): value is ClientFrame {
  if (typeof value !== 'object' || value === null) return false;
  const t = (value as { t?: unknown }).t;
  if (t === 'pong') return true;
  if (t !== 'subscribe' && t !== 'unsubscribe' && t !== 'presence') return false;
  const sub = (value as { sub?: unknown }).sub;
  if (!isSubscriptionRef(sub)) return false;
  if (t === 'unsubscribe') return true;
  if (t === 'presence') {
    const frame = value as { screen?: unknown; clauseId?: unknown };
    if (!isPresenceScreen(frame.screen)) return false;
    // ABSENT or a non-empty string, never `null` and never a number. A
    // `clauseId` this server could not read is REFUSED rather than dropped
    // to `undefined`: a beat that silently loses its clause puts a colleague
    // on the review and on no clause, which reads as somebody looking at
    // nothing.
    return frame.clauseId === undefined
      || (typeof frame.clauseId === 'string' && frame.clauseId.length > 0);
  }
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
