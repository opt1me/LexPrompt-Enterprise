import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ModelError, isClientFrame, uid,
  WS_BEARER_PREFIX, WS_CLOSE_UNAUTHENTICATED, WS_CLOSE_UNRESPONSIVE, WS_PATH, WS_SUBPROTOCOL,
  type AppEvent, type ClientFrame, type PresenceScreen, type Role, type ServerFrame,
  type SubscriptionRef,
} from '@lexprompt/core';
import type { Principal } from '../oidc.ts';
import type { Actor } from '../auth/actor.ts';
import type { Db } from '../db/pool.ts';
import { readEvents } from '../run/events.ts';
import { ROLE_RANK } from '../auth/roles.ts';
import { ROUTE_POLICY, routeKey } from '../auth/routeTable.ts';
import type { Connection, Hub } from './hub.ts';
import {
  encodePresence, PRESENCE_CHANNEL,
  type PresenceNotification, type PresenceRegistry, type PresenceScope,
} from './presence.ts';

/**
 * §8'S TRANSPORT — AUTHENTICATED BEFORE IT IS UPGRADED.
 *
 * ## Why this handles the raw `upgrade` event instead of using a plugin
 *
 * A ruling, recorded rather than taken quietly. `@fastify/websocket` exists
 * and supports Fastify 5, and it would be less code. It performs the HTTP
 * upgrade inside Fastify's own routing lifecycle, so whether the 101 is
 * written before or after this application's authentication hook is a
 * property of that plugin's internals rather than of anything readable
 * here.
 *
 * S29 says there is no bypass and no anonymous mode anywhere in this system,
 * and a socket that upgrades first and authenticates on its first frame is
 * an unauthenticated connection that exists, however briefly — an
 * authentication bypass wearing a different protocol. A guarantee that
 * cannot be read in this repository's own source is not one that can be
 * asserted, so the upgrade is handled here: the token is verified, the actor
 * resolved and the role checked, and only then is `handleUpgrade` called at
 * all. Everything before that point answers a plain HTTP 401 and destroys
 * the socket, so `Upgrade:` never appears in a response and no WebSocket
 * ever comes into being.
 *
 * ## The route also exists in Fastify, and that is not a duplicate
 *
 * `GET /v1/ws` is registered as an ordinary route (`registerSocketRoute`)
 * answering 426 to a request that is not an upgrade. That is what puts it in
 * `ROUTE_POLICY`, in `authz.route.test.ts`'s bidirectional coverage check
 * and in `oidc.test.ts`'s no-token 401 sweep — a socket route registered
 * some other way would be SILENTLY ABSENT from all three, which is the shape
 * of a test that cannot fail. The two paths share one policy lookup
 * (`ROUTE_POLICY[routeKey('GET', WS_PATH)]`) rather than two role decisions.
 */

export interface SocketDeps {
  verify(token: string): Promise<Principal>;
  resolveActor(principal: Principal): Promise<Actor>;
  db: Db;
  hub: Hub;
  /**
   * WHO IS HERE, in this process's memory and nowhere else (Task 22, S6).
   *
   * Shared with `feed.ts`, which merges the beats other replicas publish on
   * `PRESENCE_CHANNEL` into the same registry — one roster per replica,
   * whether a colleague happens to be connected to this one or another.
   */
  presence: PresenceRegistry;
  /** This process's identity, echoed on every `hello`. `main.ts` passes the
   *  same `api-${hostname()}` the worker pool uses, so "which replica am I
   *  on" is answerable from a frame — which is what
   *  `replicaFanout.compose.test.ts` rests on. */
  instanceId: string;
  caps: SocketCaps;
}

export interface SocketCaps {
  pingMs: number;
  maxConnections: number;
  maxSubscriptions: number;
  maxFrameBytes: number;
  /** `API_EVENT_PAGE_MAX` — the replay's page size, the same cap the HTTP
   *  cursor uses. */
  eventPageMax: number;
  /** `API_PRESENCE_HEARTBEAT_MS` — the interval this server ASKS the browser
   *  to beat at, sent on `hello`. See `ServerFrame`. */
  presenceHeartbeatMs: number;
  /** `API_PRESENCE_TTL_MS` — how often the sweep runs is derived from it. */
  presenceTtlMs: number;
  /**
   * How often a live socket's ACCOUNT is re-read. Optional and defaulted to
   * `REAUTH_EVERY_MS`, deliberately: it is not an operator's dial and has no
   * environment variable, so a deployment cannot turn revocation off by
   * setting it to an hour. It is here at all so a test can reach the branch
   * without waiting a minute of wall-clock time.
   */
  reauthMs?: number;
}

