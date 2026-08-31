import { describe, it, expect, vi } from 'vitest';
import type { ProvidersPage } from '@lexprompt/core';
import { buildServer } from '../src/server.ts';
import { Allowlist } from '../src/allowlist.ts';
import { AuditLogger } from '../src/audit.ts';
import { buildRegistry } from '../src/adapters/registry.ts';
import { unlimitedRateLimiter } from '../src/rateLimit.ts';
import type { ModelEntry } from '../src/config.ts';
import { DefaultCredentialResolver, redactCredential } from '../src/credentials/resolve.ts';

const deps = (over: Partial<ConstructorParameters<typeof DefaultCredentialResolver>[0]> = {}) =>
  new DefaultCredentialResolver({
    getToken: async () => ({ token: 'mi-token', expiresOnTimestamp: Date.now() + 3_600_000 }),
    getSecret: async () => 'vault-key',
    readEnv: (name: string) => (name === 'OPENAI_API_KEY' ? 'env-key' : undefined),
    readFile: (p: string) => (p === '/run/secrets/k' ? 'file-key\n' : (() => { throw new Error('ENOENT'); })()),
    now: () => Date.now(),
    ...over,
  });

describe('credential resolution (S2, as revised)', () => {
  it('managed identity yields a bearer token', async () => {
    expect(await deps().resolve({ source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' }))
      .toEqual({ kind: 'bearer', token: 'mi-token' });
  });

  it('key vault yields an api key', async () => {
    expect(await deps().resolve({ source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 's' }))
      .toEqual({ kind: 'api-key', key: 'vault-key' });
  });

  it('env yields an api key', async () => {
    expect(await deps().resolve({ source: 'env', var: 'OPENAI_API_KEY' }))
      .toEqual({ kind: 'api-key', key: 'env-key' });
  });

  it('file yields an api key with trailing whitespace trimmed', async () => {
    expect(await deps().resolve({ source: 'file', path: '/run/secrets/k' }))
      .toEqual({ kind: 'api-key', key: 'file-key' });
  });

  it('caches a managed-identity token and reuses it inside its lifetime', async () => {
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }));
    const r = deps({ getToken });
    const c = { source: 'managed-identity' as const, scope: 's' };
    await r.resolve(c); await r.resolve(c);
    expect(getToken).toHaveBeenCalledTimes(1);
  });

  it('re-acquires a managed-identity token inside the expiry margin', async () => {
    let clock = 1_000_000;
    const getToken = vi.fn(async () => ({ token: 't', expiresOnTimestamp: clock + 60_000 }));
    const r = deps({ getToken, now: () => clock });
    const c = { source: 'managed-identity' as const, scope: 's' };
    await r.resolve(c);
    clock += 30_000;                       // 30s left, inside the 120s margin
    await r.resolve(c);
    expect(getToken).toHaveBeenCalledTimes(2);
  });

  // THE rule. §10: "never a fallback to an unauthenticated or
  // differently-authenticated call".
  it('a managed-identity failure is a loud 503 and NEVER falls back to a key', async () => {
    const r = deps({
      getToken: async () => { throw new Error('ManagedIdentityCredential: no identity endpoint'); },
      readEnv: () => 'a-key-that-must-not-be-used',
    });
    await expect(r.resolve({ source: 'managed-identity', scope: 's' })).rejects.toMatchObject({
      name: 'ModelError', code: 'service_misconfigured', status: 503,
    });
  });

  it('a key-vault failure is a loud 503 and NEVER falls back to env', async () => {
    const r = deps({
      getSecret: async () => { throw new Error('Forbidden'); },
      readEnv: () => 'a-key-that-must-not-be-used',
    });
    await expect(r.resolve({ source: 'key-vault', vaultUrl: 'v', secretName: 's' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('a missing env var is a loud 503, not an empty key sent as a credential', async () => {
    await expect(deps().resolve({ source: 'env', var: 'NOT_SET' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('an empty env var is a loud 503, because an empty credential is not a credential', async () => {
    const r = deps({ readEnv: () => '   ' });
    await expect(r.resolve({ source: 'env', var: 'OPENAI_API_KEY' }))
      .rejects.toMatchObject({ code: 'service_misconfigured', status: 503 });
  });

  it('names WHICH source failed and WHAT to fix, without quoting any secret', async () => {
    const r = deps({ getSecret: async () => { throw new Error('Forbidden by RBAC'); } });
    await expect(r.resolve({ source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'prod-model-key' }))
      .rejects.toThrow(/key-vault[\s\S]*https:\/\/kv\.vault\.azure\.net[\s\S]*prod-model-key[\s\S]*Forbidden by RBAC/);
  });
});

describe('redactCredential', () => {
  it('replaces a key wherever it appears in text bound for a log or an error', () => {
    expect(redactCredential('Bearer sk-abc123 rejected', { kind: 'api-key', key: 'sk-abc123' }))
      .toBe('Bearer [redacted] rejected');
  });

  it('replaces a bearer token too', () => {
    expect(redactCredential('token eyJhbG bad', { kind: 'bearer', token: 'eyJhbG' }))
      .toBe('token [redacted] bad');
  });

  it('leaves text alone when the credential does not appear in it', () => {
    expect(redactCredential('rate limit exceeded', { kind: 'api-key', key: 'sk-abc' }))
      .toBe('rate limit exceeded');
  });
});

/* -------------------------------------------------------------------------
 * §14's admin credential endpoint (S2, P56)
 * ---------------------------------------------------------------------- */

const SECRET = 'sk-test-DO-NOT-LEAK-0123456789abcdef';

const MODEL = (over: Partial<ModelEntry>): ModelEntry => ({
  id: 'uks-gpt4o',
  provider: 'openai',
  model: 'gpt-4o',
  label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128_000,
  supportsImages: true,
  supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://example.invalid/v1',
  credential: { source: 'env', var: 'OPENAI_API_KEY' },
  ...over,
} as ModelEntry);

interface Built { app: ReturnType<typeof buildServer>; lines: string[]; tokens: () => number }

function statusServer(over: {
  models?: ModelEntry[];
  fileRotatedAt?: (path: string) => Date | undefined;
  jurisdictions?: string[];
} = {}): Built {
  const models = over.models ?? [MODEL({})];
  const lines: string[] = [];
  let acquisitions = 0;
  const app = buildServer({
    config: {
      port: 0, models, allowedJurisdictions: over.jurisdictions ?? ['UK'],
      maxPromptChars: 400_000, requestTimeoutMs: 5000, defaultMaxTokens: 4096,
      publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded',
      readEnv: (name: string) => (name === 'OPENAI_API_KEY' ? SECRET : undefined),
      caller: { mode: 'none' },
    } as never,
    allowlist: new Allowlist(models),
    audit: new AuditLogger({ write: async () => { /* nothing to collect here */ } }),
    // COUNTED, NEVER CALLED. Reporting status must not itself perform a
    // credential acquisition: an administrator refreshing this screen would
    // otherwise mint a token per refresh, and a failing acquisition would
    // make the STATUS page the thing that is down.
    credentials: {
      resolve: async () => { acquisitions += 1; return { kind: 'api-key' as const, key: SECRET }; },
    },
    transport: (async () => { throw new Error('no transport in this suite'); }) as never,
    limiter: unlimitedRateLimiter,
    registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
    credentialStatus: {
      fileRotatedAt: over.fileRotatedAt ?? (() => undefined),
      log: (line: string) => { lines.push(line); },
    },
  });
  return { app, lines, tokens: () => acquisitions };
}

const get = async (built: Built): Promise<{ status: number; text: string; body: ProvidersPage }> => {
  const res = await built.app.inject({ method: 'GET', url: '/v1/admin/credentials' });
  return { status: res.statusCode, text: res.body, body: res.json() as ProvidersPage };
};

describe('the admin credential endpoint (S2, P56)', () => {
  it('reports configured and rotatedAt, and nothing that is a fact about the secret', async () => {
    const built = statusServer();
    const { body, text } = await get(built);
    expect(body.providers.find(p => p.provider === 'openai')).toMatchObject({
      configured: true, auth: 'key', modelCount: 1,
    });
    expect(text).not.toContain(SECRET);
    for (const forbidden of ['last4', 'prefix', 'fingerprint', 'length', 'key']) {
      expect(Object.keys(body.providers[0]), forbidden).not.toContain(forbidden);
    }
    // THE SANITY HALF: the sweep can see a leak when there is one. Without
    // it, a route that returned nothing at all would pass every line above.
    expect(JSON.stringify({ k: SECRET })).toContain(SECRET);
    expect(body.providers).toHaveLength(1);
  });

  it('echoes the declared jurisdictions, so a screen shows what is ENFORCED', async () => {
    const { body } = await get(statusServer({ jurisdictions: ['UK', 'EU'] }));
    expect(body.declaredJurisdictions).toEqual(['UK', 'EU']);
  });

  it('counts the models routing to each provider', async () => {
    const { body } = await get(statusServer({ models: [
      MODEL({}),
      MODEL({ id: 'b', isDefault: false }),
      MODEL({ id: 'c', provider: 'anthropic', isDefault: false,
        credential: { source: 'managed-identity', scope: 's' } }),
    ] }));
    expect(body.providers.map(p => [p.provider, p.modelCount]))
      .toEqual([['anthropic', 1], ['openai', 2]]);
  });

  it('reports auth: managed-identity without ever acquiring a token', async () => {
    const built = statusServer({ models: [
      MODEL({ provider: 'azure-foundry', credential: { source: 'managed-identity', scope: 's' } }),
    ] });
    const { body } = await get(built);
    expect(body.providers[0].auth).toBe('managed-identity');
    expect(body.providers[0].configured).toBe(true);
    expect(built.tokens()).toBe(0);
  });

  it('reports an UNSET env var as not configured, rather than as configured-and-broken', async () => {
    const built = statusServer({ models: [
      MODEL({ credential: { source: 'env', var: 'NOT_SET_ANYWHERE' } }),
    ] });
    const { body } = await get(built);
    expect(body.providers[0].configured).toBe(false);
    expect(built.tokens()).toBe(0);
  });

  it('reports a file source mtime as rotatedAt, and ABSENT when there is none', async () => {
    const when = new Date('2026-03-04T05:06:07.000Z');
    const withFile = await get(statusServer({
      models: [MODEL({ credential: { source: 'file', path: '/run/secrets/k' } })],
      fileRotatedAt: () => when,
    }));
    expect(withFile.body.providers[0].rotatedAt).toBe(when.toISOString());

    const without = await get(statusServer());
    // ABSENT, never `rotatedAt: undefined`. Absent means "not recorded"; a
    // present key with no value reads to an `in` check as an instant that is
    // there.
    expect('rotatedAt' in without.body.providers[0]).toBe(false);
  });

  it('leaks nothing on the ERROR path either, and nothing into the log', async () => {
    // A source that throws WITH THE CREDENTIAL IN ITS MESSAGE — which is
    // exactly how a leak has happened in real systems.
    const built = statusServer({
      models: [MODEL({ credential: { source: 'file', path: '/run/secrets/k' } })],
      fileRotatedAt: () => { throw new Error(`cannot stat: bad key ${SECRET}`); },
    });
    const res = await built.app.inject({ method: 'GET', url: '/v1/admin/credentials' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain(SECRET);
    // …and the caught message is not in the response at ALL, redacted or
    // otherwise: this route reports no fact about any secret, and a
    // half-redacted provider message is a fact about one.
    expect(res.body).not.toContain('cannot stat');
    /*
     * THE LOG CARRIES NO MESSAGE EITHER, and that is a design decision this
     * case forced.
     *
     * The first draft sent the message to the log through
     * `redactCredential`, removing every ENV-sourced value this process
     * could see — and this case, whose error carries a FILE-sourced key,
     * went red. Correctly: the set of values that could appear in a failure
     * here is not knowable without acquiring them, and acquiring is the one
     * thing this route must not do. A redactor that removes some of the
     * secrets is a partial defence presented as a complete one, which is
     * worse than none because it looks handled.
     *
     * What IS logged is what cannot be a secret by construction: which
     * provider, which kind of source, and the error's class name.
     */
    const log = built.lines.join('\n');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain('cannot stat');
    expect(log).toContain('openai');
    expect(log).toContain('file source');
    expect(log).toContain('Error');
  });

  it('is refused for a caller the gateway does not authenticate', async () => {
    // The route sits behind the SAME caller-auth hook every other route sits
    // behind and invents no second mechanism. Proved by turning the hook on:
    // `/healthz` is the one exclusion, and this is not it.
    const models = [MODEL({})];
    const app = buildServer({
      config: {
        port: 0, models, allowedJurisdictions: ['UK'], maxPromptChars: 400_000,
        requestTimeoutMs: 5000, defaultMaxTokens: 4096,
        publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded',
        readEnv: () => SECRET,
        caller: { mode: 'entra', tenantId: 't', audience: 'a', allowedObjectIds: ['oid'] },
      } as never,
      allowlist: new Allowlist(models),
      audit: new AuditLogger({ write: async () => { /* nothing */ } }),
      credentials: { resolve: async () => ({ kind: 'api-key' as const, key: SECRET }) },
      transport: (async () => { throw new Error('no transport'); }) as never,
      limiter: unlimitedRateLimiter,
      registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
      credentialStatus: { fileRotatedAt: () => undefined, log: () => { /* nothing */ } },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/admin/credentials' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain(SECRET);
    // The sanity half for THIS case: the same server answers /healthz, so
    // the 401 above is about the route rather than about a server that
    // refuses everything.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });
});
