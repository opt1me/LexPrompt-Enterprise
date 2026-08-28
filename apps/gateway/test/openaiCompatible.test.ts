import { describe, it, expect } from 'vitest';
import { buildRegistry, PENDING } from '../src/adapters/registry.ts';
import { PROVIDER_IDS } from '@lexprompt/core';

// One built registry for the whole file. Two adapters take configuration,
// so the registry is a factory rather than a constant (S25: an adapter is
// given its values, it never reads them).
const registry = buildRegistry({ publicOrigin: 'https://lexprompt.local', recordedDir: 'fixtures/recorded' });
const adapter = (id: Parameters<typeof registry.get>[0]) => registry.get(id);
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';
import type { ResolvedCredential } from '../src/credentials/types.ts';

const entry = (over: Partial<ModelEntry>): ModelEntry => ({
  id: 'e', provider: 'openai', model: 'gpt-4o', label: 'l',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'https://api.openai.com',
  credential: { source: 'env', var: 'K' },
  ...over,
});

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry: entry({}),
  system: 'You are a contract reviewer.',
  user: 'Summarise clause 14.',
  maxTokens: 4096,
  stream: false,
  ...over,
});

describe('the registry', () => {
  it('registers every provider id that is not on PENDING', () => {
    const expected = PROVIDER_IDS.filter(id => !PENDING.includes(id));
    expect(registry.all.map(a => a.id).sort()).toEqual([...expected].sort());
  });

  // PENDING cannot outlive its purpose: Task 9 and Task 13 each remove one
  // id in the commit that adds its adapter, and by Task 13 it is empty and
  // this same file asserts full coverage with no edit.
  it('PENDING names only real provider ids', () => {
    expect(PENDING.every(id => (PROVIDER_IDS as readonly string[]).includes(id))).toBe(true);
  });

  it('throws for an unregistered id, naming what is pending, rather than returning undefined', () => {
    expect(() => registry.get('recorded')).toThrow(/Not yet implemented: recorded/);
    expect(() => registry.get('bedrock' as never)).toThrow(/bedrock/);
  });
});

