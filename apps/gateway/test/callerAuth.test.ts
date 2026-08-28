import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import { makeCallerAuthHook, type VerifyEntra } from '../src/callerAuth.ts';
import { loadConfig } from '../src/config.ts';
import type { CallerAuthConfig, ModelEntry } from '../src/config.ts';
import { Allowlist } from '../src/allowlist.ts';
import { AuditLogger, type AuditRecord, type AuditSink } from '../src/audit.ts';
import { buildRegistry } from '../src/adapters/registry.ts';
import { buildServer } from '../src/server.ts';
import { unlimitedRateLimiter } from '../src/rateLimit.ts';
import type { Transport } from '../src/callModel.ts';

/**
 * `app.inject` gives every request a plain (non-TLS) socket, so the `mtls`
 * cases fake the two fields `callerAuth.ts` actually reads off it —
 * `authorized` and `getPeerCertificate()` — via an `onRequest` hook that
 * runs before the `preHandler` under test. This is the "stub the socket"
 * harness the brief calls for, kept local to this file since nothing else
 * needs it.
 *
 * `hits` counts route-handler invocations. It is how the mutation-proof
 * test for "a preHandler, not something that runs after the route body" is
 * actually enforced: `reply.sent` alone would still pass if the hook ran
 * too late but happened to overwrite the response, so a case in this file
 * asserts the handler itself never ran.
 */
function buildApp(
  config: CallerAuthConfig,
  verifyEntra: VerifyEntra,
  socket: { authorized?: boolean; cn?: string } = {},
) {
  const state = { hits: 0 };
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    const raw = req.raw.socket as unknown as {
      authorized?: boolean;
      getPeerCertificate: () => { subject?: { CN?: string } };
    };
    raw.authorized = socket.authorized ?? false;
    raw.getPeerCertificate = () =>
      (socket.cn !== undefined ? { subject: { CN: socket.cn } } : {});
  });
  app.addHook('preHandler', makeCallerAuthHook(config, verifyEntra));
  app.post('/v1/infer', async () => {
    state.hits += 1;
    return { ok: true };
  });
  return { app, state };
}

const failingVerify: VerifyEntra = async () => {
  throw new Error('should not be called in this test');
};

