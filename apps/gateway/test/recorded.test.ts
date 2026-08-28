import { describe, it, expect } from 'vitest';
import { makeRecordedAdapter } from '../src/adapters/recorded.ts';
import { loadConfig } from '../src/config.ts';
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';

const RECORDED_JURISDICTION = {
  bloc: 'other' as const, region: 'local',
  label: 'this machine — recorded responses, not a model',
};

const entry: ModelEntry = {
  id: 'offline', provider: 'recorded', model: 'recorded', label: 'Recorded responses (offline)',
  jurisdiction: RECORDED_JURISDICTION,
  contextLength: 128000, supportsImages: true, supportsStructuredOutput: true, isDefault: true,
  endpoint: 'file:///fixtures/recorded',
  credential: { source: 'env', var: 'UNUSED' },
};

const files: Record<string, string> = {
  'fixtures/recorded/review.clause.json': JSON.stringify({
    choices: [{ message: { content: '{"summary":"RECORDED - this is a stored development response, not a review.","riskLevel":"low"}' } }],
    usage: { prompt_tokens: 5, completion_tokens: 9 },
  }),
  'fixtures/recorded/default.json': JSON.stringify({
    choices: [{ message: { content: 'RECORDED - this is a stored development response, not a review.' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }),
};
const read = (path: string) => {
  const body = files[path.replace(/\\/g, '/')];
  if (!body) throw new Error(`ENOENT ${path}`);
  return body;
};

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry, user: 'hi', maxTokens: 4096, stream: false, ...over,
});

describe('the recorded adapter is an adapter (spec Revision 2, §5.1)', () => {
  const a = makeRecordedAdapter('fixtures/recorded', read);

  it('is registered under the provider id `recorded`', () => {
    expect(a.id).toBe('recorded');
  });

  it('implements the same three functions as every other adapter', () => {
    expect(typeof a.buildCall).toBe('function');
    expect(typeof a.readResponse).toBe('function');
    expect(typeof a.decodeEvent).toBe('function');
  });

  it('decodes an OpenAI-shaped event, so it passes adapterConformance unmodified', () => {
    expect(a.decodeEvent('data: {"choices":[{"delta":{"content":"Hi"}}]}'))
      .toEqual({ kind: 'delta', text: 'Hi' });
    expect(a.decodeEvent('data: [DONE]')).toEqual({ kind: 'end' });
  });

  it('routes buildCall to the fixture chosen by the purpose, and to default otherwise', () => {
    expect(a.buildCall(req({ purpose: 'review.clause' } as never), { kind: 'api-key', key: '' }).url)
      .toBe('fixtures/recorded/review.clause.json');
    expect(a.buildCall(req({ purpose: 'export.email' } as never), { kind: 'api-key', key: '' }).url)
      .toBe('fixtures/recorded/default.json');
  });

  it('carries no credential into its headers, because it needs none', () => {
    const call = a.buildCall(req(), { kind: 'api-key', key: 'sk-should-not-appear' });
    expect(JSON.stringify(call.headers)).not.toContain('sk-should-not-appear');
  });

  it('THROWS on a missing fixture rather than answering empty', () => {
    const bare = makeRecordedAdapter('fixtures/recorded', () => { throw new Error('ENOENT'); });
    expect(() => bare.readResponse(bare.buildCall(req(), { kind: 'api-key', key: '' })))
      .toThrow(/no recorded fixture/i);
  });

  it('THROWS when a fixture has no message content, like every other adapter', () => {
    const empty = makeRecordedAdapter('d', () => JSON.stringify({ choices: [] }));
    expect(() => empty.readResponse({ choices: [] })).toThrow(/no message content/i);
  });

  // Not asked for verbatim by the brief, but load-bearing: a streamed call
  // must not be handed the non-streamed `.json` fixture — the SSE reader on
  // the other end would try to parse a whole JSON document as an event
  // stream and silently produce nothing.
  it('routes a streamed call to the streams/ directory, never to the .json fixture', () => {
    const streamFiles: Record<string, string> = {
      'fixtures/recorded/streams/assistant.chat.txt': ': synthetic\n\ndata: [DONE]\n\n',
    };
    const streamRead = (p: string) => {
      const body = streamFiles[p.replace(/\\/g, '/')];
      if (!body) throw new Error(`ENOENT ${p}`);
      return body;
    };
    const a2 = makeRecordedAdapter('fixtures/recorded', streamRead);
    const call = a2.buildCall(
      req({ purpose: 'assistant.chat', stream: true } as never), { kind: 'api-key', key: '' },
    );
    expect(call.url).toBe('fixtures/recorded/streams/assistant.chat.txt');
  });
});

describe('S27 refuses it in a firm deployment, through the mechanism that already exists', () => {
  const modelsFile = (jurisdiction: unknown) => JSON.stringify({
    models: [{ ...entry, jurisdiction }],
  });
  const BASE = {
    GATEWAY_PORT: '8081', GATEWAY_MODELS_FILE: '/m.json',
    // A recorded model must still pass the SAME caller-auth gate as any
    // other deployment — there is no `GATEWAY_CALLER_AUTH` value that
    // disables the caller check (S29's shape, applied to the gateway's own
    // front door; see config.ts's `parseCaller`), so 'none' is not a legal
    // value here and would fail every test below on the wrong assertion.
    GATEWAY_CALLER_AUTH: 'mtls',
    GATEWAY_MTLS_CA_FILE: '/certs/ca.pem',
    GATEWAY_MTLS_CERT_FILE: '/certs/gateway.pem',
    GATEWAY_MTLS_KEY_FILE: '/certs/gateway.key',
    GATEWAY_MTLS_ALLOWED_SUBJECT: 'lexprompt-api',
  };
  const read1 = (body: string) => () => body;

  // No new guard. The jurisdiction gate P4 already built does the whole job.
  it('a deployment that has not declared `other` refuses to start with it, naming it', () => {
    expect(() => loadConfig({ ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU' },
      read1(modelsFile(RECORDED_JURISDICTION))))
      .toThrow(/offline[\s\S]*recorded[\s\S]*other[\s\S]*GATEWAY_ALLOWED_JURISDICTIONS/);
  });

  it('starts only when the operator wrote `other` into the allowed set themselves', () => {
    const cfg = loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU,other' },
      read1(modelsFile(RECORDED_JURISDICTION)),
    );
    expect(cfg.models[0].provider).toBe('recorded');
  });

  // The one thing a recorded adapter must not be allowed to do: hide.
  it('refuses a recorded entry that declares a real-looking jurisdiction', () => {
    expect(() => loadConfig(
      { ...BASE, GATEWAY_ALLOWED_JURISDICTIONS: 'UK,EU' },
      read1(modelsFile({ bloc: 'UK', region: 'uksouth', label: 'UK South' })),
    )).toThrow(/recorded[\s\S]*must declare/i);
  });
});
