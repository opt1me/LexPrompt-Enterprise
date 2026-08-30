import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ModelError, isClientFrame, uid,
  WS_BEARER_PREFIX, WS_CLOSE_UNRESPONSIVE, WS_PATH, WS_SUBPROTOCOL,
  type AppEvent, type ClientFrame, type ServerFrame, type SubscriptionRef,
} from '@lexprompt/core';
import type { Principal } from '../oidc.ts';
import type { Actor } from '../auth/actor.ts';
import type { Db } from '../db/pool.ts';
import { readEvents } from '../run/events.ts';
import { ROLE_RANK } from '../auth/roles.ts';
import { ROUTE_POLICY, routeKey } from '../auth/routeTable.ts';
import type { Connection, Hub } from './hub.ts';

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

  return async () => {
    clearInterval(timer);
    server.off('upgrade', onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => { wss.close(() => resolve()); });
  };
}

interface SocketState {
  conn: Connection;
  missedPings: number;
  subs: Map<string, SubscriptionRef>;
}

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
  try {
    const principal = await deps.verify(token);
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

  wss.handleUpgrade(req, socket, head, ws => { onConnection(ws, actor, deps); });
}

function onConnection(ws: WebSocket, actor: Actor, deps: SocketDeps): void {
  const conn: Connection = {
    id: uid(),
    workspaceId: actor.workspaceId,
    userId: actor.id,
    send: frame => send(ws, frame),
  };
  const state: SocketState = { conn, missedPings: 0, subs: new Map() };
  STATE.set(ws, state);
  deps.hub.open(conn);

  // The instance id is what makes "these two sockets are on different
  // replicas" a fact a test can assert rather than a hope.
  send(ws, { t: 'hello', instanceId: deps.instanceId, userId: actor.id });

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
    return;
  }
  await subscribe(ws, state, frame.sub, frame.lastEventId, deps);
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
    // 2. REPLAY from the cursor.
    const page = await readEvents(deps.db, {
      workspaceId: state.conn.workspaceId,
      subscription: sub,
      after: lastEventId,
      limit: deps.caps.eventPageMax,
    });
    if (page.resyncRequired) {
      // NEVER a silently short replay. The client re-reads the state those
      // events described rather than pretending it saw them.
      send(ws, { t: 'resync_required', sub });
    }
    let cursor = page.nextCursor;
    for (const event of page.events) {
      send(ws, { t: 'event', sub, event });
      cursor = Math.max(cursor, event.id);
    }
    cursorSeen = cursor;
    // 3. FLUSH what arrived during the replay, de-duplicated by id.
    for (const event of buffered) {
      if (event.id <= cursor) continue;
      send(ws, { t: 'event', sub, event });
      cursor = Math.max(cursor, event.id);
    }
    cursorSeen = cursor;
    send(ws, { t: 'caught_up', sub, cursor });
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