/** The role a socket needs, read from the SAME table every route reads. */
const POLICY_KEY = routeKey('GET', WS_PATH);

const send = (ws: WebSocket, frame: ServerFrame): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
};

/**
 * A plain HTTP refusal on a socket that never became one.
 *
 * Written by hand because there is no `reply` here: this runs on the
 * server's `upgrade` event, before any framework. The body is LexPrompt's
 * own envelope, the same shape `registerErrorEnvelope` sends, so a client
 * reading a failed upgrade reads the same `error.code` it would from any
 * other refusal.
 */
function refuseUpgrade(socket: Duplex, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  const text = status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request';
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n'
    + '\r\n'
    + body);
  socket.destroy();
}

/** The path of an origin-relative request URL — everything before `?`. The
 *  same helper `server.ts` needs, for the same reason: `req.url` has no
 *  base for `new URL` to work from. */
function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** The offered subprotocols, in order. `undefined` when the header is
 *  absent, which is a different fact from "offered none". */
function offeredProtocols(req: IncomingMessage): string[] {
  const header = req.headers['sec-websocket-protocol'];
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Attaches the socket to a running HTTP server.
 *
 * Returns a stop function: the ping timer is an interval that would keep a
 * process alive on its own, and a test that leaves one running is a test
 * that hangs.
 */
export function attachSocket(server: Server, deps: SocketDeps): () => Promise<void> {
  // `noServer: true` — `ws` performs no upgrade of its own and never sees a
  // request this module has not already authenticated.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: deps.caps.maxFrameBytes,
    // The echo. Exactly one, and it must be `lexprompt.v1`: a server that
    // echoes none, or echoes the bearer entry, makes the browser close the
    // connection immediately with no error a developer can read.
    handleProtocols: () => WS_SUBPROTOCOL,
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void authenticateAndUpgrade(req, socket, head, wss, deps);
  };
  server.on('upgrade', onUpgrade);

  /*
   * THE HEARTBEAT, AND WHY IT IS A SERVER FRAME RATHER THAN A PROTOCOL PING.
   *
   * `ws` has a protocol-level ping, and a browser answers it in the network
   * stack with no JavaScript involved — which means it proves the TCP
   * connection is alive and proves nothing about whether the page is still
   * running. The client's `pong` frame is application code answering, so a
   * tab that has been frozen or a script that has died stops answering and
   * is closed, which is the condition Task 20's `stale` exists for.
   */
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      const state = STATE.get(ws);
      if (!state) continue;
      /*
       * THE TOKEN RAN OUT (M3).
       *
       * A socket was authenticated at its upgrade and never again: no
       * expiry, no revocation, no re-resolve. The browser's own source
       * asserted the opposite as its reason for having no re-authentication
       * — *"a token expiring mid-connection closes the socket"* — and
       * nothing closed it, so a signed-out or disabled person's open tab
       * went on receiving every disposition change, note and assignment in
       * the workspace until somebody closed the tab.
       *
       * Closed with 4001 rather than left to the ping: an unresponsive
       * socket and an expired one are different facts, and the client acts
       * on this one differently (it reconnects on a refreshed token
       * immediately rather than backing off).
       */
      if (state.expiresAt !== undefined && Date.now() >= state.expiresAt) {
        ws.close(WS_CLOSE_UNAUTHENTICATED, 'token expired');
        continue;
      }
      state.sinceRecheck += deps.caps.pingMs;
      if (state.sinceRecheck >= (deps.caps.reauthMs ?? REAUTH_EVERY_MS)) {
        state.sinceRecheck = 0;
        void closeIfNoLongerAllowed(ws, state, deps);
      }
      if (state.missedPings >= 2) {
        // Two unanswered pings. Closed rather than left open: a socket the
        // server believes in and the client is not reading is precisely a
        // live view that has quietly stopped being live.
        ws.close(WS_CLOSE_UNRESPONSIVE, 'no pong');
        continue;
      }
      state.missedPings += 1;
      send(ws, { t: 'ping' });
    }
  }, deps.caps.pingMs);
  // A timer must not keep the process alive on its own — `unref` so a
  // shutdown is not held open by a heartbeat nobody is listening to.
  timer.unref?.();

  /*
   * THE TTL SWEEP — the thing that makes presence honest (Task 22, S6).
   *
   * It runs on its own clock and not off an arriving frame, and that is the
   * whole point: a replica nobody is beating at must still expire the people
   * it last heard from. Expiry driven by traffic would keep a roster alive
   * exactly when there is nobody left to correct it — *"a stale presence
   * indicator that claims someone is there is worse than no indicator"*, and
   * the quietest way to ship one is to expire on write.
   *
   * A THIRD of the TTL, so an entry is at most a third of a TTL stale beyond
   * it. Sweeping at the TTL itself would let an expired entry stand for
   * almost twice its life.
   */
  const sweepMs = Math.max(1_000, Math.floor(deps.caps.presenceTtlMs / 3));
  const sweeper = setInterval(() => { deps.presence.sweep(Date.now()); }, sweepMs);
  sweeper.unref?.();

  return async () => {
    clearInterval(timer);
    clearInterval(sweeper);
    server.off('upgrade', onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => { wss.close(() => resolve()); });
  };
}

