import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildTestApi } from './helpers/apiHarness.ts';
import { walk, codeOf } from './sourceScan.ts';

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

describe('what the stream route refuses, and what it forwards', () => {
  const P = { issuer: 'iss', subject: 'o', groups: [] };

  // M6, on the route that bypasses Fastify's reply machinery. A gateway 401
  // is about apps/api's OWN credentials — `callerAuth.ts` answers one in
  // five places — and forwarding it told a lawyer to sign in again over a
  // mismatch between two services' configuration.
  it('turns the gateway\'s caller-auth 401 into a 503, not a bare 401', async () => {
    const { app } = buildTestApi({ principal: P, streamStatus: 401,
      streamChunks: ['{"error":{"code":"not_permitted","message":"no"}}'] });
    const res = await post(app);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'service_misconfigured' } });
    expect(res.json().error.message).toMatch(/not the problem/i);
  });

  // m14: the body is passed through unread — so its LABEL must be passed
  // through too, rather than asserted. Labelling a body is a claim about it,
  // and this route's whole discipline is that it makes no claims about
  // bodies it did not read.
  it('forwards a pre-stream failure\'s content-type rather than stamping JSON on it', async () => {
    const { app } = buildTestApi({ principal: P, streamStatus: 502,
      streamContentType: 'text/html; charset=utf-8',
      streamChunks: ['<html>gateway down</html>'] });
    const res = await post(app);
    expect(res.statusCode).toBe(502);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe('<html>gateway down</html>');
  });

  it('still labels a pre-stream failure JSON when the gateway said nothing', async () => {
    const { app } = buildTestApi({ principal: P, streamStatus: 400,
      streamContentType: '', streamChunks: ['{"error":{"code":"model_not_allowed","message":"no"}}'] });
    const res = await post(app);
    expect(res.headers['content-type']).toContain('application/json');
  });

  // m9: the body loop had no `try`, and `reply.raw.end()` ran only on the
  // success path. The response was ended by Fastify's reject path instead,
  // whose `headersSent` guards happened to stop it rewriting the head — the
  // right outcome by two layers of accident rather than by anything this
  // route did.
  it('ends the response itself when the gateway stream fails mid-body', async () => {
    const { app } = buildTestApi({ principal: P,
      streamChunks: ['data: {"type":"delta","text":"half"}\n\n', 'never sent'],
      streamThrowsAfter: 1 });
    const res = await post(app);
    expect(res.statusCode).toBe(200);
    // Exactly the bytes that arrived, and NO `done` frame — which is what
    // the browser's `readFrames` reads as `stream_truncated`.
    expect(res.body).toBe('data: {"type":"delta","text":"half"}\n\n');
    expect(res.body).not.toContain('"done"');
  });

  it('ends the response even when the failure comes before any byte', async () => {
    const { app } = buildTestApi({ principal: P, streamChunks: ['x'], streamThrowsAfter: 0 });
    const res = await post(app);
    expect(res.body).toBe('');
  });
});

// The structural half of P1: no parser may exist in this service at all.
describe('apps/api parses nothing', () => {
  const SRC = path.resolve(__dirname, '../src');

  it('imports no SSE parser or frame codec from @lexprompt/core', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      // `codeOf`, not the raw text, and the difference is not cosmetic
      // (m10). This scan used to read the file as written, so a COMMENT
      // saying "this route must never call readFrames" failed the build —
      // and it failed it while `inferStream.ts` was being given exactly such
      // a comment, explaining why a mid-stream failure is left to surface as
      // a missing `done` frame. The two moves that pressure produces are
      // "relax the pattern" and "exempt the file", and both end with a guard
      // that no longer searches for the thing it names. `sourceScan.ts` says
      // all of this and this test was not using it.
      const code = codeOf(file);
      for (const name of ['createSseEventReader', 'decodeFrame', 'encodeFrame', 'sseFields', 'readFrames']) {
        if (code.includes(name)) offenders.push(`${path.basename(file)} references ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // A scan that matched nothing would pass vacuously, and this one now runs
  // over transformed text, so the transform is checked too.
  it('scans the real source files, comments stripped and code kept', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(4);
    const stream = files.find(f => f.endsWith('inferStream.ts'))!;
    expect(readFileSync(stream, 'utf8')).toContain('readFrames');
    expect(codeOf(stream)).not.toContain('readFrames');
    expect(codeOf(stream)).toContain('registerInferStream');
  });
});
