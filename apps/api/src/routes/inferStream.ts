import { SERVICE_CONFIG_HINT } from '@lexprompt/core';
import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Principal } from '../oidc.ts';
import { withActor } from '../actorBody.ts';

/**
 * P1's middle hop, and its entire specification is: parse nothing.
 *
 * This project has already shipped an SSE parser that dropped the last
 * token of every answer and returned nothing on CRLF servers. Three hops
 * would be three chances to reproduce it. There are two parsers in this
 * system — the gateway's, over a provider's stream, and the browser's, over
 * the gateway's — and they are the same function from packages/core. This
 * service copies bytes, so it cannot be the one that is wrong.
 *
 * A structural test (`inferStream.pipe.test.ts`) asserts this service
 * imports no parser or frame codec at all, from any file under `src/`, so
 * the next person cannot helpfully add one here.
 */
export function registerInferStream(
  app: FastifyInstance, gateway: GatewayClient, workspaceId: string,
): void {
  app.post('/v1/infer/stream', async (request, reply) => {
    const principal = request.principal as Principal;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Same actor overwrite as `/v1/infer` (Task 17), reused via
    // `actorBody.ts` rather than rebuilt here: a streaming call is no less
    // an audit record than a non-streamed one, and two copies of this
    // overwrite would be two places only one of which could later be fixed.
    const body = withActor(client, workspaceId, principal);

    const controller = new AbortController();
    // A client that goes away must not leave a provider call running: the
    // abort propagates api -> gateway -> provider.
    request.raw.on('close', () => controller.abort());

    let upstream;
    try {
      upstream = await gateway.stream(body, controller.signal);
    } catch (err) {
      return reply.code(503).send({ error: { code: 'service_misconfigured',
        message: 'LexPrompt could not reach the firm\'s AI service. This is a configuration '
          + `problem in the deployment, ${SERVICE_CONFIG_HINT}. `
          + `(${(err as Error).message})` } });
    }

    if (upstream.status !== 200) {
      // Not a stream: pass the status and the body through as they arrived,
      // unread and unparsed.
      const text = await upstream.text();
      reply.raw.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      reply.raw.end(text);
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': upstream.headers['content-type'] ?? 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    // Bytes in, bytes out. Nothing is decoded, re-encoded or normalised —
    // that is the whole of this route's job. See the module docstring.
    for await (const chunk of upstream.body ?? []) {
      reply.raw.write(chunk);
    }
    reply.raw.end();
  });
}