interface SocketState {
  conn: Connection;
  missedPings: number;
  subs: Map<string, SubscriptionRef>;
  /** The actor this socket was upgraded as. Kept so the account behind it
   *  can be re-read; the ROLE here is the one checked at the upgrade, and a
   *  change to it is one of the two things the re-check looks for. */
  actor: Actor;
  /** `exp`, in milliseconds, or `undefined` for a token that carried none. */
  expiresAt?: number;
  /** Ping ticks since this socket's account was last re-read. See
   *  `REAUTH_EVERY_MS`. */
  sinceRecheck: number;
}

/**
 * HOW OFTEN A LIVE SOCKET'S ACCOUNT IS RE-READ.
 *
 * A socket is authenticated at the upgrade and then lives as long as the
 * tab. Expiry alone bounds that by the token's own lifetime, which is right
 * for a token but says nothing about an administrator who disabled an
 * account or dropped somebody below `reviewer` five minutes ago — that
 * decision takes effect on the next HTTP request and used to take effect on
 * a live socket NEVER. One cheap read per socket per minute closes it.
 *
 * A MINUTE, not a tick: the ping runs every 25s and 500 sockets re-resolving
 * on every one of them is a needless 20 reads a second, for a fact that
 * changes about once a year.
 */
const REAUTH_EVERY_MS = 60_000;

/**
 * How many pages of replay one `subscribe` will read before it stops and
 * tells the client to re-read instead.
 *
 * `API_EVENT_PAGE_MAX` is 500, so this is 10,000 events — comfortably more
 * than a busy review accumulates inside the seven-day retention window, and
 * still a bound: this runs inside a frame handler, and a subscription
 * arriving with `lastEventId: 0` against a workspace with a million rows
 * must not turn into an unbounded read on the socket's own thread.
 */
const REPLAY_PAGES_MAX = 20;

/** Per-socket state, off to the side so `WebSocket` is not decorated with
 *  fields `ws`'s own types do not know about. */
const STATE = new WeakMap<WebSocket, SocketState>();

