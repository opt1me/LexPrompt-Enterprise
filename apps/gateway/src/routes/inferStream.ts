import { ModelError, createSseEventReader, encodeFrame, type InferUsage } from '@lexprompt/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { prepare, toModelError, type CallContext } from '../callModel.ts';
import { sendModelError, type InferBody } from './infer.ts';

/**
 * `POST /v1/infer/stream` — the gateway's outward stream.
 *
 * Everything up to and including credential resolution, the audit-start
 * write and the jurisdiction check happens once, inside `prepare` (Task
 * 11), shared with the non-streamed `/v1/infer`. This route's entire job is
 * the four rules at the streaming boundary itself:
 *
 *  1. A `done` frame is written in exactly ONE place, below, and only
 *     because the provider said the stream was complete (`ev.kind ===
 *     'end'`). Never in a `finally` — a `finally` cannot distinguish "the
 *     provider finished" from "the socket dropped", and turning the second
 *     into the first is this project's founding defect wearing a network
 *     cable.
 *  2. A stream that ends without an `end` event emits an `error` frame
 *     carrying `stream_truncated`, so `readFrames` (packages/core) throws
 *     rather than handing back a half-answer that renders as a whole one.
 *  3. An `error` event from the adapter, or a non-2xx before the stream
 *     opens, emits an `error` frame (or an HTTP status, pre-stream) and
 *     stops.
 *  4. Usage is max-merged across every `usage` event: Anthropic reports
 *     input tokens in `message_start` and output tokens in `message_delta`,
 *     each leaving the other field at zero, while the OpenAI-shaped
 *     providers report both in one chunk. Max is correct for both, which is
 *     why there is no `if (provider === ...)` anywhere in this file — every
 *     provider difference lives in its adapter's `decodeEvent`.
 */
export function registerInferStream(
  app: FastifyInstance,
  makeContext: (req: FastifyRequest) => CallContext,
): void {
  app.post('/v1/infer/stream', async (request, reply) => {
    const ctx = makeContext(request);
    const body = request.body as InferBody;

    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
      prepared = await prepare(ctx, body as never, true);
    } catch (err) {
      // Nothing has been sent yet, so a failure here is an HTTP status —
      // never a 200 carrying an error frame, which would make a refusal
      // indistinguishable from a mid-stream fault to any proxy in between.
      return sendModelError(reply, err);
    }
    const { entry, adapter, call, credential, callId, startedAt } = prepared;

    const timeout = AbortSignal.timeout(ctx.config.requestTimeoutMs);
    let response;
    try {
      response = await ctx.transport.fetch(call.url, {
        method: 'POST', headers: call.headers,
        body: JSON.stringify(call.body), signal: timeout,
      });
    } catch (err) {
      await ctx.audit.finish(callId, {
        status: 0, ok: false, errorCode: 'network',
        promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - startedAt, retries: 0,
      });
      return sendModelError(reply, new ModelError(
        `Could not reach the AI provider: ${(err as Error).message}`, 'network', 0, callId));
    }

    // A stream is deliberately NOT retried: a half-delivered stream cannot
    // be resumed from the middle, and the caller can simply ask again.
    // `callModel.ts` made the same choice for the same reason.
    if (!response.ok) {
      const err = await toModelError(response, credential, callId);
      await ctx.audit.finish(callId, {
        status: response.status, ok: false, errorCode: err.code,
        promptTokens: 0, completionTokens: 0, latencyMs: Date.now() - startedAt, retries: 0,
      });
      return sendModelError(reply, err);
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // no-transform matters: a proxy that rebuffers or recompresses an SSE
      // body is how a stream stops arriving event by event.
      //
      // Sent for EVERY provider, not only `recorded` — see infer.ts's
      // identical header for why an absence must never be the signal.
      'X-LexPrompt-Provider': entry.provider,
    });

    const reader = createSseEventReader();
    const decoder = new TextDecoder();
    const usage: InferUsage = { promptTokens: 0, completionTokens: 0 };
    let ended = false;
    let failure: { status: number; message: string } | null = null;

    const handle = (raw: string): void => {
      if (ended || failure) return;
      const ev = adapter.decodeEvent(raw);
      if (!ev) return;
      if (ev.kind === 'delta') {
        reply.raw.write(encodeFrame({ type: 'delta', text: ev.text }));
      } else if (ev.kind === 'usage') {
        // Max-merge, not replace: Anthropic reports input tokens in
        // message_start and output tokens in message_delta, each leaving
        // the other at zero. The OpenAI-shaped providers send one complete
        // chunk. Max is right for both, which is why there is no provider
        // branch here.
        usage.promptTokens = Math.max(usage.promptTokens, ev.usage.promptTokens);
        usage.completionTokens = Math.max(usage.completionTokens, ev.usage.completionTokens);
      } else if (ev.kind === 'end') {
        ended = true;
      } else {
        failure = { status: ev.status, message: ev.message };
      }
    };

    try {
      for await (const chunk of response.body ?? []) {
        for (const raw of reader.push(decoder.decode(chunk, { stream: true }))) handle(raw);
        if (failure) break;
      }
      const tail = decoder.decode();
      if (tail) for (const raw of reader.push(tail)) handle(raw);
      for (const raw of reader.flush()) handle(raw);
    } catch (err) {
      failure = { status: 502, message: `The stream failed: ${(err as Error).message}` };
    }

    if (failure) {
      reply.raw.write(encodeFrame({
        type: 'error', code: 'upstream_failed',
        status: failure.status, message: failure.message, callId,
      }));
    } else if (ended) {
      // The ONLY place a done frame is written, and it is written only
      // because the provider said the stream was complete. Never in a
      // finally — a finally would emit done on a dropped socket, which is
      // exactly the truncated-but-apparently-successful answer this project
      // exists to prevent.
      reply.raw.write(encodeFrame({ type: 'done', usage, callId }));
    } else {
      reply.raw.write(encodeFrame({
        type: 'error', code: 'stream_truncated', status: 0, callId,
        message: 'The answer stopped before it finished. What arrived is incomplete — ask again.',
      }));
    }
    reply.raw.end();

    const ok = !failure && ended;
    await ctx.audit.finish(callId, {
      status: 200,
      ok,
      ...(failure ? { errorCode: 'upstream_failed' as const }
        : ended ? {} : { errorCode: 'stream_truncated' as const }),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      latencyMs: Date.now() - startedAt,
      retries: 0,
    });
    // Recorded only on a call that actually completed — matching
    // `callModel.ts`'s non-streamed path, which calls `limiter.record` only
    // from its success branch. `RateLimiter.record`'s own contract is "after
    // a successful call, with what it actually cost"; a truncated or
    // errored stream did not complete, so nothing is recorded for it here,
    // for the same reason a failed non-streamed call never reaches its
    // `limiter.record` call either.
    if (ok) {
      ctx.limiter.record(ctx.workspaceId, ctx.actorSubject, usage);
    }
  });
}
