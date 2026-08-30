import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WS_SUBPROTOCOL } from '@lexprompt/core';
import { ROOT } from './sourceScan.ts';
import { API_BASE, signIn } from './helpers/twoAccounts.ts';
import { connect, type TestSocket } from './helpers/wsClient.ts';

/**
 * THE HANDSHAKE THROUGH THE WEB TIER, WHICH IS WHERE IT WAS BROKEN.
 *
 * `infra/nginx/web.conf`'s `/api/` block sets `proxy_http_version 1.1` and no
 * `Upgrade`/`Connection` headers, so before Task 17 a WebSocket handshake
 * through it failed — at the ONE hop local development can exercise, which is
 * exactly the class of defect Stage 1 shipped and fixed with
 * `client_max_body_size`. Here the layer CAN be exercised, so it is, in the
 * container.
 *
 * Everything below connects to **localhost:3005**, the PUBLISHED port. `api`
 * publishes none by construction (the `internal` network drops host traffic
 * both ways), so a test that connected to `api` directly would prove nothing
 * about what a browser can do — which is the whole point of this file.
 */

const WS_URL = `${API_BASE.replace(/^http/, 'ws')}/v1/ws`;

const sockets: TestSocket[] = [];

afterAll(() => {
  for (const s of sockets.splice(0)) s.close();
});

async function open(token: string): Promise<TestSocket> {
  const socket = await connect(WS_URL, token, { timeoutMs: 15_000 });
  sockets.push(socket);
  return socket;
}

describe('the web tier passes a WebSocket upgrade', () => {
  it('completes a handshake on the browser s own origin, through nginx', async () => {
    const trainee = await signIn('trainee');
    const socket = await open(trainee.token);
    expect(socket.open).toBe(true);
    // The echo. A proxy that forwarded the upgrade but dropped the
    // subprotocol header would look identical to a working one until a
    // browser refused the connection with no readable error.
    expect(socket.protocol).toBe(WS_SUBPROTOCOL);
    const hello = await socket.waitFor('hello', { timeoutMs: 10_000 });
    expect(typeof hello.instanceId).toBe('string');
    expect(hello.userId).toBe(trainee.userId);
  }, 30_000);

  it('refuses an upgrade with no token, through the proxy, before upgrading', async () => {
    // The refusal has to survive the hop too: a proxy that swallowed the
    // 401 body and answered its own 502 would leave a browser with nothing
    // to say. `connect` rejects on a close-before-open, which is what a
    // refused upgrade looks like to a client.
    await expect(connect(WS_URL, '', { timeoutMs: 10_000 })).rejects.toThrow(/closed before/);
  }, 30_000);

  it('holds the socket open past two ping intervals, on pings alone', async () => {
    /*
     * API_WS_PING_MS is 25s and nginx's socket location sets
     * `proxy_read_timeout 3600s`, so this is fine TODAY — and it is asserted
     * rather than assumed because the relationship between two numbers in
     * two files is exactly what silently inverts when somebody tunes one of
     * them. A socket killed by the proxy on a schedule is worse than no
     * socket: it is intermittent, and the app looks like a network with a
     * fault.
     *
     * The client answers each `ping` with a `pong`, which is what a browser
     * does — a socket idle in the sense of "no application traffic" but not
     * in the sense of "no bytes".
     */
    const trainee = await signIn('trainee');
    const socket = await open(trainee.token);
    const answered: number[] = [];
    const timer = setInterval(() => {
      const pings = socket.frames.filter(f => f.t === 'ping').length;
      if (pings > answered.length) {
        answered.push(pings);
        socket.send({ t: 'pong' });
      }
    }, 200);
    try {
      await socket.idleFor(55_000);
      expect(answered.length, 'no ping arrived in 55s; the heartbeat is not running')
        .toBeGreaterThanOrEqual(2);
      expect(socket.open, 'the proxy or the server closed an answered socket').toBe(true);
    } finally {
      clearInterval(timer);
    }
  }, 90_000);

  it('keeps the two timeouts in the right order, in the files that set them', () => {
    // The numbers, compared directly, so a future edit to either one fails
    // here rather than as an intermittent disconnection nobody can
    // reproduce.
    const conf = readFileSync(path.join(ROOT, 'infra/nginx/web.conf'), 'utf8');
    const socketBlock = conf.slice(conf.indexOf('location /api/v1/ws'));
    const readTimeout = /proxy_read_timeout\s+(\d+)s/.exec(socketBlock);
    expect(readTimeout, 'the socket location sets no proxy_read_timeout').not.toBeNull();

    const config = readFileSync(path.join(ROOT, 'apps/api/src/config.ts'), 'utf8');
    const pingMs = /pingMs:\s*([\d_]+)/.exec(config);
    expect(pingMs, 'config.ts declares no ws ping interval').not.toBeNull();

    const proxySeconds = Number(readTimeout![1]);
    const pingSeconds = Number(pingMs![1].replace(/_/g, '')) / 1000;
    expect(proxySeconds).toBeGreaterThan(pingSeconds * 2);
    // …and the sanity check that these regexes read real numbers rather than
    // matching nothing and comparing NaN, which would pass every comparison
    // it was asked to make.
    expect(proxySeconds).toBeGreaterThan(0);
    expect(pingSeconds).toBeGreaterThan(0);
  });

  it('sets the upgrade headers on the socket location ONLY', () => {
    // Adding `Upgrade` to the whole /api/ block would set it on every
    // ordinary request, where `$http_upgrade` is empty and the resulting
    // `Connection: ""` has bitten enough deployments to be folklore.
    const conf = readFileSync(path.join(ROOT, 'infra/nginx/web.conf'), 'utf8');
    const socketAt = conf.indexOf('location /api/v1/ws');
    const apiAt = conf.indexOf('location /api/ ');
    expect(socketAt).toBeGreaterThan(-1);
    expect(apiAt).toBeGreaterThan(-1);
    const socketBlock = conf.slice(socketAt);
    const apiBlock = conf.slice(apiAt, socketAt > apiAt ? socketAt : conf.length);
    expect(socketBlock).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(apiBlock).not.toContain('proxy_set_header Upgrade');
    // The map is at file scope, where `map` is legal — inside `server` nginx
    // refuses to start, which is a loud failure but one nobody discovers
    // until a deployment.
    expect(conf.indexOf('map $http_upgrade $connection_upgrade'))
      .toBeLessThan(conf.indexOf('server {'));
  });
});
