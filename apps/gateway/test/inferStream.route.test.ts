import { describe, it, expect } from 'vitest';
import { buildTestServer, fakeStream } from './helpers/streamHarness.ts';
import { createSseEventReader, decodeFrame, type Frame } from '@lexprompt/core';

function framesOf(body: string): Frame[] {
  const r = createSseEventReader();
  const out: Frame[] = [];
  for (const raw of [...r.push(body), ...r.flush()]) {
    const f = decodeFrame(raw);
    if (f) out.push(f);
  }
  return out;
}

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
      { type: 'done', usage: { promptTokens: 9, completionTokens: 2 }, callId: 'call-1' },
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
    expect(framesOf(res.body)[1]).toMatchObject({
      type: 'error', code: 'upstream_failed', message: 'upstream exploded',
    });
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
        + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer/stream',
      payload: { modelChoiceId: 'claude', purpose: 'assistant.chat', user: 'hi',
                 workspaceId: 'ws', actorIssuer: 'iss', actorSubject: 'sub' } });
    const done = framesOf(res.body).find(f => f.type === 'done');
    expect(done).toEqual({ type: 'done', usage: { promptTokens: 16, completionTokens: 5 }, callId: 'call-1' });
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
});
