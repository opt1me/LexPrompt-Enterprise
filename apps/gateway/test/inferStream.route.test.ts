import { describe, it, expect } from 'vitest';
import { buildTestServer, fakeStream } from './helpers/streamHarness.ts';
import {
  createSseEventReader, decodeFrame, SERVICE_CONFIG_HINT,
  type Frame, type Jurisdiction,
} from '@lexprompt/core';
import type { RateLimiter } from '../src/rateLimit.ts';

/** A limiter that never refuses, but remembers every `record` call — so a
 *  test can assert WHETHER usage was billed, not just what it would have
 *  billed. Task 12 fixed a defect where `inferStream.ts` called
 *  `limiter.record` unconditionally, including on a truncated or errored
 *  stream; that bug was invisible under `unlimitedRateLimiter` because it
 *  counts nothing. This pins the guard so it stays caught once a real
 *  limiter is wired in (Task 14). */
function spyLimiter(): RateLimiter & { calls: unknown[][]; attempts: unknown[][] } {
  const calls: unknown[][] = [];
  const attempts: unknown[][] = [];
  return {
    calls,
    attempts,
    check() { /* never refuses */ },
    recordAttempt(...args) { attempts.push(args); },
    record(...args) { calls.push(args); },
  };
}

function framesOf(body: string): Frame[] {
  const r = createSseEventReader();
  const out: Frame[] = [];
  for (const raw of [...r.push(body), ...r.flush()]) {
    const f = decodeFrame(raw);
    if (f) out.push(f);
  }
  return out;
}

/** The `done` frame now carries where the call was processed, taken from
 *  the allowlist entry the gateway actually resolved — never from the
 *  request. The two entries this harness defines differ in both fields, so
 *  a route that hard-coded either would fail one of the two cases below. */
const UK_SOUTH: Jurisdiction = { bloc: 'UK', region: 'uksouth', label: 'UK South' };
const US: Jurisdiction = { bloc: 'US', region: 'us', label: 'US' };

const OPENAI_OK =
  'data: {"choices":[{"delta":{"content":"one"}}]}\n\n'
  + 'data: {"choices":[{"delta":{"content":" two"}}]}\n\n'
  + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n'
  + 'data: [DONE]\n\n';

