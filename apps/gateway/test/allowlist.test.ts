import { describe, it, expect } from 'vitest';
import { Allowlist, toAllowedModel } from '../src/allowlist.ts';
import type { ModelEntry } from '../src/config.ts';

const uk: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o',
  label: 'GPT-4o (Foundry, UK South)',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://lexprompt-uks.services.ai.azure.com',
  credential: { source: 'managed-identity', scope: 'https://cognitiveservices.azure.com/.default' },
};

const claude: ModelEntry = {
  id: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet-4-5',
  label: 'Claude Sonnet 4.5 (Anthropic)',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 200000, supportsImages: true, supportsStructuredOutput: true, isDefault: false,
  endpoint: 'https://api.anthropic.com',
  // Deliberately NOT the string 'anthropic': a leak test that cannot tell
  // the secret name from the legitimate `provider` field proves nothing.
  credential: { source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'prod-model-key' },
};

describe('Allowlist (S15)', () => {
  const list = new Allowlist([uk, claude]);

  it('resolves an allowlisted id to its full internal entry', () => {
    expect(list.resolve('uks-gpt4o').endpoint).toBe('https://lexprompt-uks.services.ai.azure.com');
  });

  it('refuses an id that is not on the list, with model_not_allowed', () => {
    expect(() => list.resolve('gpt-5-turbo-ultra'))
      .toThrowError(expect.objectContaining({ code: 'model_not_allowed', status: 400 }));
  });

  // The failure S15 exists to prevent: a user naming a provider model and
  // reaching an egress destination nobody reviewed.
  it('refuses a PROVIDER-side model name even when an entry uses it', () => {
    expect(() => list.resolve('gpt-4o'))
      .toThrowError(expect.objectContaining({ code: 'model_not_allowed' }));
  });

  it('names the model the caller asked for, so the message is diagnosable', () => {
    expect(() => list.resolve('nope')).toThrow(/"nope"/);
  });

  it('returns the single default', () => {
    expect(list.default().id).toBe('uks-gpt4o');
  });
});

describe('toAllowedModel — nothing internal crosses the wire', () => {
  it('produces exactly the AllowedModel keys and no others', () => {
    expect(Object.keys(toAllowedModel(claude)).sort()).toEqual([
      'contextLength', 'id', 'isDefault', 'jurisdiction', 'label',
      'model', 'provider', 'supportsImages', 'supportsStructuredOutput',
    ]);
    // …and with a dataHandling note, exactly one key more.
    expect(Object.keys(toAllowedModel({ ...claude, dataHandling: {
      summary: 's', lastCheckedAt: '2026-08-28' } })).sort())
      .toEqual([
        'contextLength', 'dataHandling', 'id', 'isDefault', 'jurisdiction', 'label',
        'model', 'provider', 'supportsImages', 'supportsStructuredOutput',
      ]);
  });

  it('drops endpoint, apiVersion and credential', () => {
    const wire = toAllowedModel(claude) as unknown as Record<string, unknown>;
    expect('endpoint' in wire).toBe(false);
    expect('apiVersion' in wire).toBe(false);
    expect('credential' in wire).toBe(false);
  });

  it('no serialisation of the list mentions a vault, a secret name or an endpoint host', () => {
    const json = JSON.stringify(new Allowlist([uk, claude]).list());
    expect(json).not.toContain('vault.azure.net');
    expect(json).not.toContain('prod-model-key');
    expect(json).not.toContain('services.ai.azure.com');
    expect(json).not.toContain('api.anthropic.com');
    expect(json).toContain('claude-sonnet');   // the entry id is fine, and needed
  });

  it('keeps the jurisdiction, because the browser has to show it', () => {
    expect(toAllowedModel(claude).jurisdiction)
      .toEqual({ bloc: 'US', region: 'us', label: 'United States' });
  });
});
