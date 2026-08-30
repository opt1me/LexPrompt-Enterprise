import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { WS_PATH, WS_SUBPROTOCOL } from '@lexprompt/core';
import type { FastifyInstance } from 'fastify';
import { buildTestApi, collectRoutes, WORKSPACE_ID } from './helpers/apiHarness.ts';
import { ROUTE_POLICY, routeKey } from '../src/auth/routeTable.ts';
import { ROOT, codeOf } from './sourceScan.ts';

/**
 * S29 AT THE ONE PLACE THIS STAGE COULD BREAK IT.
 *
 * A socket that upgrades first and authenticates on its first frame is an
 * unauthenticated connection that exists, however briefly — an
 * authentication bypass wearing a different protocol. So every case below
 * asserts something about what happens BEFORE the 101: a status code, and
 * the absence of an `Upgrade` header.
 *
 * These are raw HTTP upgrade requests rather than `WebSocket` clients,
 * deliberately. A refused upgrade reaches a `WebSocket` as a close event with
 * no readable cause, which is exactly the shape a test must not be written
 * against: it cannot tell a 401 from a 403 from a server that is not there.
 */

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt',
  subject: 'sub-ws',
  groups: ['reviewers'],
};

interface UpgradeResult {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** True only if the server actually completed the handshake. */
  upgraded: boolean;
}

/**
 * One raw upgrade request, answered with whatever the server sends.
 *
 * `node:http`'s client emits `upgrade` when the server answered 101 and
 * `response` when it answered anything else, so the two are distinguishable
 * here in a way they are not from a `WebSocket`.
 */
async function rawUpgrade(
  app: FastifyInstance, opts: { protocols?: string[]; path?: string } = {},
): Promise<UpgradeResult> {
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return new Promise<UpgradeResult>((resolve, reject) => {
    const headers: Record<string, string> = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    };
    if (opts.protocols && opts.protocols.length > 0) {
      headers['sec-websocket-protocol'] = opts.protocols.join(', ');
    }
    const req = httpRequest({ port, host: '127.0.0.1', path: opts.path ?? WS_PATH, headers });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({
        statusCode: res.statusCode ?? 0, headers: res.headers, body: '', upgraded: true,
      });
    });
    req.on('response', res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({
        statusCode: res.statusCode ?? 0, headers: res.headers, body, upgraded: false,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

const servers: FastifyInstance[] = [];

async function listening(opts: Parameters<typeof buildTestApi>[0]): Promise<FastifyInstance> {
  const { app } = buildTestApi(opts);
  await app.listen({ port: 0, host: '127.0.0.1' });
  servers.push(app);
  return app;
}

afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
});

describe('the socket is authenticated before it is upgraded (S29)', () => {
  it('refuses an upgrade with no token, before upgrading', async () => {
    const app = await listening({ principal: null });
    const res = await rawUpgrade(app, { protocols: [WS_SUBPROTOCOL] });
    expect(res.statusCode).toBe(401);
    // IT NEVER BECAME A SOCKET. Both halves: no 101, and no `Upgrade:`
    // header on the response.
    expect(res.upgraded).toBe(false);
    expect(res.headers.upgrade).toBeUndefined();
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'sign_in_required' } });
  });

  it('refuses a token the verifier rejects, before upgrading', async () => {
    // `principalError` is how the harness reproduces a token from the wrong
    // issuer, an expired one, or one with a bad signature: `verify` rejects
    // with a `ModelError`, which is what the real verifier does.
    const app = await listening({
      principal: null,
      principalError: {
        code: 'sign_in_required', status: 401,
        message: 'LexPrompt could not verify this sign-in.',
      },
    });
    const res = await rawUpgrade(app, {
      protocols: [WS_SUBPROTOCOL, 'bearer.a-token-from-somewhere-else'],
    });
    expect(res.statusCode).toBe(401);
    expect(res.upgraded).toBe(false);
    expect(res.headers.upgrade).toBeUndefined();
  });

  it('answers a refusal in LexPrompts own envelope, not a bare status line', async () => {
    // "sign in again" and "ask your administrator" are different
    // instructions, and a status number with no cause is the quiet-wrong
    // answer shape one layer down. A `group_overage` stays a 403.
    const app = await listening({
      principal: null,
      principalError: {
        code: 'group_overage', status: 403,
        message: 'Your sign-in carries too many groups for LexPrompt to read.',
      },
    });
    const res = await rawUpgrade(app, { protocols: [WS_SUBPROTOCOL, 'bearer.t'] });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: { code: 'group_overage' } });
  });

  it('echoes exactly one subprotocol, and it is lexprompt.v1', async () => {
    // THE SINGLE MOST COMMON WAY THIS PATTERN SHIPS BROKEN. A server that
    // echoes none, or echoes the bearer entry, makes the browser close the
    // connection immediately with no error a developer can read — and it
    // fails identically to a network problem.
    const app = await listening({ principal: PRINCIPAL });
    const res = await rawUpgrade(app, { protocols: [WS_SUBPROTOCOL, 'bearer.good-token'] });
    expect(res.upgraded).toBe(true);
    expect(res.statusCode).toBe(101);
    expect(res.headers['sec-websocket-protocol']).toBe(WS_SUBPROTOCOL);
  });

  it('refuses an upgrade that does not offer the subprotocol at all', async () => {
    const app = await listening({ principal: PRINCIPAL });
    const res = await rawUpgrade(app, { protocols: ['bearer.good-token'] });
    expect(res.upgraded).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it('refuses an upgrade on any other path', async () => {
    // Loudly rather than by ignoring it: an unanswered upgrade hangs until
    // the client's own timeout, which reads as an unreachable server.
    const app = await listening({ principal: PRINCIPAL });
    const res = await rawUpgrade(app, {
      path: '/v1/not-the-socket', protocols: [WS_SUBPROTOCOL, 'bearer.good-token'],
    });
    expect(res.upgraded).toBe(false);
    expect(res.statusCode).toBe(400);
  });

  it('has no bypass — and this is what the mutation is run against', () => {
    /*
     * §14: "add a SKIP_AUTH path and the auth suite must fail". The mutation:
     * add an `if (process.env.WS_ALLOW_ANON)` branch to
     * `realtime/socket.ts` and confirm THIS goes red. Restore.
     */
    const code = codeOf(path.join(ROOT, 'apps/api/src/realtime/socket.ts'));
    expect(code).not.toMatch(/SKIP|ANON|allowAnonymous|process\.env\./);
    // The sanity checks, so the absences above are facts about the file
    // rather than about a scan that read nothing.
    expect(code).toMatch(/deps\.verify\(token\)/);
    expect(code).toMatch(/resolveActor/);
    // …and the ORDER, which is the whole claim: nothing calls
    // `handleUpgrade` before the token has been verified.
    expect(code.indexOf('handleUpgrade')).toBeGreaterThan(code.indexOf('deps.verify(token)'));
  });
});