async function authenticateAndUpgrade(
  req: IncomingMessage, socket: Duplex, head: Buffer,
  wss: WebSocketServer, deps: SocketDeps,
): Promise<void> {
  // Another `upgrade` listener may own a different path. Answering 404 here
  // rather than ignoring it means a mistyped path fails loudly instead of
  // hanging until the client's own timeout.
  if (pathOf(req.url ?? '') !== WS_PATH) {
    refuseUpgrade(socket, 400, 'unknown', `LexPrompt has no ${req.url ?? ''} socket.`);
    return;
  }

  const offered = offeredProtocols(req);
  if (!offered.includes(WS_SUBPROTOCOL)) {
    refuseUpgrade(socket, 400, 'unknown',
      `A LexPrompt socket must offer the ${WS_SUBPROTOCOL} subprotocol.`);
    return;
  }

  const bearer = offered.find(p => p.startsWith(WS_BEARER_PREFIX));
  const token = bearer ? bearer.slice(WS_BEARER_PREFIX.length) : '';
  if (!token) {
    // BEFORE THE UPGRADE. No 101, no `Upgrade:` header, no socket.
    refuseUpgrade(socket, 401, 'sign_in_required', 'Sign in to use LexPrompt.');
    return;
  }

  let actor: Actor;
  // The token's own deadline, carried off the verified principal so the
  // socket can be closed when it passes. `undefined` for a token with no
  // `exp`; the periodic account re-check is what covers that case.
  let expiresAt: number | undefined;
  try {
    const principal = await deps.verify(token);
    expiresAt = principal.expiresAt;
    actor = await deps.resolveActor(principal);
  } catch (err) {
    if (err instanceof ModelError) {
      // A `group_overage` stays a 403 and a bad token stays a 401, exactly
      // as `requireUser` answers one verbatim: "sign in again" and "ask your
      // administrator" are different instructions.
      refuseUpgrade(socket, err.status, err.code, err.message);
      return;
    }
    process.stderr.write(`api: socket upgrade failed: ${(err as Error).message}\n`);
    refuseUpgrade(socket, 401, 'sign_in_required', 'Sign in to use LexPrompt.');
    return;
  }

  // The SAME table every route is held to, read through the same key.
  const required = ROUTE_POLICY[POLICY_KEY];
  if (required !== 'public' && ROLE_RANK[actor.role] < ROLE_RANK[required]) {
    refuseUpgrade(socket, 403, 'not_permitted',
      `This needs the ${required} role. You have ${actor.role}.`);
    return;
  }

  if (deps.hub.size() >= deps.caps.maxConnections) {
    refuseUpgrade(socket, 429, 'rate_limited',
      `This LexPrompt server is holding its limit of ${deps.caps.maxConnections} live `
      + 'connections (API_WS_MAX_CONNECTIONS). Close a tab and try again.');
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => { onConnection(ws, actor, expiresAt, deps); });
}

/**
 * IS THIS PERSON STILL ALLOWED TO BE HERE?
 *
 * A read, never a write. `resolveActor` UPSERTS `app_user` — correct at a
 * sign-in, wrong on a timer, where it would rewrite a row once a minute per
 * open tab for a question that only needs reading. This asks the two things
 * the upgrade asked: is the account still active, and does it still hold the
 * role the socket route requires.
 *
 * A FAILED READ LEAVES THE SOCKET OPEN, deliberately. Closing every live
 * connection in the firm because the database blinked would turn a brief
 * outage into a self-inflicted one, and the exposure this closes is a person
 * whose access was withdrawn — bounded already by the token's own expiry
 * above. It is reported rather than swallowed.
 */
async function closeIfNoLongerAllowed(
  ws: WebSocket, state: SocketState, deps: SocketDeps,
): Promise<void> {
  let rows: { role: Role; status: string }[];
  try {
    rows = await deps.db.query<{ role: Role; status: string }>(
      'select role, status from app_user where id = $1 and workspace_id = $2',
      [state.actor.id, state.actor.workspaceId]);
  } catch (err) {
    process.stderr.write(
      `api: could not re-check socket ${state.conn.id} (${(err as Error).message}); `
      + 'it stays open until its token expires\n');
    return;
  }
  const row = rows[0];
  const required = ROUTE_POLICY[POLICY_KEY];
  const allowed = row !== undefined && row.status === 'active'
    && (required === 'public' || ROLE_RANK[row.role] >= ROLE_RANK[required]);
  if (!allowed) ws.close(WS_CLOSE_UNAUTHENTICATED, 'no longer permitted');
}