describe('POST /v1/infer/stream', () => {
  it('emits one delta frame per delta and exactly one done frame, carrying usage', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(framesOf(res.body)).toEqual([
      { type: 'delta', text: 'one' },
      { type: 'delta', text: ' two' },
      {
        type: 'done', usage: { promptTokens: 9, completionTokens: 2 }, callId: 'call-1',
        provider: 'azure-foundry', jurisdiction: UK_SOUTH,
        // This fixture sends no `finish_reason`, so the frame says so
        // rather than claiming the model chose to end.
        stopReason: 'unknown',
      },
    ]);
    await app.close();
  });

  // P2 at the upstream edge. THE rule of this task.
  it('emits an ERROR frame, not a done frame, when the provider stream stops early', async () => {
    const app = buildTestServer({
      stream: fakeStream(200, 'data: {"choices":[{"delta":{"content":"half an ans"}}]}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const frames = framesOf(res.body);
    expect(frames[0]).toEqual({ type: 'delta', text: 'half an ans' });
    expect(frames[1]).toMatchObject({ type: 'error', code: 'stream_truncated' });
    expect(frames.some(f => f.type === 'done')).toBe(false);
    await app.close();
  });

  it('emits an error frame when the provider errors mid-stream', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
        + 'data: {"error":{"message":"upstream exploded","code":500}}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    // A 5xx mid-stream is still `upstream_failed`, and the provider's own
    // words still reach the caller — what changed is that they now arrive
    // through `modelErrorFor`, redacted, rather than verbatim.
    expect(framesOf(res.body)[1]).toMatchObject({
      type: 'error', code: 'upstream_failed', status: 502,
    });
    expect((framesOf(res.body)[1] as { message: string }).message).toContain('upstream exploded');
    await app.close();
  });

  // ==================================================================
  // M1. This test used to assert `message: 'upstream exploded'` — i.e. it
  // PINNED the unredacted passthrough as the expected behaviour, which is
  // how the defect survived review. `ev.message` is whatever the provider
  // put in its mid-stream error object, and OpenRouter in particular relays
  // upstream error bodies verbatim, keys included. Every sibling path
  // redacts (`toModelError`, `asModelError`, the network-failure message,
  // the unreadable-200 message); this one did not, and it is the path whose
  // text travels furthest — all the way to a browser on a user's machine.
  //
  // `resolve.ts` states the rule as "no credential leaves it", not "no
  // credential leaves it on the non-streamed path".
  // ==================================================================
  it('never lets a mid-stream provider error carry the credential outwards', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
        + 'data: {"error":{"message":"Incorrect API key provided: test-bearer-token",'
        + '"code":500}}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    // The whole response body, not just the decoded frame: a credential
    // anywhere in the bytes that leave this process is the failure.
    expect(res.body).not.toContain('test-bearer-token');
    expect(res.body).toContain('[redacted]');
    await app.close();
  });

  // ==================================================================
  // M2. `code: 'upstream_failed'` was a literal here, regardless of status.
  // The non-streamed path routes every provider failure through
  // `toModelError`, which maps 401/402/403 to `service_misconfigured`; the
  // streamed path bypassed that mapping entirely. On the browser,
  // `isServiceConfigError` reads `code` and not `status`, so a rejected
  // FIRM credential arriving mid-stream reached a lawyer as a generic
  // retryable "the AI provider failed" — invited to try again, for
  // something no retry can ever fix, while the identical failure on
  // `/v1/infer` correctly named it a deployment configuration problem.
  // ==================================================================
  it('classifies a mid-stream 401 as service_misconfigured, exactly as /v1/infer does', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"a"}}]}\n\n'
        + 'event: error\ndata: {"type":"error","error":{"type":"authentication_error",'
        + '"message":"invalid x-api-key"}}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'claude', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const frame = framesOf(res.body).find(f => f.type === 'error');
    expect(frame).toMatchObject({ type: 'error', code: 'service_misconfigured', status: 503 });
    // And it carries the sentence the browser classifies on, because a
    // finding preserves only free text.
    expect((frame as { message: string }).message).toContain(SERVICE_CONFIG_HINT);
    // m7: the audit record keeps the PROVIDER's status, not a flat 200.
    expect(app.auditSink.records.find(r => r.kind === 'call.finished'))
      .toMatchObject({ status: 401, ok: false, errorCode: 'service_misconfigured' });
    await app.close();
  });

  // ==================================================================
  // C1, at the route. The model hit the token ceiling and the provider said
  // so; what streamed is a fragment ending mid-sentence. It must NOT wear a
  // done frame — that is the same rule the truncated-socket case above
  // enforces, for the far likelier cause.
  // ==================================================================
  it('emits an ERROR frame, not a done frame, when the MODEL stopped at its token ceiling', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"1. Repairs to the structure"}}]}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
        + 'data: [DONE]\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const frames = framesOf(res.body);
    expect(frames[0]).toEqual({ type: 'delta', text: '1. Repairs to the structure' });
    expect(frames[1]).toMatchObject({ type: 'error', code: 'answer_truncated' });
    expect(frames.some(f => f.type === 'done')).toBe(false);
    // The provider DID send `[DONE]`, so `ended` was true — which is
    // exactly why this could not be caught by the stream_truncated guard.
    expect(app.auditSink.records.find(r => r.kind === 'call.finished'))
      .toMatchObject({ ok: false, errorCode: 'answer_truncated' });
    await app.close();
  });

  it('does the same for Anthropic, which spells the ceiling max_tokens', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":0}}}\n\n'
        + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"1. Repairs"}}\n\n'
        + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'claude', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const frames = framesOf(res.body);
    expect(frames.some(f => f.type === 'done')).toBe(false);
    expect(frames.find(f => f.type === 'error')).toMatchObject({ code: 'answer_truncated' });
    await app.close();
  });

  it('does NOT bill a truncated answer to the token budget', async () => {
    const limiter = spyLimiter();
    const app = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"half"}}]}\n\n'
        + 'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4096}}\n\n'
        + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'
        + 'data: [DONE]\n\n'),
      limiter,
    });
    await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(limiter.calls).toEqual([]);
    await app.close();
  });

  it('answers a pre-stream failure with an HTTP status, not a 200 carrying an error frame', async () => {
    const app = buildTestServer({ stream: fakeStream(401, '{"error":{"message":"bad key"}}') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
    await app.close();
  });

  it('refuses an unallowlisted model with 400 and never opens a stream', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'gpt-5', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
    await app.close();
  });

  // Anthropic's two-event usage, through the same route with no branch.
  it('max-merges usage across events, so Anthropic\'s split usage arrives whole', async () => {
    const app = buildTestServer({
      stream: fakeStream(200,
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":16,"output_tokens":0}}}\n\n'
        + 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
        + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'claude', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const done = framesOf(res.body).find(f => f.type === 'done');
    expect(done).toEqual({
      type: 'done', usage: { promptTokens: 16, completionTokens: 5 }, callId: 'call-1',
      provider: 'anthropic', jurisdiction: US, stopReason: 'stop',
    });
    await app.close();
  });

  it('records call.finished with the streamed usage', async () => {
    const app = buildTestServer({ stream: fakeStream(200, OPENAI_OK) });
    await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const finished = app.auditSink.records.find(r => r.kind === 'call.finished');
    expect(finished).toMatchObject({ ok: true, promptTokens: 9, completionTokens: 2 });
    await app.close();
  });

  it('records call.finished with ok:false and stream_truncated on a cut stream', async () => {
    const app = buildTestServer({ stream: fakeStream(200, 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n') });
    await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(app.auditSink.records.find(r => r.kind === 'call.finished'))
      .toMatchObject({ ok: false, errorCode: 'stream_truncated' });
    await app.close();
  });

  // Pins the fix Task 12 made and Task 14's brief warned against
  // reintroducing: `limiter.record` must run only on a stream that actually
  // completed — never on one that was truncated or errored — because
  // `RateLimiter.record`'s contract is "after a successful call, with what
  // it actually cost." Billing a truncated answer is exactly the silent
  // wrong-answer class CLAUDE.md's "fail loudly" rule exists to prevent,
  // once a limiter enforces anything real.
  it('records usage on a completed stream but never on a truncated or errored one', async () => {
    const okLimiter = spyLimiter();
    const okApp = buildTestServer({ stream: fakeStream(200, OPENAI_OK), limiter: okLimiter });
    await okApp.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(okLimiter.calls).toEqual([
      ['ws', 'sub', { promptTokens: 9, completionTokens: 2 }],
    ]);
    await okApp.close();

    const truncatedLimiter = spyLimiter();
    const truncatedApp = buildTestServer({
      stream: fakeStream(200, 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'),
      limiter: truncatedLimiter,
    });
    await truncatedApp.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(truncatedLimiter.calls).toEqual([]);
    await truncatedApp.close();

    const erroredLimiter = spyLimiter();
    const erroredApp = buildTestServer({
      stream: fakeStream(200,
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n'
        + 'data: {"error":{"message":"boom"}}\n\n'),
      limiter: erroredLimiter,
    });
    await erroredApp.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'uks-gpt4o', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    expect(erroredLimiter.calls).toEqual([]);
    await erroredApp.close();
  });
});