describe('the socket route is a route, so every route-wide guard sees it', () => {
  it('is in ROUTE_POLICY at the reviewer bar', () => {
    expect(ROUTE_POLICY[routeKey('GET', WS_PATH)]).toBe('reviewer');
  });

  it('is registered with a LITERAL path, or the 401 sweep cannot see it', async () => {
    /*
     * THE DEFECT THIS TEST EXISTS FOR, FOUND BY RUNNING THE SUITE AND NOT
     * BELIEVING THE GREEN.
     *
     * `oidc.test.ts`'s route-discovery scanner matches
     * `app.get(  '<url>'` — a quoted literal. Registered as
     * `app.get(WS_PATH, …)` the socket route was invisible to it: the
     * no-token 401 sweep passed at its pinned count of 65 with a new route
     * it had never touched, on the one route whose entire design claim is
     * that it is authenticated.
     *
     * So `server.ts` writes the path out, and this asserts the literal and
     * the constant agree — which is what stops the two drifting now that
     * there are two of them.
     */
    const server = codeOf(path.join(ROOT, 'apps/api/src/server.ts'));
    expect(server).toContain("app.get('/v1/ws'");
    expect(WS_PATH).toBe('/v1/ws');
  });

  it('appears in Fastifys own route table, at the workspace the actor names', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    await app.ready();
    const keys = collectRoutes(app).map(r => routeKey(r.method, r.url));
    expect(keys).toContain(routeKey('GET', WS_PATH));
    expect(WORKSPACE_ID).toBeTruthy();
    await app.close();
  });

  it('answers 426 to an ordinary GET, rather than a 404 or a hang', async () => {
    const { app } = buildTestApi({ principal: PRINCIPAL });
    const res = await app.inject({
      method: 'GET', url: WS_PATH, headers: { authorization: 'Bearer good' },
    });
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ error: { code: 'unknown' } });
    expect(res.json().error.message).toContain(WS_SUBPROTOCOL);
    await app.close();
  });
});
