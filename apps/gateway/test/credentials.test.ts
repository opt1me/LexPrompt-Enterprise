import { describe, it, expect, vi } from 'vitest';
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
