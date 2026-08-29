import { describe, it, expect } from 'vitest';
import { buildRegistry, PENDING } from '../src/adapters/registry.ts';
import { PROVIDER_IDS, isRetryableStatus } from '@lexprompt/core';

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

  // `recorded` used to be this test's live example of a PENDING id; Task 13
  // registered it and emptied PENDING to `[]`, so the only kind of
  // "unregistered id" left to prove a helpful throw for is one that is not
  // a real ProviderId at all — `config.ts`'s own `isProviderId` guard is
  // what actually keeps a PENDING id from reaching `registry.get` in
  // production, so this id is `never`-cast the same way `config.ts` would
  // never let a real one through unvalidated.
  it('throws for an unregistered id, naming what is pending, rather than returning undefined', () => {
    expect(() => registry.get('bedrock' as never)).toThrow(/bedrock/);
  });

  // `recorded` is registered like every other provider (Task 13) — the
  // regression this guards is the registry silently going back to treating
  // it as pending.
  it('registers `recorded`, not merely lists it in PROVIDER_IDS', () => {
    expect(() => registry.get('recorded')).not.toThrow();
    expect(registry.get('recorded').id).toBe('recorded');
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
    })).toEqual({
      content: 'Answer.',
      usage: { promptTokens: 10, completionTokens: 4 },
      // Absent `finish_reason` is `unknown`, NOT `stop`. A provider that
      // said nothing has told us nothing, and recording silence as "the
      // model chose to end" is the shape of failure this gateway exists to
      // refuse.
      stopReason: 'unknown',
    });
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

  // `decodeEvent` returns an ARRAY — zero or more events per raw event —
  // because one OpenAI chunk may carry both the last content delta and
  // `finish_reason`, and neither may be dropped in favour of the other.
  it('reads a content delta', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"Hi"}}]}'))
      .toEqual([{ kind: 'delta', text: 'Hi' }]);
  });

  it('reads a usage-only chunk', () => {
    expect(a.decodeEvent('data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}'))
      .toEqual([{ kind: 'usage', usage: { promptTokens: 9, completionTokens: 2 } }]);
  });

  it('reads the [DONE] sentinel as the end of the stream', () => {
    expect(a.decodeEvent('data: [DONE]')).toEqual([{ kind: 'end' }]);
  });

  it('reads a mid-stream error object as an error, not as content', () => {
    expect(a.decodeEvent('data: {"error":{"message":"upstream exploded","code":500}}'))
      .toEqual([{ kind: 'error', status: 500, message: 'upstream exploded' }]);
  });

  it('returns nothing for a keepalive, an empty delta and malformed JSON', () => {
    expect(a.decodeEvent(': ping')).toEqual([]);
    expect(a.decodeEvent('data: {"choices":[{"delta":{}}]}')).toEqual([]);
    expect(a.decodeEvent('data: {not json')).toEqual([]);
  });

  // ==================================================================
  // C1. The provider cut the answer off at the token ceiling, and the
  // gateway has to be able to KNOW that. Without a `stop` event the fact
  // never leaves this function, and half a clause analysis ending
  // mid-sentence is served as a complete one.
  // ==================================================================
  it('reads finish_reason: "length" as a length stop, not as the end of a good answer', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{},"finish_reason":"length"}]}'))
      .toEqual([{ kind: 'stop', reason: 'length' }]);
  });

  it('reads finish_reason: "stop" as a clean stop', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'))
      .toEqual([{ kind: 'stop', reason: 'stop' }]);
  });

  // The case a single-event return could not express, and the reason this
  // function returns an array. Dropping the delta loses the last token of
  // the answer; dropping the finish_reason serves a cut-off answer as a
  // whole one. Both are defects this project has already shipped once.
  it('keeps BOTH the delta and the stop when one chunk carries them together', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"…and fin"},"finish_reason":"length"}]}'))
      .toEqual([
        { kind: 'delta', text: '…and fin' },
        { kind: 'stop', reason: 'length' },
      ]);
  });

  it('reads a content_filter stop as `other`, never as `stop`', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}'))
      .toEqual([{ kind: 'stop', reason: 'other' }]);
  });

  // M2, same line. OpenAI's `error.code` is normally a STRING
  // ("invalid_api_key"), which `Number(...)` turned into NaN and the old
  // fallback turned into 502 — a retryable status for a permanently
  // rejected credential, retried three times and then reported as a
  // transient blip.
  it('maps a STRING error code to its real status rather than a retryable 502', () => {
    expect(a.decodeEvent('data: {"error":{"message":"bad key","code":"invalid_api_key"}}'))
      .toEqual([{ kind: 'error', status: 401, message: 'bad key' }]);
    expect(a.decodeEvent('data: {"error":{"message":"no","type":"authentication_error"}}'))
      .toEqual([{ kind: 'error', status: 401, message: 'no' }]);
    expect(isRetryableStatus(401)).toBe(false);
  });

  it('still falls back to 502 for an error it genuinely cannot classify', () => {
    expect(a.decodeEvent('data: {"error":{"message":"?","code":"something_new"}}'))
      .toEqual([{ kind: 'error', status: 502, message: '?' }]);
  });

  // An object literal would resolve inherited keys and hand back a truthy
  // *function* as the status.
  it('does not resolve a prototype key as a status or a stop reason', () => {
    expect(a.decodeEvent('data: {"error":{"message":"m","code":"constructor"}}'))
      .toEqual([{ kind: 'error', status: 502, message: 'm' }]);
    expect(a.decodeEvent('data: {"choices":[{"delta":{},"finish_reason":"toString"}]}'))
      .toEqual([{ kind: 'stop', reason: 'other' }]);
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
    expect(streamed).toEqual([{ kind: 'usage', usage: nonStreamed.usage }]);
  });
});
