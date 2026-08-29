import type { FastifyInstance } from 'fastify';
import type { GatewayClient } from '../gatewayClient.ts';
import type { Actor } from '../auth/actor.ts';
import { withActor } from '../actorBody.ts';
import { callerAuthRefusal, unreachableGateway } from '../gatewayFailure.ts';

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
    const actor = request.actor as Actor;
    const client = (request.body ?? {}) as Record<string, unknown>;

    // Same actor overwrite as `/v1/infer` (Task 17), reused via
    // `actorBody.ts` rather than rebuilt here: a streaming call is no less
    // an audit record than a non-streamed one, and two copies of this
    // overwrite would be two places only one of which could later be fixed.
    const body = withActor(client, workspaceId, actor);

    const controller = new AbortController();
    // A client that goes away must not leave this hop draining a body
    // nobody will read.
    //
    // `reply.raw`, NOT `request.raw`, and the difference was the whole of
    // the bug (M1). By the time this handler runs, Fastify's content-type
    // parser has already read the request body to completion and Node's
    // autoDestroy has already emitted `'close'` on the IncomingMessage — so
    // a listener attached here waits for an event that has already fired,
    // and `signal.aborted` stayed false through a real mid-stream
    // disconnect. Verified by execution against the pinned Fastify: with a
    // client that reads one chunk and aborts, `request.raw` never fires and
    // `reply.raw` does.
    //
    // What this DOES buy is bounded, and the comment that used to sit here
    // claimed more: it aborts THIS hop's request to the gateway, so the
    // socket is released and this process stops copying bytes into a dead
    // one. It does NOT reach the provider. `apps/gateway`'s own stream route
    // holds no request-close listener — its only signal is
    // `AbortSignal.timeout(requestTimeoutMs)` — so the provider call runs on
    // and is billed. That second hop is the gateway lane's to add; saying
    // "the abort propagates api -> gateway -> provider" while neither hop
    // did it is what made a dead guard read as a working one.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });

    let upstream;
    try {
      upstream = await gateway.stream(body, controller.signal);
    } catch (err) {
      const failure = unreachableGateway(err, 'streamed inference');
      return reply.code(failure.status)
        .send({ error: { code: failure.code, message: failure.message } });
    }

    // A gateway 401 is about THIS service's credentials, never about the
    // user's session — the same substitution `/v1/infer` makes, for the same
    // reason. See `gatewayFailure.ts`.
    const refusal = callerAuthRefusal(upstream.status);
    if (refusal) {
      return reply.code(refusal.status)
        .send({ error: { code: refusal.code, message: refusal.message } });
    }

    if (upstream.status !== 200) {
      // Not a stream: pass the status and the body through as they arrived,
      // unread and unparsed — and pass the CONTENT-TYPE through with them
      // rather than asserting `application/json` over whatever arrived
      // (m14). Labelling a body is a claim about it, and this route's whole
      // discipline is that it makes no claims about bodies it did not read.
      const text = await upstream.text();
      // `||`, not `??`: an EMPTY content-type is as absent as a missing one,
      // and `??` would have forwarded the empty string as a label.
      reply.raw.writeHead(upstream.status, {
        'Content-Type': upstream.headers['content-type'] || 'application/json',
      });
      reply.raw.end(text);
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': upstream.headers['content-type'] || 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    // Bytes in, bytes out. Nothing is decoded, re-encoded or normalised —
    // that is the whole of this route's job. See the module docstring.
    //
    // The `finally` is not decoration (m9). A mid-stream gateway or provider
    // failure throws out of `for await`, and this route used to call
    // `reply.raw.end()` only on the success path — the response was then
    // ended by Fastify's reject path, whose `headersSent` guards happen to
    // stop it rewriting the head, and the browser's `readFrames` happened to
    // read the missing `done` frame as `stream_truncated`. The outcome was
    // right by two layers of accident. Ending the response here makes the
    // truncation this hop's own statement: whatever happened upstream, the
    // client gets exactly the bytes that arrived and no `done` frame, which
    // is precisely what `stream_truncated` means.
    try {
      for await (const chunk of upstream.body ?? []) {
        reply.raw.write(chunk);
      }
    } catch (err) {
      // Not rethrown, and that is the point rather than a shortcut: the head
      // is already on the wire, so there is no envelope left to answer in,
      // and handing this to the error handler would only produce a Fastify
      // warning about a reply it cannot write. The failure is not swallowed
      // — it goes to stderr, where an operator reads it, and the client is
      // told by the absence of a `done` frame, which is the only channel a
      // half-written stream has.
      process.stderr.write(
        `api: streamed inference failed mid-body: ${(err as Error).message}\n`,
      );
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
