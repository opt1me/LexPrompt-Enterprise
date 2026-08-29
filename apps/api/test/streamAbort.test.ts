import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { buildServer } from '../src/server.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/config.ts';
import type { GatewayClient } from '../src/gatewayClient.ts';
import type { Principal } from '../src/oidc.ts';

/**
 * M1: the stream route's abort listener was attached to the WRONG emitter,
 * and no test could see it.
 *
 * `request.raw` is already destroyed by the time the handler runs — Fastify's
 * content-type parser has read the body to completion and Node's autoDestroy
 * has emitted `'close'` — so `request.raw.on('close', …)` waits for an event
 * that already fired. `signal.aborted` stayed false through a real
 * mid-stream disconnect, while the comment above it promised the abort
 * propagated all the way to the provider.
 *
 * `app.inject` cannot catch this: light-my-request never opens a socket, so
 * every case in `inferStream.pipe.test.ts` passes identically with the
 * listener present, absent, or pointed at the wrong emitter. This file
 * therefore uses a REAL server on a real port and a real client that hangs
 * up mid-stream. That is the only shape in which the bug is visible.
 */

const PRINCIPAL: Principal = { issuer: 'iss', subject: 'sub-1', groups: [] };

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) await new Promise<void>(r => s.close(() => r()));
  servers = [];
});

/**
 * A gateway fake that yields chunks slowly and records what its
 * `AbortSignal` did — which is the fact under test, since the signal is what
 * `apps/api` hands to undici and therefore what releases the upstream socket.
 */
function slowGateway(seen: { aborted: boolean; delivered: number }): GatewayClient {
  return {
    async infer() { return { status: 200, json: {} }; },
    async models() { return { status: 200, json: { models: [] } }; },
    async stream(_body: unknown, signal: AbortSignal) {
      signal.addEventListener('abort', () => { seen.aborted = true; });
      async function* bytes(): AsyncGenerator<Buffer> {
        for (let i = 0; i < 40; i++) {
          if (signal.aborted) return;
          seen.delivered += 1;
          yield Buffer.from(`data: {"type":"delta","text":"${i}"}\n\n`, 'utf8');
          await new Promise(r => setTimeout(r, 15));
        }
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: bytes(),
        text: async () => '',
      };
    },
  } as GatewayClient;
}

async function listen(gateway: GatewayClient): Promise<number> {
  const app = buildServer({
    verify: async () => PRINCIPAL,
    gateway,
    workspaceId: 'ws-configured',
    maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const server = app.server;
  servers.push(server);
  return (server.address() as { port: number }).port;
}

describe('a client that goes away aborts this hop (M1)', () => {
  it('aborts the gateway call when the browser hangs up mid-stream', async () => {
    const seen = { aborted: false, delivered: 0 };
    const port = await listen(slowGateway(seen));

    await new Promise<void>((resolve, reject) => {
      const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/infer/stream',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      }, res => {
        // Read exactly one chunk, then hang up — a reviewer navigating away
        // from a long answer.
        res.once('data', () => {
          req.destroy();
          resolve();
        });
        res.on('error', () => {});
      });
      req.on('error', () => {});
      req.end(JSON.stringify({ modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi' }));
      setTimeout(() => reject(new Error('no chunk arrived')), 5000);
    });

    // Give the server's own 'close' a turn.
    const deadline = Date.now() + 3000;
    while (!seen.aborted && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 20));
    }

    expect(seen.aborted, 'the gateway call was never aborted').toBe(true);
    // …and the route stopped pulling. Without this, "aborted" could be true
    // while the loop drained all forty chunks into a dead socket anyway,
    // which is the waste the abort exists to prevent.
    expect(seen.delivered).toBeLessThan(40);
  });

  it('does NOT abort a stream that ran to completion', async () => {
    // The other half: `'close'` fires on a normal end too, so an unguarded
    // listener would report an abort on every successful answer and make the
    // test above meaningless.
    const seen = { aborted: false, delivered: 0 };
    const gateway: GatewayClient = {
      async infer() { return { status: 200, json: {} }; },
      async models() { return { status: 200, json: { models: [] } }; },
      async stream(_body: unknown, signal: AbortSignal) {
        signal.addEventListener('abort', () => { seen.aborted = true; });
        async function* bytes(): AsyncGenerator<Buffer> {
          seen.delivered += 1;
          yield Buffer.from('data: {"type":"done","callId":"c1"}\n\n', 'utf8');
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: bytes(),
          text: async () => '',
        };
      },
    } as GatewayClient;
    const port = await listen(gateway);

    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request({
        port, host: '127.0.0.1', method: 'POST', path: '/v1/infer/stream',
        headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', c => { text += c; });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end(JSON.stringify({ modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi' }));
      setTimeout(() => reject(new Error('stream never ended')), 5000);
    });

    expect(body).toBe('data: {"type":"done","callId":"c1"}\n\n');
    await new Promise(r => setTimeout(r, 50));
    expect(seen.aborted, 'a completed stream must not report an abort').toBe(false);
  });
});
