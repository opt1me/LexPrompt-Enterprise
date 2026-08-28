import { Writable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { buildDeps } from '../src/wiring.ts';
import { unlimitedRateLimiter } from '../src/rateLimit.ts';

const UK_MODEL = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o',
  label: 'GPT-4o (Foundry, UK South)',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://lexprompt-uks.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const BASE = {
  GATEWAY_PORT: '8081',
  GATEWAY_MODELS_FILE: '/etc/lexprompt/models.json',
  GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU',
  GATEWAY_CALLER_AUTH: 'mtls',
  GATEWAY_MTLS_CA_FILE: '/certs/ca.pem',
  GATEWAY_MTLS_CERT_FILE: '/certs/gateway.pem',
  GATEWAY_MTLS_KEY_FILE: '/certs/gateway.key',
  GATEWAY_MTLS_ALLOWED_SUBJECT: 'lexprompt-api',
};

const read = (body: string) => (p: string) => {
  if (p !== '/etc/lexprompt/models.json') throw new Error(`unexpected read of ${p}`);
  return body;
};
const file = (...models: unknown[]) => JSON.stringify({ models });

// A sink that discards everything, so this test does not print an audit log
// or a boot banner to the real test runner output.
const devNull = (): Writable => new Writable({ write(_chunk, _enc, cb) { cb(); } });

describe('buildDeps — production wiring (R1)', () => {
  it('does not wire the permissive fixture limiter into production', () => {
    const config = loadConfig({ ...BASE }, read(file(UK_MODEL)));
    const deps = buildDeps(config, devNull());
    // A reference-identity check alone would pass if someone swapped in a
    // second, differently-named permissive limiter — the behavioural
    // assertion below is what actually guards against R1's defect. This is
    // kept alongside it because it is the most direct statement of the
    // ruling: the wiring must never read this exact exported name.
    expect(deps.limiter).not.toBe(unlimitedRateLimiter);
  });

  it('wires a limiter that actually enforces the configured request budget', () => {
    const config = loadConfig(
      { ...BASE, GATEWAY_RPM_PER_ACTOR: '2', GATEWAY_RPM_PER_WORKSPACE: '2' },
      read(file(UK_MODEL)),
    );
    const deps = buildDeps(config, devNull());

    deps.limiter.check('ws', 'a');
    deps.limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 });
    deps.limiter.check('ws', 'a');
    deps.limiter.record('ws', 'a', { promptTokens: 1, completionTokens: 0 });
    // If production wiring were reverted to `unlimitedRateLimiter` (or any
    // other implementation that enforces nothing), this call would not
    // throw and this test would fail — which is the point: it is the guard
    // against R1's defect, not just a check of today's wiring.
    expect(() => deps.limiter.check('ws', 'a')).toThrowError(
      expect.objectContaining({ code: 'budget_exhausted', status: 429 }));
  });
});
