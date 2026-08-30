import { WebSocket } from 'undici';

/**
 * ONE WEBSOCKET CLIENT FOR EVERY SUITE THAT NEEDS ONE.
 *
 * Node 20 has no global `WebSocket` (checked: `typeof WebSocket` is
 * `undefined` on the 20.20.1 this repository runs), so a client has to come
 * from somewhere. `undici` is already an `apps/api` dependency and ships one
 * that speaks the browser API including the subprotocol array — which is the
 * property that matters here, because the token travels in
 * `Sec-WebSocket-Protocol` and a client that cannot send one cannot
 * authenticate at all.
 *
 * Written once rather than per suite. Three suites drive a socket
 * (`socket.pg.test.ts`, `wsProxy.compose.test.ts`,
 * `replicaFanout.compose.test.ts`) and a second copy of "collect frames
 * until X" is the sibling drift this project has six findings about — the
 * copy that stays green when the property breaks is always the weaker one.
 *
 * ## The frames are typed loosely HERE and strictly at the call site
 *
 * `ServerFrame` lives in `@lexprompt/core` (Task 16) and both sides read it.
 * This helper deliberately does not narrow: it hands back whatever the
 * server sent, so a test asserting on a frame the union does not describe
 * fails as a wrong assertion rather than being silently unrepresentable.
 */
export interface Frame {
  t: string;
  [key: string]: unknown;
}

export const WS_SUBPROTOCOL = 'lexprompt.v1';

export interface WaitOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export interface TestSocket {
  /** Every frame received so far, in arrival order. */
  readonly frames: Frame[];
  /** The subprotocol the server echoed back. `''` when it echoed none —
   *  which is the failure a browser reports as a bare close with no error. */
  readonly protocol: string;
  send(frame: unknown): void;
  /** The next frame satisfying `match`, including ones already received. */
  waitFor(match: string | ((f: Frame) => boolean), opts?: WaitOptions): Promise<Frame>;
  /** Everything up to and including the first frame satisfying `match`. */
  collectUntil(match: (f: Frame) => boolean, opts?: WaitOptions): Promise<Frame[]>;
  /** Resolves after `ms` with no frames required — for the idle tests. */
  idleFor(ms: number): Promise<void>;
  readonly open: boolean;
  close(): void;
  /** The close code, once closed. `undefined` while open. */
  readonly closeCode: number | undefined;
}

/**
 * Opens a socket and RESOLVES ONLY WHEN IT IS OPEN — or rejects saying which
 * of the two things went wrong.
 *
 * A refused upgrade and an unreachable server both surface to a browser as
 * the same silent close, which is exactly why this rejects with the close
 * code rather than resolving a socket nobody can use.
 */
export async function connect(
  url: string, token: string, opts: WaitOptions = {},
): Promise<TestSocket> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ws = new WebSocket(url, [WS_SUBPROTOCOL, `bearer.${token}`]);
  const frames: Frame[] = [];
  const waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  let closeCode: number | undefined;

  ws.addEventListener('message', event => {
    const data = typeof event.data === 'string' ? event.data : String(event.data);
    let frame: Frame;
    try {
      frame = JSON.parse(data) as Frame;
    } catch {
      // A frame that is not JSON is a protocol violation and must not be
      // swallowed: it is recorded as one so an assertion can name it.
      frame = { t: '__unparseable', raw: data };
    }
    frames.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].match(frame)) {
        waiters[i].resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the socket at ${url} did not open within ${timeoutMs}ms`)),
      timeoutMs);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('close', event => {
      closeCode = event.code;
      clearTimeout(timer);
      reject(new Error(
        `the socket at ${url} closed before it opened (code ${event.code}${
          event.reason ? `, ${event.reason}` : ''}). A refused upgrade closes exactly like an `
        + 'unreachable server, so the code is the only thing that tells them apart.'));
    }, { once: true });
    ws.addEventListener('error', () => { /* the close event carries the code */ });
  });

  ws.addEventListener('close', event => { closeCode = event.code; });

  const socket: TestSocket = {
    frames,
    get protocol() { return ws.protocol; },
    get open() { return ws.readyState === 1; },
    get closeCode() { return closeCode; },
    send(frame: unknown) { ws.send(JSON.stringify(frame)); },
    waitFor(match, waitOpts = {}) {
      const predicate = typeof match === 'string' ? (f: Frame) => f.t === match : match;
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      const ms = waitOpts.timeoutMs ?? timeoutMs;
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          `no frame matching ${typeof match === 'string' ? match : 'the predicate'} within ${ms}ms.`
          + ` Received: ${JSON.stringify(frames.map(f => f.t))}`)), ms);
        waiters.push({ match: predicate, resolve: f => { clearTimeout(timer); resolve(f); } });
      });
    },
    async collectUntil(match, waitOpts = {}) {
      const last = await socket.waitFor(match, waitOpts);
      const end = frames.indexOf(last);
      return frames.slice(0, end + 1);
    },
    idleFor(ms: number) {
      return new Promise<void>(resolve => { setTimeout(resolve, ms); });
    },
    close() { ws.close(); },
  };
  return socket;
}

/**
 * TWO SOCKETS ON DIFFERENT REPLICAS, OR A FAILURE THAT SAYS SO.
 *
 * Extracted from `replicaFanout.compose.test.ts` when `presence.compose.
 * test.ts` needed the same condition — at the SECOND copy, per `CLAUDE.md`,
 * because the copy that stays green when the property breaks is always the
 * weaker one, and here the property is the whole premise of both files.
 *
 * The loop is bounded and the bound is the assertion: nginx round-robins
 * over the addresses its resolver returns, so a handful of attempts is
 * plenty, and twenty that all land on one replica means the multi-replica
 * condition does not exist — which must be a failure, not a pass.
 *
 * Every socket it opens (including the ones it discards) is pushed onto
 * `keep`, so the calling suite's `afterAll` closes them: a suite that leaks
 * an open socket leaves the server holding a connection against its cap.
 */
export async function socketsOnDistinctReplicas(
  url: string, firstToken: string, secondToken: string, keep: TestSocket[],
): Promise<[TestSocket, TestSocket]> {
  const first = await connect(url, firstToken);
  keep.push(first);
  const firstHello = await first.waitFor('hello');
  const seen = new Set<string>([String(firstHello.instanceId)]);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const next = await connect(url, secondToken);
    keep.push(next);
    // eslint-disable-next-line no-await-in-loop
    const hello = await next.waitFor('hello');
    if (hello.instanceId !== firstHello.instanceId) return [first, next];
    seen.add(String(hello.instanceId));
    next.close();
  }
  throw new Error(
    'twenty connections all landed on one replica '
    + `(instance ids seen: ${[...seen].join(', ')}). The cross-replica condition this file `
    + 'tests does not exist, so a pass here would mean nothing. Check that `api` really is '
    + 'running at two replicas (`docker compose ps`) and that nginx is resolving it per '
    + 'request (infra/nginx/web.conf).');
}
