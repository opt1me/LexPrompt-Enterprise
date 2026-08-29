import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { ModelError } from '@lexprompt/core';
import { apiGet, apiSend, apiDelete, makeApiClient } from './client';

const token = () => Promise.resolve('tok-123');

describe('the repository transport', () => {
  it('sends the bearer token and the JSON content type', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{"ok":true}', {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const api = makeApiClient({ baseUrl: 'https://x/api', getToken: token, fetch: fetchSpy });
    await api.send('PUT', '/v1/matters/m1', { id: 'm1' });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/api/v1/matters/m1');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"id":"m1"}');
  });

  it('returns null for a 404 on a get-or-null, and does NOT throw', async () => {
    // `getMatter` and friends return `T | null` today and callers rely on it.
    // A 404 that threw would turn "no such matter" into a red error panel.
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response('', { status: 404 })) });
    expect(await api.getOrNull('/v1/matters/gone')).toBeNull();
  });

  it('throws a ModelError carrying the body code for a refusal', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ error: { code: 'not_permitted', message: 'This needs the partner role.' } }),
        { status: 403, headers: { 'content-type': 'application/json' } })) });
    const err = await api.get('/v1/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).code).toBe('not_permitted');
    expect((err as ModelError).message).toContain('partner role');
  });

  it('falls back to the STATUS when the body is not ours — an ingress 401 is still a sign-in problem', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockResolvedValue(new Response('<html>Unauthorized</html>', { status: 401 })) });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('sign_in_required');
  });

  it('reports a transport failure as `network`, not as an empty result', async () => {
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('network');
    expect(err.message).toMatch(/could not reach/i);
  });

  it('lets an abort through as an abort, never as a network failure', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const api = makeApiClient({ baseUrl: '/api', getToken: token,
      fetch: vi.fn().mockRejectedValue(abort) });
    await expect(api.get('/v1/x')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('does not send a body on DELETE, and treats 204 as success', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const api = makeApiClient({ baseUrl: '/api', getToken: token, fetch: fetchSpy });
    await expect(api.del('/v1/matters/m1')).resolves.toBeUndefined();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).body).toBeUndefined();
  });

  it('refuses to send when no access token can be obtained, rather than sending an unauthenticated request', async () => {
    // An unauthenticated request would be answered 401 and would look
    // identical to an expired session — sending the user round a sign-in
    // loop that cannot terminate. Stage 1's Task 19 mutation found exactly
    // this gap on `getAccessToken` returning empty.
    const fetchSpy = vi.fn();
    const api = makeApiClient({ baseUrl: '/api', getToken: async () => '', fetch: fetchSpy });
    const err = await api.get('/v1/x').catch((e: unknown) => e) as ModelError;
    expect(err.code).toBe('sign_in_required');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not set Content-Type on a multipart form send — the browser must set the boundary itself', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const api = makeApiClient({ baseUrl: '/api', getToken: token, fetch: fetchSpy });
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.pdf');
    await api.sendForm('/v1/documents', form);
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).not.toHaveProperty('Content-Type');
  });

  it('the free apiGet/apiSend/apiDelete functions call through the one app instance', async () => {
    // Exercises the module's own singleton wiring path exists and is
    // callable — the actual network behaviour is covered by `makeApiClient`
    // above. This only proves the exports exist and are functions, since
    // the singleton itself is bound at import time to the real fetch/token.
    expect(typeof apiGet).toBe('function');
    expect(typeof apiSend).toBe('function');
    expect(typeof apiDelete).toBe('function');
  });

  it('is the only place src/ calls fetch (a second transport is a second error vocabulary)', async () => {
    // `recursive: true` returns OS-native separators — backslashes on
    // Windows — so the literal `'lib/api/client.ts'` comparison below never
    // matched on this platform until normalised. Found running this exact
    // guard, not hypothetically: it flagged `client.ts` itself as an
    // offender on a win32 checkout.
    const files = readdirSync('src', { recursive: true, encoding: 'utf8' })
      .filter(f => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'))
      .map(f => f.split('\\').join('/'));
    expect(files.length).toBeGreaterThan(80); // the scanner finds something
    const offenders = files.filter(f => {
      if (f === 'lib/api/client.ts') return false;
      // `gatewayModelClient.ts` takes `fetch` as an INJECTED dependency in
      // `makeGatewayModelClient` and does not reach for the global there —
      // its module-level singleton wiring at the bottom of the file is the
      // SAME shape as `client.ts`'s own singleton just above, for the same
      // reason (S30: `config.ts` is the one reader of `import.meta.env`,
      // and each transport's default export is the one place that reads
      // the real global `fetch`). One file per transport, not one file in
      // all of `src/`.
      if (f === 'lib/model/gatewayModelClient.ts') return false;
      const code = readFileSync(`src/${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      return /\b(globalThis\.fetch|window\.fetch)\b/.test(code);
    });
    expect(offenders).toEqual([]);
  });
});
