import {
  ModelError, createSseEventReader, encodeFrame, truncationRefusal,
  type InferUsage, type StopReason,
} from '@lexprompt/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { modelErrorFor, prepare, toModelError, type CallContext } from '../callModel.ts';
import { redactCredential } from '../credentials/resolve.ts';
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
 *  5. A stream the MODEL stopped at its token ceiling gets an `error`
 *     frame, not a `done` frame. Rule 1 keeps a dropped socket from wearing
 *     a `done`; this is the same rule for the far likelier case, where the
 *     socket was fine and the ANSWER is what stopped. The decision lives in
 *     `truncationRefusal` (packages/core), shared with `/v1/infer` and with
 *     the browser's own `readFrames`.
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
    // `unknown` until a provider says otherwise — deliberately not `stop`.
    // A relay that sends no reason has told us nothing, and recording
    // silence as "the model finished" is the shape of failure this whole
    // file is written against.
    let stopReason: StopReason = 'unknown';
    let failure: { status: number; message: string } | null = null;

    const handle = (raw: string): void => {
      if (ended || failure) return;
      // Zero or more events per raw event: an OpenAI-shaped chunk may carry
      // the last content delta AND `finish_reason` together, and neither
      // may be dropped in favour of the other.
      for (const ev of adapter.decodeEvent(raw)) {
        if (ended || failure) return;
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
        } else if (ev.kind === 'stop') {
          stopReason = ev.reason;
        } else if (ev.kind === 'end') {
          ended = true;
        } else {
          failure = { status: ev.status, message: ev.message };
        }
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

    // Classified exactly as a pre-stream failure is, through the same
    // ladder, and REDACTED for the same reason every sibling path redacts.
    //
    // What was here instead: `failure.message` written verbatim, and
    // `code: 'upstream_failed'` as a literal. The first put whatever the
    // provider chose to echo — OpenRouter relays upstream error bodies
    // mid-stream, keys included — into a frame that travels to a browser on
    // a user's machine, on the one path whose text crosses the trust
    // boundary furthest. The second flattened `anthropicErrorStatus`'s
    // careful 401 into a generic retryable provider failure, so a rejected
    // firm credential reached a lawyer as "try again" rather than "an
    // administrator has to fix this".
    const truncated = ended ? truncationRefusal(stopReason, callId) : null;
    const failed = failure
      ? modelErrorFor(failure.status, redactCredential(failure.message, credential), callId)
      : null;
    if (failed) {
      reply.raw.write(encodeFrame({
        type: 'error', code: failed.code, status: failed.status,
        message: failed.message, callId,
      }));
    } else if (truncated) {
      // Rule 5. The model stopped at its ceiling, so what streamed is a
      // fragment: an error frame, never a done frame. The deltas already
      // reached the browser — as they do on a `stream_truncated` too — and
      // `readFrames` throwing is what stops the caller from treating them
      // as an answer.
      reply.raw.write(encodeFrame({
        type: 'error', code: truncated.code, status: truncated.status,
        message: truncated.message, callId,
      }));
    } else if (ended) {
      // The ONLY place a done frame is written, and it is written only
      // because the provider said the stream was complete. Never in a
      // finally — a finally would emit done on a dropped socket, which is
      // exactly the truncated-but-apparently-successful answer this project
      // exists to prevent.
      // `provider` and `jurisdiction` ride the done frame for the same
      // reason `/v1/infer` returns them in its body: a streamed answer is
      // the same answer, and the browser must be able to SHOW where it was
      // processed rather than assume it. They come from the allowlist entry
      // that was actually resolved, never from the request.
      reply.raw.write(encodeFrame({
        type: 'done', usage, callId,
        provider: entry.provider, jurisdiction: entry.jurisdiction,
        // Required on the frame, so a producer cannot omit it and a
        // consumer never has to assume. `truncated` above has already
        // ruled out the one value that would mean this answer is a
        // fragment.
        stopReason,
      }));
    } else {
      reply.raw.write(encodeFrame({
        type: 'error', code: 'stream_truncated', status: 0, callId,
        message: 'The answer stopped before it finished. What arrived is incomplete — ask again.',
      }));
    }
    reply.raw.end();

    const ok = !failure && ended && !truncated;
    await ctx.audit.finish(callId, {
      // The provider's own status, not a flat 200. The stream opened with a
      // 200, but a mid-stream failure carries a 401 or a 529, and "what did
      // the provider actually say" is the first question a support engineer
      // asks about one — unanswerable from the record while every streamed
      // outcome was written as 200.
      status: failure ? failure.status : 200,
      ok,
      ...(failed ? { errorCode: failed.code }
        : truncated ? { errorCode: 'answer_truncated' as const }
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
