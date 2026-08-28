import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.ts';

const UK_MODEL = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o',
  label: 'GPT-4o (Foundry, UK South)',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://lexprompt-uks.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const US_MODEL = {
  id: 'oai-gpt4o', provider: 'openai', model: 'gpt-4o', label: 'GPT-4o (OpenAI)',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
  isDefault: true,
  endpoint: 'https://api.openai.com',
  credential: { source: 'env', var: 'OPENAI_API_KEY' },
};

const BASE = {
  GATEWAY_PORT: '8081',
  GATEWAY_MODELS_FILE: '/etc/lexprompt/models.json',
  // No default exists, so every fixture states the operator's policy
  // explicitly — which is what a real deployment must also do.
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

describe('loadConfig', () => {
  it('loads a model whose jurisdiction the operator has declared permitted', () => {
    const cfg = loadConfig({ ...BASE }, read(file(UK_MODEL)));
    expect(cfg.port).toBe(8081);
    expect(cfg.allowedJurisdictions).toEqual(['UK', 'EU']);
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0].endpoint).toBe('https://lexprompt-uks.services.ai.azure.com');
  });

  // P4, and the owner's fifth decision. THERE IS NO DEFAULT: which
  // jurisdictions a firm accepts is a judgement about contracts and data
  // provisions that this design has no standing to make on their behalf, and
  // a default value would make it silently.
  it('REFUSES TO START when GATEWAY_ALLOWED_JURISDICTIONS is unset, rather than assuming one', () => {
    const { GATEWAY_ALLOWED_JURISDICTIONS, ...unset } = BASE;
    expect(() => loadConfig(unset, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS[\s\S]*no default/i);
  });

  it('REFUSES TO START when it is set but empty, which is the same silence with a keystroke', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: '   ' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  // P4 — the jurisdiction gate itself.
  it('REFUSES TO START when a model is outside the permitted jurisdictions, naming it', () => {
    expect(() => loadConfig({ ...BASE }, read(file(US_MODEL))))
      .toThrow(/oai-gpt4o[\s\S]*openai[\s\S]*US[\s\S]*United States[\s\S]*GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  // Not because US is exceptional — because it is a jurisdiction this
  // operator had not declared. The same test would hold for EU under a
  // UK-only policy.
  it('starts with a US model when the operator has declared US permitted', () => {
    const cfg = loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU,US' },
      read(file(US_MODEL)),
    );
    expect(cfg.models[0].jurisdiction.bloc).toBe('US');
    expect(cfg.allowedJurisdictions).toEqual(['UK', 'EU', 'US']);
  });

  it('refuses an unknown bloc in the permitted list rather than ignoring it', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,MARS' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_ALLOWED_JURISDICTIONS[\s\S]*MARS/);
  });

  it('refuses an unknown provider id rather than dropping the entry', () => {
    expect(() => loadConfig({ ...BASE }, read(file({ ...UK_MODEL, provider: 'bedrock' }))))
      .toThrow(/bedrock/);
  });

  it('refuses an entry with no jurisdiction rather than assuming one', () => {
    const { jurisdiction, ...noJurisdiction } = UK_MODEL;
    expect(() => loadConfig({ ...BASE }, read(file(noJurisdiction))))
      .toThrow(/uks-gpt4o[\s\S]*jurisdiction/);
  });

  it('refuses an entry with no credential source rather than calling unauthenticated', () => {
    const { credential, ...noCredential } = UK_MODEL;
    expect(() => loadConfig({ ...BASE }, read(file(noCredential))))
      .toThrow(/uks-gpt4o[\s\S]*credential\.source/);
  });

  it('refuses an EMPTY allowlist rather than starting with nothing to offer', () => {
    expect(() => loadConfig({ ...BASE }, read(file())))
      .toThrow(/at least one model/i);
  });

  it('refuses two entries sharing an id', () => {
    expect(() => loadConfig({ ...BASE }, read(file(UK_MODEL, UK_MODEL))))
      .toThrow(/duplicate model id "uks-gpt4o"/i);
  });

  it('refuses more than one default, and refuses none', () => {
    const other = { ...UK_MODEL, id: 'other' };
    expect(() => loadConfig({ ...BASE }, read(file(UK_MODEL, other))))
      .toThrow(/exactly one model must be marked isDefault/i);
    expect(() => loadConfig({ ...BASE }, read(file({ ...UK_MODEL, isDefault: false }))))
      .toThrow(/exactly one model must be marked isDefault/i);
  });

  it('refuses a missing models file reference rather than serving nothing', () => {
    const { GATEWAY_MODELS_FILE, ...noFile } = BASE;
    expect(() => loadConfig(noFile, read(file(UK_MODEL)))).toThrow(/GATEWAY_MODELS_FILE/);
  });

  it('reports a malformed models file as a config error, not a JSON parse crash', () => {
    expect(() => loadConfig({ ...BASE }, read('{not json'))).toThrow(ConfigError);
  });

  it('defaults the operational limits and lets the operator raise them', () => {
    const d = loadConfig({ ...BASE }, read(file(UK_MODEL)));
    expect(d.maxPromptChars).toBe(400_000);
    expect(d.requestTimeoutMs).toBe(120_000);
    expect(d.defaultMaxTokens).toBe(4096);
    const raised = loadConfig(
      { ...BASE, GATEWAY_MAX_PROMPT_CHARS: '900000', GATEWAY_REQUEST_TIMEOUT_MS: '30000' },
      read(file(UK_MODEL)),
    );
    expect(raised.maxPromptChars).toBe(900_000);
    expect(raised.requestTimeoutMs).toBe(30_000);
  });

  it('carries an optional dataHandling note, and refuses a half-filled one (S26)', () => {
    const withNote = { ...UK_MODEL, dataHandling: {
      summary: 'UK South, no training on inputs, 30-day abuse retention.',
      lastCheckedAt: '2026-08-28', reference: 'MSA-2026-014' } };
    expect(loadConfig({ ...BASE }, read(file(withNote))).models[0].dataHandling)
      .toEqual(withNote.dataHandling);

    // Absent is fine — nothing renders it in Stage 1.
    expect('dataHandling' in loadConfig({ ...BASE }, read(file(UK_MODEL))).models[0]).toBe(false);

    // Present but undated is not: a record that cannot go stale is worse
    // than no record.
    expect(() => loadConfig({ ...BASE },
      read(file({ ...UK_MODEL, dataHandling: { summary: 'x', lastCheckedAt: 'recently' } }))))
      .toThrow(/lastCheckedAt[\s\S]*ISO date/);
    expect(() => loadConfig({ ...BASE },
      read(file({ ...UK_MODEL, dataHandling: { lastCheckedAt: '2026-08-28' } }))))
      .toThrow(/dataHandling\.summary/);
  });

  it('carries publicOrigin, recordedDir and a readEnv accessor, so nothing else reads the environment', () => {
    const cfg = loadConfig({ ...BASE, GATEWAY_PUBLIC_ORIGIN: 'https://lexprompt.firm.example' },
      read(file(UK_MODEL)));
    expect(cfg.publicOrigin).toBe('https://lexprompt.firm.example');
    expect(cfg.recordedDir).toBe('apps/gateway/fixtures/recorded');
    expect(cfg.readEnv('GATEWAY_PORT')).toBe('8081');
    expect(cfg.readEnv('NOT_SET')).toBe(undefined);
  });

  it('refuses a non-numeric limit rather than silently using the default', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_MAX_PROMPT_CHARS: 'lots' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_MAX_PROMPT_CHARS/);
  });

  it('refuses an unknown caller-auth mode rather than defaulting to none', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_CALLER_AUTH: 'trustme' }, read(file(UK_MODEL))))
      .toThrow(/GATEWAY_CALLER_AUTH/);
  });

  // S29's shape at the gateway's own front door, and S30's "no environment
  // branch": there is no configuration value that turns the caller check
  // off, so there is nothing to accidentally ship enabled and nothing that
  // behaves differently in one environment.
  it('has NO configuration value that disables the caller check, in any environment', () => {
    for (const nodeEnv of ['development', 'production', undefined]) {
      expect(() => loadConfig(
        { ...BASE, GATEWAY_CALLER_AUTH: 'none', NODE_ENV: nodeEnv }, read(file(UK_MODEL)),
      )).toThrow(/no value that disables the caller check/i);
    }
  });
});