function onConnection(
  ws: WebSocket, actor: Actor, expiresAt: number | undefined, deps: SocketDeps,
): void {
  const conn: Connection = {
    id: uid(),
    workspaceId: actor.workspaceId,
    userId: actor.id,
    send: frame => send(ws, frame),
  };
  const state: SocketState = {
    conn, missedPings: 0, subs: new Map(), actor, sinceRecheck: 0,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
  STATE.set(ws, state);
  deps.hub.open(conn);

  // The instance id is what makes "these two sockets are on different
  // replicas" a fact a test can assert rather than a hope.
  send(ws, {
    t: 'hello',
    instanceId: deps.instanceId,
    userId: actor.id,
    // The interval this deployment asks for, rather than a constant compiled
    // into the browser bundle. See `ServerFrame`.
    presenceHeartbeatMs: deps.caps.presenceHeartbeatMs,
  });

  ws.on('message', data => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      send(ws, { t: 'refused', reason: 'That frame was not JSON.' });
      return;
    }
    if (!isClientFrame(parsed)) {
      // REFUSED, never dropped. A frame this server does not understand,
      // silently ignored, is a client waiting for an answer that is not
      // coming — the same failure as a subscription that is never fed.
      send(ws, {
        t: 'refused',
        reason: 'That is not a frame this LexPrompt server understands.',
      });
      return;
    }
    void handleFrame(ws, state, parsed, deps);
  });

  ws.on('close', () => {
    deps.hub.close(conn);
    /*
     * GONE NOW, not in fifteen seconds' time.
     *
     * The TTL is the backstop for a replica that died or a network that
     * disappeared — the cases where nobody is left to say so. A tab that
     * closes cleanly says so, here and (below) on every other replica, so a
     * colleague's face leaves the clause when they leave it.
     */
    for (const sub of state.subs.values()) {
      announcePresence(deps, {
        k: 'leave',
        workspaceId: conn.workspaceId,
        sub,
        beat: { connectionId: conn.id, userId: conn.userId, screen: 'review', at: Date.now() },
      });
    }
    deps.presence.leave(conn.id);
    STATE.delete(ws);
  });
  ws.on('error', err => {
    process.stderr.write(`api: socket ${conn.id} error: ${err.message}\n`);
  });
}

async function handleFrame(
  ws: WebSocket, state: SocketState, frame: ClientFrame, deps: SocketDeps,
): Promise<void> {
  if (frame.t === 'pong') {
    state.missedPings = 0;
    return;
  }
  if (frame.t === 'unsubscribe') {
    deps.hub.leave(state.conn, frame.sub);
    state.subs.delete(keyOf(frame.sub));
    // Leaving a subscription is leaving its roster. Without this a reader
    // who navigated away would stay on the clause index of a review they
    // are no longer looking at, for as long as their socket lived.
    announcePresence(deps, {
      k: 'leave',
      workspaceId: state.conn.workspaceId,
      sub: frame.sub,
      beat: {
        connectionId: state.conn.id, userId: state.conn.userId, screen: 'review', at: Date.now(),
      },
    });
    deps.presence.leave(state.conn.id, { workspaceId: state.conn.workspaceId, sub: frame.sub });
    return;
  }
  if (frame.t === 'presence') {
    handleBeat(ws, state, frame.sub, frame.screen, frame.clauseId, deps);
    return;
  }
  await subscribe(ws, state, frame.sub, frame.lastEventId, deps);
}

/**
 * *"I am here."* — recorded against the AUTHENTICATED actor, never against
 * anything the frame said.
 *
 * The beat carries a screen and a clause and no identity at all: `userId`
 * comes from the token this socket was upgraded with. A frame able to name a
 * user would let one client put a colleague's face on a clause, which is
 * the single thing an advisory signal must not be able to do — a face is not
 * a judgement, but a face somebody else planted is a claim about where a
 * person was.
 *
 * REFUSED on a subscription this socket has not joined, rather than
 * recorded. `subscribe` is where a subscription is checked for existence and
 * for workspace, and presence on an unchecked ref would let a signed-in
 * caller appear on any review id they can guess — and a refusal is what the
 * client needs to hear, because a beat that is silently dropped looks
 * exactly like a review nobody else is in.
 */