describe('makeCallerAuthHook — mode: none', () => {
  it('allows any request when constructed directly with mode: none', async () => {
    const { app } = buildApp({ mode: 'none' }, failingVerify);
    const res = await app.inject({ method: 'POST', url: '/v1/infer' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('has NO GATEWAY_CALLER_AUTH value that produces mode: none (Task 4)', () => {
    const model = {
      id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
      contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
      isDefault: true,
      endpoint: 'https://lexprompt-uks.services.ai.azure.com',
      credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
    };
    const read = () => JSON.stringify({ models: [model] });
    for (const value of ['none', '', 'off', 'disabled', undefined]) {
      expect(() => loadConfig(
        {
          GATEWAY_MODELS_FILE: '/m.json',
          GATEWAY_ALLOWED_JURISDICTIONS: 'UK',
          GATEWAY_CALLER_AUTH: value,
        },
        read,
      )).toThrow(/GATEWAY_CALLER_AUTH/);
    }
  });
});

describe('makeCallerAuthHook — mode: mtls', () => {
  const config: CallerAuthConfig = {
    mode: 'mtls',
    caFile: '/ca.pem',
    certFile: '/gateway.pem',
    keyFile: '/gateway.key',
    allowedSubject: 'lexprompt-api',
  };

  it('rejects 401 naming that a client certificate is required, and never runs the route handler', async () => {
    const { app, state } = buildApp(config, failingVerify, { authorized: false });
    const res = await app.inject({ method: 'POST', url: '/v1/infer' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/client certificate is required/i);
    expect(state.hits).toBe(0);
  });

  it('rejects 401 naming the certificate CN it saw when it does not match allowedSubject', async () => {
    const { app } = buildApp(config, failingVerify, { authorized: true, cn: 'some-other-service' });
    const res = await app.inject({ method: 'POST', url: '/v1/infer' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toContain('some-other-service');
  });

  it('allows the request when authorized and the CN matches', async () => {
    const { app, state } = buildApp(config, failingVerify, { authorized: true, cn: 'lexprompt-api' });
    const res = await app.inject({ method: 'POST', url: '/v1/infer' });
    expect(res.statusCode).toBe(200);
    expect(state.hits).toBe(1);
  });

  it('THE MUTATION-PROOF CASE: a valid Entra bearer token with no client certificate is still rejected', async () => {
    const verifyEntra: VerifyEntra = async () => ({ oid: 'allowed-oid' });
    const { app, state } = buildApp(config, verifyEntra, { authorized: false });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/infer',
      headers: { authorization: 'Bearer a-valid-looking-entra-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(state.hits).toBe(0);
  });
});

describe('makeCallerAuthHook — mode: entra', () => {
  const config: CallerAuthConfig = {
    mode: 'entra',
    tenantId: 'tenant-1',
    audience: 'api://gateway',
    allowedObjectIds: ['allowed-oid'],
  };

  it('rejects 401 with no Authorization header', async () => {
    const { app, state } = buildApp(config, failingVerify);
    const res = await app.inject({ method: 'POST', url: '/v1/infer' });
    expect(res.statusCode).toBe(401);
    expect(state.hits).toBe(0);
  });

  it('rejects 401 when verifyEntra throws', async () => {
    const throwingVerify: VerifyEntra = async () => { throw new Error('signature invalid'); };
    const { app } = buildApp(config, throwingVerify);
    const res = await app.inject({
      method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer bad-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects when the token's oid is not allowed, naming neither the token nor the oid in the body", async () => {
    const verifyEntra: VerifyEntra = async () => ({ oid: 'someone-else' });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const { app } = buildApp(config, verifyEntra);
      const res = await app.inject({
        method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer some-token-value' },
      });
      expect(res.statusCode).toBe(401);
      const bodyText = res.body;
      expect(bodyText).not.toContain('someone-else');
      expect(bodyText).not.toContain('some-token-value');
      // The oid is logged, not returned.
      expect(stderrSpy.mock.calls.some(c => String(c[0]).includes('someone-else'))).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('allows the request when verifyEntra resolves with an allowed oid', async () => {
    const verifyEntra: VerifyEntra = async () => ({ oid: 'allowed-oid' });
    const { app, state } = buildApp(config, verifyEntra);
    const res = await app.inject({
      method: 'POST', url: '/v1/infer', headers: { authorization: 'Bearer good-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(state.hits).toBe(1);
  });
});

/**
 * `buildApp` above wires `makeCallerAuthHook` directly, as its own
 * `preHandler`, on a Fastify instance the test builds — it proves the hook
 * function is correct in isolation, but not that `server.ts`'s `buildServer`
 * actually registers it AS a `preHandler` (ahead of the real `/v1/infer`
 * route, which calls out through a `Transport`) rather than, say, an
 * `onResponse` hook that runs after the route body. This suite goes through
 * `buildServer` itself, with a `Transport` that throws if it is ever
 * reached, so "the caller-auth hook runs before any route body" is a
 * property of the shipped wiring, not just of the function it wires in.
 */
describe('buildServer wiring (Task 15) — the caller-auth hook runs before the route body', () => {
  const entry: ModelEntry = {
    id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
    jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
    contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
    endpoint: 'https://firm.services.ai.azure.com',
    credential: { source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'gpt4o' },
  };

  class Sink implements AuditSink {
    records: AuditRecord[] = [];
    async write(r: AuditRecord) { this.records.push(r); }
  }

  const neverCalledTransport: Transport = (async () => {
    throw new Error('Transport was reached — the caller-auth hook did not run before the route body.');
  }) as unknown as Transport;

  function buildRealApp(caller: CallerAuthConfig) {
    const app = buildServer({
      config: {
        port: 0, models: [entry], allowedJurisdictions: ['UK'],
        maxPromptChars: 400_000, requestTimeoutMs: 5000, defaultMaxTokens: 4096,
        publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded',
        readEnv: () => undefined, caller,
      } as never,
      allowlist: new Allowlist([entry]),
      audit: new AuditLogger(new Sink(), () => new Date(), () => 'call-fixed'),
      credentials: { resolve: async () => ({ kind: 'api-key' as const, key: 'kv-secret' }) },
      transport: neverCalledTransport,
      limiter: unlimitedRateLimiter,
      registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
    });
    return app;
  }

  const BODY = {
    workspaceId: 'ws-1', actorIssuer: 'https://keycloak.local/realms/lexprompt',
    actorSubject: 'oid-1', modelChoiceId: 'uks-gpt4o', purpose: 'review.clause', user: 'hi',
  };

  it('rejects an mtls-mode request with no client certificate before the transport is ever called', async () => {
    const app = buildRealApp({
      mode: 'mtls', caFile: '/ca.pem', certFile: '/gw.pem', keyFile: '/gw.key',
      allowedSubject: 'lexprompt-api',
    });
    // No TLS in `app.inject`, so `req.raw.socket.authorized` is falsy by
    // default — exactly the "no client certificate" case.
    const res = await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(res.statusCode).toBe(401);
  });

  it('excludes /healthz from the caller-auth hook', async () => {
    const app = buildRealApp({
      mode: 'mtls', caFile: '/ca.pem', certFile: '/gw.pem', keyFile: '/gw.key',
      allowedSubject: 'lexprompt-api',
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });
});
