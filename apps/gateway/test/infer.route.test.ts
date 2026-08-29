import { describe, it, expect, vi } from 'vitest';
import { Allowlist } from '../src/allowlist.ts';
import { AuditLogger, type AuditRecord, type AuditSink } from '../src/audit.ts';
import { buildRegistry } from '../src/adapters/registry.ts';
import { buildServer } from '../src/server.ts';
import { unlimitedRateLimiter } from '../src/rateLimit.ts';
import type { ModelEntry } from '../src/config.ts';
import type { Transport, TransportResponse } from '../src/callModel.ts';

const entry: ModelEntry = {
  id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
  jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://firm.services.ai.azure.com',
  apiVersion: '2024-05-01-preview',
  credential: { source: 'key-vault', vaultUrl: 'https://kv.vault.azure.net', secretName: 'gpt4o' },
  dataHandling: { summary: 'No training on our data.', lastCheckedAt: '2026-01-04' },
};

const ok = (content: string): TransportResponse => ({
  status: 200, ok: true, body: null,
  json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
  text: async () => '',
});

class Sink implements AuditSink {
  records: AuditRecord[] = [];
  async write(r: AuditRecord) { this.records.push(r); }
}

function server(transport: Transport, over: Partial<{ allowedJurisdictions: string[] }> = {}) {
  const sink = new Sink();
  const app = buildServer({
    config: {
      port: 0, models: [entry], allowedJurisdictions: over.allowedJurisdictions ?? ['UK'],
      maxPromptChars: 400_000, requestTimeoutMs: 5000, defaultMaxTokens: 4096,
      publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded',
      readEnv: () => undefined, caller: { mode: 'none' },
    } as never,
    allowlist: new Allowlist([entry]),
    audit: new AuditLogger(sink, () => new Date(), () => 'call-fixed'),
    credentials: { resolve: async () => ({ kind: 'api-key' as const, key: 'kv-secret' }) },
    transport,
    limiter: unlimitedRateLimiter,
    registry: buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' }),
  });
  return { app, sink };
}

const BODY = {
  workspaceId: 'ws-1',
  actorIssuer: 'https://keycloak.local/realms/lexprompt',
  actorSubject: 'oid-1',
  modelChoiceId: 'uks-gpt4o',
  purpose: 'review.clause',
  user: 'Does clause 7 cap liability?',
};

describe('POST /v1/infer', () => {
  it('returns the InferResponse shape on success', async () => {
    const { app } = server({ fetch: async () => ok('It does.') });
    const res = await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      content: 'It does.',
      usage: { promptTokens: 3, completionTokens: 1 },
      callId: 'call-fixed',
      provider: 'azure-foundry',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
      stopReason: 'unknown',
    });
    await app.close();
  });

  it('answers a model that is not allowlisted with 400 and the code', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const { app } = server({ fetch: fetchSpy });
    const res = await app.inject({
      method: 'POST', url: '/v1/infer', payload: { ...BODY, modelChoiceId: 'gpt-5' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'model_not_allowed' } });
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers a jurisdiction refusal with 403, having sent nothing', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const { app } = server({ fetch: fetchSpy }, { allowedJurisdictions: ['EU'] });
    const res = await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      error: { code: 'jurisdiction_not_allowed', callId: 'call-fixed' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers a firm misconfiguration with 503 and a callId to quote to IT', async () => {
    const { app } = server({
      fetch: async () => ({
        status: 401, ok: false, body: null,
        json: async () => ({ error: { message: 'Access denied' } }),
        text: async () => '',
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      error: { code: 'service_misconfigured', callId: 'call-fixed' },
    });
    await app.close();
  });

  it('answers an unattributable request with 400 and makes no call', async () => {
    const fetchSpy = vi.fn(async () => ok('x'));
    const { app, sink } = server({ fetch: fetchSpy });
    const res = await app.inject({
      method: 'POST', url: '/v1/infer', payload: { ...BODY, actorSubject: undefined },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sink.records).toEqual([]);
    await app.close();
  });

  it('never lets a provider error body carry the credential into the response', async () => {
    const { app, sink } = server({
      fetch: async () => ({
        status: 401, ok: false, body: null,
        json: async () => ({ error: { message: 'Invalid key: kv-secret' } }),
        text: async () => '',
      }),
    });
    const res = await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(res.payload).not.toContain('kv-secret');
    expect(res.payload).toContain('[redacted]');
    expect(JSON.stringify(sink.records)).not.toContain('kv-secret');
    await app.close();
  });

  it('writes a started and a finished record for every request that reaches the route', async () => {
    const { app, sink } = server({ fetch: async () => ok('It does.') });
    await app.inject({ method: 'POST', url: '/v1/infer', payload: BODY });
    expect(sink.records.map(r => r.kind)).toEqual(['call.started', 'call.finished']);
    expect(sink.records[0]).toMatchObject({
      workspaceId: 'ws-1', actorSubject: 'oid-1', purpose: 'review.clause', streaming: false,
    });
    // Metadata, never content: the prompt is present only as a hash.
    expect(JSON.stringify(sink.records)).not.toContain('cap liability');
    await app.close();
  });
});

describe('GET /v1/models', () => {
  it('returns the allowlist stripped of everything a browser may not see', async () => {
    const { app } = server({ fetch: async () => ok('x') });
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(200);
    const payload = JSON.stringify(res.json());
    expect(payload).not.toContain('services.ai.azure.com');
    expect(payload).not.toContain('vault.azure.net');
    expect(payload).not.toContain('credential');
    expect(payload).not.toContain('apiVersion');
    expect(res.json()).toEqual({
      models: [{
        id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
        jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
        contextLength: 128000, supportsImages: true, supportsStructuredOutput: true,
        isDefault: true,
        dataHandling: { summary: 'No training on our data.', lastCheckedAt: '2026-01-04' },
      }],
    });
    await app.close();
  });
});