function handleBeat(
  ws: WebSocket, state: SocketState, sub: SubscriptionRef,
  screen: PresenceScreen, clauseId: string | undefined, deps: SocketDeps,
): void {
  if (!state.subs.has(keyOf(sub))) {
    send(ws, {
      t: 'refused', sub,
      reason: 'LexPrompt records presence only on a subscription this socket has joined.',
    });
    return;
  }
  const scope: PresenceScope = { workspaceId: state.conn.workspaceId, sub };
  const beat = {
    connectionId: state.conn.id,
    userId: state.conn.userId,
    screen,
    ...(clauseId === undefined ? {} : { clauseId }),
    // THIS REPLICA'S CLOCK, and the receiving replica's clock on the far
    // side of the notification below — never the sender's. Two container
    // clocks that disagree by a minute would otherwise expire one replica's
    // whole roster instantly or never, and a TTL is only meaningful measured
    // against the clock that sweeps it.
    at: Date.now(),
  };
  deps.presence.beat(scope, beat);
  announcePresence(deps, { k: 'beat', workspaceId: state.conn.workspaceId, sub, beat });
}

/**
 * The beat, to every other replica (P39's one exception).
 *
 * FIRE AND FORGET, and reported rather than awaited: presence is advisory,
 * so a notification that fails costs a colleague their place on one other
 * replica's roster for at most one TTL and gets it back on the next beat.
 * Awaiting it would put a database round trip in front of a frame handler
 * ten times a minute per reader, for a signal that is allowed to be wrong.
 */
function announcePresence(deps: SocketDeps, n: PresenceNotification): void {
  void deps.db.query('select pg_notify($1, $2)', [PRESENCE_CHANNEL, encodePresence(n)])
    .catch((err: Error) => {
      process.stderr.write(
        `api: could not announce presence (${err.message}); `
        + 'this replica\'s roster is still correct\n');
    });
}

const keyOf = (sub: SubscriptionRef): string => JSON.stringify(sub);

/**
 * JOIN FIRST, BUFFER, REPLAY, FLUSH, `caught_up`.
 *
 * The ORDER is load-bearing and it is the one thing a naive implementation
 * gets wrong. Replaying first and joining second drops every event that
 * lands in between — a gap exactly the width of the replay, invisible, and
 * worst on the busiest review.
 *
 * Buffered frames are de-duplicated against the replay BY ID. The client's
 * own version guard would drop the duplicate anyway, and that is the point:
 * two independent guards, because this is the one place a dropped event
 * leaves a human judgement on screen that the database does not hold (§8).
 */
