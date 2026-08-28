import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildTestApi } from './helpers/apiHarness.ts';

const BODY =
  'data: {"type":"delta","text":"one"}\n\n'
  + 'data: {"type":"delta","text":" two"}\n\n'
  + 'data: {"type":"done","usage":{"promptTokens":9,"completionTokens":2},"callId":"c1"}\n\n';

const post = (app: ReturnType<typeof buildTestApi>['app']) => app.inject({
  method: 'POST', url: '/v1/infer/stream', headers: { authorization: 'Bearer t' },
  payload: { modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi' },
});

describe('POST /v1/infer/stream — a byte pipe (P1)', () => {
  it('returns exactly the bytes the gateway sent', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [BODY] });
    expect((await post(app)).body).toBe(BODY);
  });

  it('returns exactly the bytes when they arrive in three uneven chunks', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] },
      streamChunks: [BODY.slice(0, 17), BODY.slice(17, 61), BODY.slice(61)] });
    expect((await post(app)).body).toBe(BODY);
  });

  it('returns exactly the bytes when they arrive one byte at a time', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [...BODY] });
    expect((await post(app)).body).toBe(BODY);
  });

  // A re-framer normalises CRLF. A pipe does not, and must not: the browser
  // parser handles CRLF, and something in the middle "helping" is how a
  // proxy becomes a participant in a bug nobody can locate.
  it('preserves CRLF separators byte for byte rather than normalising them', async () => {
    const crlf = BODY.replace(/\n/g, '\r\n');
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [crlf] });
    expect((await post(app)).body).toBe(crlf);
  });

  it('preserves a stream that ends with no trailing blank line', async () => {
    const cut = BODY.replace(/\n\n$/, '');
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [cut] });
    expect((await post(app)).body).toBe(cut);
  });

  it('preserves a truncated stream unchanged, so the browser sees the truncation', async () => {
    const truncated = 'data: {"type":"delta","text":"half"}\n\n';
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [truncated] });
    expect((await post(app)).body).toBe(truncated);
  });

  it('passes the gateway\'s content-type through', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] }, streamChunks: [BODY] });
    expect((await post(app)).headers['content-type']).toContain('text/event-stream');
  });

  it('answers a pre-stream failure with the gateway\'s status and body', async () => {
    const { app } = buildTestApi({ principal: { issuer: 'iss', subject: 'o', groups: [] },
      streamStatus: 400, streamChunks: ['{"error":{"code":"model_not_allowed","message":"no"}}'] });
    const res = await post(app);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('sets the actor from the token here too, and overwrites a supplied one', async () => {
    const principal = { issuer: 'http://keycloak:8080/realms/lexprompt', subject: 'sub-real', groups: [] };
    const { app, calls } = buildTestApi({ principal, streamChunks: [BODY] });
    await app.inject({ method: 'POST', url: '/v1/infer/stream', headers: { authorization: 'Bearer t' },
      payload: { modelChoiceId: 'm', purpose: 'assistant.chat', user: 'hi',
                 actorSubject: 'sub-someone-else' } });
    expect(calls.stream[0].actorSubject).toBe('sub-real');
    expect(calls.stream[0].actorIssuer).toBe('http://keycloak:8080/realms/lexprompt');
  });
});

// The structural half of P1: no parser may exist in this service at all.
describe('apps/api parses nothing', () => {
  const SRC = path.resolve(__dirname, '../src');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, out); else if (full.endsWith('.ts')) out.push(full);
    }
    return out;
  };

  it('imports no SSE parser or frame codec from @lexprompt/core', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const name of ['createSseEventReader', 'decodeFrame', 'encodeFrame', 'sseFields', 'readFrames']) {
        if (text.includes(name)) offenders.push(`${path.basename(file)} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