describe('OpenAI-compatible adapters — one body builder, four endpoints', () => {
  it('OpenAI direct: /v1/chat/completions with a bearer key', () => {
    const call = adapter('openai').buildCall(req(), { kind: 'api-key', key: 'sk-1' });
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer sk-1');
    expect(call.body).toMatchObject({
      model: 'gpt-4o',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a contract reviewer.' },
        { role: 'user', content: 'Summarise clause 14.' },
      ],
    });
  });

  it('OpenRouter: its own base, a bearer key, and the two identifying headers', () => {
    const e = entry({ provider: 'openrouter', endpoint: 'https://openrouter.ai/api', model: 'anthropic/claude-sonnet-4.5' });
    const call = adapter('openrouter').buildCall(req({ entry: e }), { kind: 'api-key', key: 'or-1' });
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(call.headers.Authorization).toBe('Bearer or-1');
    expect(call.headers['X-Title']).toBe('LexPrompt');
    expect((call.body as { model: string }).model).toBe('anthropic/claude-sonnet-4.5');
  });

  it('Azure OpenAI: the deployment path, api-version, and an api-key HEADER not a bearer', () => {
    const e = entry({
      provider: 'azure-openai', endpoint: 'https://firm.openai.azure.com',
      model: 'gpt4o-uks', apiVersion: '2024-10-21',
      jurisdiction: { bloc: 'UK', region: 'uksouth', label: 'UK South' },
    });
    const call = adapter('azure-openai').buildCall(req({ entry: e }), { kind: 'api-key', key: 'az-1' });
    expect(call.url).toBe('https://firm.openai.azure.com/openai/deployments/gpt4o-uks/chat/completions?api-version=2024-10-21');
    expect(call.headers['api-key']).toBe('az-1');
    expect('Authorization' in call.headers).toBe(false);
  });

  it('Azure OpenAI with a managed identity uses a bearer token and NO api-key header', () => {
    const e = entry({ provider: 'azure-openai', endpoint: 'https://firm.openai.azure.com', model: 'd', apiVersion: '2024-10-21' });
    const call = adapter('azure-openai').buildCall(req({ entry: e }), { kind: 'bearer', token: 'mi' });
    expect(call.headers.Authorization).toBe('Bearer mi');
    expect('api-key' in call.headers).toBe(false);
  });

  it('Azure Foundry: /models/chat/completions with api-version', () => {
    const e = entry({
      provider: 'azure-foundry', endpoint: 'https://firm.services.ai.azure.com',
      model: 'gpt-4o', apiVersion: '2024-05-01-preview',
    });
    const call = adapter('azure-foundry').buildCall(req({ entry: e }), { kind: 'bearer', token: 'mi' });
    expect(call.url).toBe('https://firm.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview');
    expect(call.headers.Authorization).toBe('Bearer mi');
  });

  it('trims a trailing slash off the configured endpoint rather than producing a double slash', () => {
    const call = adapter('openai').buildCall(
      req({ entry: entry({ endpoint: 'https://api.openai.com/' }) }), { kind: 'api-key', key: 'k' });
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('omits the system message when there is none, rather than sending an empty one', () => {
    const call = adapter('openai').buildCall(req({ system: undefined }), { kind: 'api-key', key: 'k' });
    expect((call.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it('attaches images as image_url content parts', () => {
    const call = adapter('openai').buildCall(
      req({ images: [{ mime: 'image/png', data: 'AAA' }] }), { kind: 'api-key', key: 'k' });
    const messages = (call.body as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Summarise clause 14.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('sends a strict json_schema response format when a schema is supplied', () => {
    const call = adapter('openai').buildCall(
      req({ jsonSchema: { type: 'object', properties: {} } }), { kind: 'api-key', key: 'k' });
    expect((call.body as { response_format: unknown }).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: {} } },
    });
  });

  it('sets stream and stream_options so usage arrives on a streamed call', () => {
    const call = adapter('openai').buildCall(req({ stream: true }), { kind: 'api-key', key: 'k' });
    expect(call.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('omits temperature when the caller did not set one', () => {
    const body = adapter('openai').buildCall(req(), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
  });
});

describe('OpenAI-compatible readResponse', () => {
  const a = adapter('openai');

  it('reads content and usage', () => {
    expect(a.readResponse({
      choices: [{ message: { content: 'Answer.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    })).toEqual({ content: 'Answer.', usage: { promptTokens: 10, completionTokens: 4 } });
  });

  it('reports zero usage rather than NaN when a provider omits it', () => {
    expect(a.readResponse({ choices: [{ message: { content: 'x' } }] }).usage)
      .toEqual({ promptTokens: 0, completionTokens: 0 });
  });

  it('THROWS when there is no message content, rather than returning an empty answer', () => {
    expect(() => a.readResponse({ choices: [] })).toThrow(/no message content/i);
    expect(() => a.readResponse({ choices: [{ message: {} }] })).toThrow(/no message content/i);
  });
});

describe('OpenAI-compatible decodeEvent (pure, no network)', () => {
  const a = adapter('openai');

  it('reads a content delta', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"Hi"}}]}'))
      .toEqual({ kind: 'delta', text: 'Hi' });
  });

  it('reads a usage-only chunk', () => {
    expect(a.decodeEvent('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}'))
      .toEqual({ kind: 'usage', usage: { promptTokens: 9, completionTokens: 2 } });
  });

  it('reads the [DONE] sentinel as the end of the stream', () => {
    expect(a.decodeEvent('data: [DONE]')).toEqual({ kind: 'end' });
  });

  it('reads a mid-stream error object as an error, not as content', () => {
    expect(a.decodeEvent('data: {"error":{"message":"upstream exploded","code":500}}'))
      .toEqual({ kind: 'error', status: 500, message: 'upstream exploded' });
  });

  it('returns null for a keepalive, an empty delta and malformed JSON', () => {
    expect(a.decodeEvent(': ping')).toBe(null);
    expect(a.decodeEvent('data: {"choices":[{"delta":{}}]}')).toBe(null);
    expect(a.decodeEvent('data: {not json')).toBe(null);
  });
});

// --- Credential hygiene and streamed/non-streamed agreement ----------------
//
// Neither of these is asked for verbatim by the brief, but both are named as
// load-bearing by the dispatching task: "the strip that keeps credentials
// out of AdapterCall's description" and "the streamed/non-streamed
// agreement". An adapter's headers MUST carry the credential (the request
// cannot be made otherwise) — what must never happen is the credential
// leaking into the URL or body, which is the part of an AdapterCall that a
// caller might reasonably log or serialise for debugging without redacting.
describe('credential hygiene — a secret never leaks into url or body', () => {
  const secret = 'sk-super-secret-value';

  const cases: { name: Parameters<typeof registry.get>[0]; entry: Partial<ModelEntry>; credential: ResolvedCredential }[] = [
    { name: 'openai', entry: {}, credential: { kind: 'api-key', key: secret } },
    {
      name: 'openrouter',
      entry: { provider: 'openrouter', endpoint: 'https://openrouter.ai/api' },
      credential: { kind: 'api-key', key: secret },
    },
    {
      name: 'azure-openai',
      entry: { provider: 'azure-openai', endpoint: 'https://firm.openai.azure.com', apiVersion: '2024-10-21' },
      credential: { kind: 'bearer', token: secret },
    },
    {
      name: 'azure-foundry',
      entry: { provider: 'azure-foundry', endpoint: 'https://firm.services.ai.azure.com', apiVersion: '2024-05-01-preview' },
      credential: { kind: 'bearer', token: secret },
    },
  ];

  for (const { name, entry: over, credential } of cases) {
    it(`${name}: the credential appears only in headers, never in url or body`, () => {
      const call = adapter(name).buildCall(req({ entry: entry(over) }), credential);
      expect(call.url.includes(secret)).toBe(false);
      expect(JSON.stringify(call.body).includes(secret)).toBe(false);
      // Sanity: the credential really was placed somewhere, or this test
      // would pass vacuously against an adapter that dropped it entirely.
      expect(JSON.stringify(call.headers).includes(secret)).toBe(true);
    });
  }
});

describe('streamed and non-streamed usage agreement', () => {
  // The same provider payload shape reports usage under prompt_tokens /
  // completion_tokens whether it arrives as a full JSON response body or as
  // the final field of a streamed chunk. readResponse and decodeEvent must
  // normalise it identically — a divergence here would mean a review's
  // recorded cost depends on whether the call happened to stream.
  it('readResponse and decodeEvent normalise identical prompt/completion counts the same way', () => {
    const a = adapter('openai');
    const nonStreamed = a.readResponse({
      choices: [{ message: { content: 'x' } }],
      usage: { prompt_tokens: 42, completion_tokens: 7 },
    });
    const streamed = a.decodeEvent(
      'data: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":7}}',
    );
    expect(streamed).toEqual({ kind: 'usage', usage: nonStreamed.usage });
  });
});