async function subscribe(
  ws: WebSocket, state: SocketState, sub: SubscriptionRef, lastEventId: number,
  deps: SocketDeps,
): Promise<void> {
  if (!state.subs.has(keyOf(sub)) && state.subs.size >= deps.caps.maxSubscriptions) {
    send(ws, {
      t: 'refused',
      sub,
      reason: `One LexPrompt socket may hold ${deps.caps.maxSubscriptions} subscriptions `
        + '(API_WS_MAX_SUBSCRIPTIONS). This one was not added.',
    });
    return;
  }

  // A subscription a client names must be one this workspace can see. The
  // read predicate carries `workspace_id`, so a foreign id would simply
  // return nothing — and a subscription that is quietly never fed is
  // indistinguishable from a review where nothing is happening. So it is
  // refused, with a sentence, before it is joined.
  let exists: boolean;
  try {
    exists = await subscriptionExists(deps.db, state.conn.workspaceId, sub);
  } catch (err) {
    send(ws, {
      t: 'refused', sub,
      reason: `LexPrompt could not open that subscription (${(err as Error).message}).`,
    });
    return;
  }
  if (!exists) {
    send(ws, {
      t: 'refused', sub,
      reason: 'LexPrompt has no such review, matter or run in your workspace.',
    });
    return;
  }

  // 1. JOIN, so nothing that arrives from here on is lost.
  const buffered: AppEvent[] = [];
  // Hoisted so the `finally` below can hand the REAL connection the id this
  // socket has actually been caught up to — which is what the feed reads
  // this bucket forward from if it has no cursor of its own. Left at
  // `lastEventId` if the replay threw, which is the conservative direction:
  // the feed re-reads from there and the client drops what it already holds.
  let cursorSeen = lastEventId;
  const collector: Connection = {
    ...state.conn,
    send: frame => { if (frame.t === 'event') buffered.push(frame.event); },
  };
  deps.hub.join(collector, sub, lastEventId);

  try {
    /*
     * 2. REPLAY from the cursor — EVERY PAGE OF IT.
     *
     * `readEvents` fetches `limit + 1` so `hasMore` is *"a fact rather than
     * a guess"*, and its own docstring says **"silently short is the
     * failure"**. This read one page and sent `caught_up` regardless: past
     * `API_EVENT_PAGE_MAX` the client was told it was current while sitting
     * 500+ events behind — and with a second connection already in the
     * bucket, the shared feed cursor is ahead of the gap, so the missing
     * events are never delivered at all. A colleague's rejection lands in
     * that hole and the card never shows it, with no `resync_required` and
     * no `stale`. A 250-clause run emits about 500 events on its own.
     *
     * BOUNDED, because this runs inside a frame handler: at
     * `REPLAY_PAGES_MAX` pages the client is told `resync_required` instead
     * of `caught_up` and re-reads the state those events described. That is
     * the honest end — the same answer the retention gap gets — rather than
     * either a lie or an unbounded read.
     */
    let cursor = lastEventId;
    let resync = false;
    let truncated = false;
    for (let page = 0; page < REPLAY_PAGES_MAX; page += 1) {
      const read = await readEvents(deps.db, {
        workspaceId: state.conn.workspaceId,
        subscription: sub,
        after: cursor,
        limit: deps.caps.eventPageMax,
      });
      if (read.resyncRequired) resync = true;
      cursor = Math.max(cursor, read.nextCursor);
      for (const event of read.events) {
        send(ws, { t: 'event', sub, event });
        cursor = Math.max(cursor, event.id);
      }
      if (!read.hasMore) { truncated = false; break; }
      truncated = true;
    }
    if (resync) {
      // NEVER a silently short replay. The client re-reads the state those
      // events described rather than pretending it saw them.
      send(ws, { t: 'resync_required', sub });
    }
    cursorSeen = cursor;
    // 3. FLUSH what arrived during the replay, de-duplicated by id.
    for (const event of buffered) {
      if (event.id <= cursor) continue;
      send(ws, { t: 'event', sub, event });
      cursor = Math.max(cursor, event.id);
    }
    cursorSeen = cursor;
    if (truncated) {
      // NOT `caught_up`, because it is not caught up. Saying so at a cursor
      // the read itself reported was not the end is the whole finding.
      send(ws, { t: 'resync_required', sub });
    } else {
      send(ws, { t: 'caught_up', sub, cursor });
    }
  } finally {
    // 4. Swap the collector for the real connection, whatever happened. A
    // replay that threw must not leave a buffer in the hub forever.
    deps.hub.leave(collector, sub);
    deps.hub.join(state.conn, sub, cursorSeen);
    state.subs.set(keyOf(sub), sub);
  }
}

/**
 * Whether the thing a client named is a thing this workspace has.
 *
 * Three whole literals, one per shape, for the reason `run/events.ts`'s
 * `predicateFor` gives: a column name spliced into a template is a statement
 * no scanner can read the predicate of, and `workspace_id` is the predicate
 * that matters most here.
 */
async function subscriptionExists(
  db: Db, workspaceId: string, sub: SubscriptionRef,
): Promise<boolean> {
  if ('review' in sub) {
    const rows = await db.query<{ id: string }>(
      'select id from review where id = $1 and workspace_id = $2', [sub.review, workspaceId]);
    return rows.length > 0;
  }
  if ('matter' in sub) {
    const rows = await db.query<{ id: string }>(
      'select id from matter where id = $1 and workspace_id = $2', [sub.matter, workspaceId]);
    return rows.length > 0;
  }
  const rows = await db.query<{ id: string }>(
    'select id from run where id = $1 and workspace_id = $2', [sub.run, workspaceId]);
  return rows.length > 0;
}
