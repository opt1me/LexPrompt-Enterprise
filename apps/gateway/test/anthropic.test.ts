import { describe, it, expect } from 'vitest';
import { anthropicAdapter as a } from '../src/adapters/anthropic.ts';
import type { ModelEntry } from '../src/config.ts';
import type { AdapterRequest } from '../src/adapters/types.ts';
import { isRetryableStatus } from '@lexprompt/core';

const entry: ModelEntry = {
  id: 'claude', provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude',
  jurisdiction: { bloc: 'US', region: 'us', label: 'United States' },
  contextLength: 200000, supportsImages: true, supportsStructuredOutput: true, isDefault: false,
  endpoint: 'https://api.anthropic.com',
  credential: { source: 'env', var: 'K' },
};

const req = (over: Partial<AdapterRequest> = {}): AdapterRequest => ({
  entry, system: 'You are a contract reviewer.', user: 'Summarise clause 14.',
  maxTokens: 4096, stream: false, ...over,
});

describe('anthropic buildCall — the four differences, all here', () => {
  it('uses /v1/messages, the x-api-key header and a version header', () => {
    const call = a.buildCall(req(), { kind: 'api-key', key: 'sk-ant-1' });
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe('sk-ant-1');
    expect(call.headers['anthropic-version']).toBe('2023-06-01');
    expect('Authorization' in call.headers).toBe(false);
  });

  it('DIFFERENCE 1: system is a top-level parameter, not a message', () => {
    const body = a.buildCall(req(), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect(body.system).toBe('You are a contract reviewer.');
    expect(body.messages).toEqual([{ role: 'user', content: 'Summarise clause 14.' }]);
  });

  it('omits system entirely when there is none', () => {
    const body = a.buildCall(req({ system: undefined }), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect('system' in body).toBe(false);
  });

  it('DIFFERENCE 2: max_tokens is always sent, because Anthropic requires it', () => {
    expect((a.buildCall(req(), { kind: 'api-key', key: 'k' }).body as { max_tokens: number }).max_tokens)
      .toBe(4096);
  });

  it('DIFFERENCE 3: images are base64 source blocks, not image_url parts', () => {
    const body = a.buildCall(
      req({ images: [{ mime: 'image/png', data: 'AAA' }] }), { kind: 'api-key', key: 'k' },
    ).body as { messages: { content: unknown }[] };
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'Summarise clause 14.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ]);
  });

  it('DIFFERENCE 4: a JSON schema becomes a forced tool call', () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } } };
    const body = a.buildCall(req({ jsonSchema: schema }), { kind: 'api-key', key: 'k' }).body as Record<string, unknown>;
    expect(body.tools).toEqual([{ name: 'result', description: 'Return the result.', input_schema: schema }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'result' });
    expect('response_format' in body).toBe(false);
  });

  it('handles a bearer credential too, mapping it into x-api-key rather than Authorization', () => {
    const call = a.buildCall(req(), { kind: 'bearer', token: 'mi-token' });
    expect(call.headers['x-api-key']).toBe('mi-token');
    expect('Authorization' in call.headers).toBe(false);
  });
});

describe('anthropic readResponse', () => {
  it('reads a text block and maps usage', () => {
    expect(a.readResponse({
      content: [{ type: 'text', text: 'Answer.' }],
      usage: { input_tokens: 10, output_tokens: 4 },
    })).toEqual({
      content: 'Answer.',
      usage: { promptTokens: 10, completionTokens: 4 },
      // No `stop_reason` on the body, so `unknown` — never `stop`.
      stopReason: 'unknown',
    });
  });

  it('joins several text blocks in order', () => {
    expect(a.readResponse({
      content: [{ type: 'text', text: 'One. ' }, { type: 'text', text: 'Two.' }],
    }).content).toBe('One. Two.');
  });

  // The whole point of the forced tool call: the gateway's contract is that
  // `content` is a string, and parseJsonLoose is the caller's fallback. A
  // tool-use answer is re-serialised so nothing downstream learns which
  // provider answered.
  it('re-serialises a tool-use answer to JSON, so the contract is unchanged', () => {
    expect(a.readResponse({
      content: [{ type: 'tool_use', name: 'result', input: { summary: 'Silent.', risk: 'low' } }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }).content).toBe('{"summary":"Silent.","risk":"low"}');
  });

  it('THROWS when there is no text and no tool use, rather than returning an empty answer', () => {
    expect(() => a.readResponse({ content: [] })).toThrow(/no message content/i);
  });
});

describe('anthropic decodeEvent (pure, no network)', () => {
  // Returns an ARRAY: `message_delta` carries the final output-token count
  // AND `delta.stop_reason` — the only place an Anthropic stream says
  // whether the answer was cut off at `max_tokens` — so one raw event has
  // to be able to decode to two.
  it('reads a content_block_delta as a delta', () => {
    expect(a.decodeEvent('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}'))
      .toEqual([{ kind: 'delta', text: 'Hi' }]);
  });

  it('reads input_json_delta (a streamed tool call) as a delta too', () => {
    expect(a.decodeEvent('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}'))
      .toEqual([{ kind: 'delta', text: '{"a":' }]);
  });

  it('reads input tokens from message_start', () => {
    expect(a.decodeEvent('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":91,"output_tokens":0}}}'))
      .toEqual([{ kind: 'usage', usage: { promptTokens: 91, completionTokens: 0 } }]);
  });

  it('reads output tokens from message_delta', () => {
    expect(a.decodeEvent('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":37}}'))
      .toEqual([{ kind: 'usage', usage: { promptTokens: 0, completionTokens: 37 } }]);
  });

  // ==================================================================
  // C1, Anthropic's spelling of it. `max_tokens` is what `finish_reason:
  // "length"` is on the OpenAI-shaped providers, and both normalise inside
  // their own adapter so `truncationRefusal` sees one vocabulary.
  // ==================================================================
  it('reads message_delta stop_reason: "max_tokens" as a length stop, alongside the usage', () => {
    expect(a.decodeEvent('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":4096}}'))
      .toEqual([
        { kind: 'usage', usage: { promptTokens: 0, completionTokens: 4096 } },
        { kind: 'stop', reason: 'length' },
      ]);
  });

  it('reads stop_reason: "end_turn" as a clean stop and "refusal" as other', () => {
    expect(a.decodeEvent('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}')[1])
      .toEqual({ kind: 'stop', reason: 'stop' });
    expect(a.decodeEvent('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":3}}')[1])
      .toEqual({ kind: 'stop', reason: 'other' });
  });

  it('reads message_stop as the end of the stream', () => {
    expect(a.decodeEvent('event: message_stop\ndata: {"type":"message_stop"}'))
      .toEqual([{ kind: 'end' }]);
  });

  it('reads an error event as an error, not as content', () => {
    expect(a.decodeEvent('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'))
      .toEqual([{ kind: 'error', status: 529, message: 'Overloaded' }]);
  });

  // The status is what `isRetryableStatus` (429 || >= 500) reads, so a
  // permanent failure flattened to 502 would be retried and then reported
  // as a transient provider problem rather than the misconfiguration it
  // is. These assert the retry CONSEQUENCE, not just the number, because
  // the number is only interesting for what it causes.
  it('maps a permanent Anthropic error to a status that is NOT retried', () => {
    const permanent = [
      ['invalid_request_error', 400],
      ['authentication_error', 401],
      ['permission_error', 403],
      ['not_found_error', 404],
      ['request_too_large', 413],
    ] as const;
    for (const [type, status] of permanent) {
      const raw = `event: error\ndata: {"type":"error","error":{"type":"${type}","message":"m"}}`;
      expect(a.decodeEvent(raw)).toEqual([{ kind: 'error', status, message: 'm' }]);
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('maps a transient Anthropic error to a status that IS retried', () => {
    const transient = [
      ['rate_limit_error', 429],
      ['api_error', 500],
      ['overloaded_error', 529],
    ] as const;
    for (const [type, status] of transient) {
      const raw = `event: error\ndata: {"type":"error","error":{"type":"${type}","message":"m"}}`;
      expect(a.decodeEvent(raw)).toEqual([{ kind: 'error', status, message: 'm' }]);
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it('falls back to 502 for an error type it does not recognise', () => {
    const raw = 'event: error\ndata: {"type":"error","error":{"type":"a_new_error","message":"m"}}';
    expect(a.decodeEvent(raw)).toEqual([{ kind: 'error', status: 502, message: 'm' }]);
  });

  // m3. The status table is a `Map`, not an object literal: an object
  // literal resolves INHERITED keys, so `error.type === "constructor"`
  // returned a truthy *function* that travelled onwards as the status.
  it('does not resolve a prototype key as an error status', () => {
    for (const type of ['constructor', 'toString', 'hasOwnProperty']) {
      const raw = `event: error\ndata: {"type":"error","error":{"type":"${type}","message":"m"}}`;
      expect(a.decodeEvent(raw)).toEqual([{ kind: 'error', status: 502, message: 'm' }]);
    }
  });

  it('returns nothing for ping, for content_block_start and for malformed JSON', () => {
    expect(a.decodeEvent('event: ping\ndata: {"type":"ping"}')).toEqual([]);
    expect(a.decodeEvent('event: content_block_start\ndata: {"type":"content_block_start"}')).toEqual([]);
    expect(a.decodeEvent('event: content_block_delta\ndata: {not json')).toEqual([]);
  });

  it('never puts the credential anywhere the caller might log — headers only', () => {
    const call = a.buildCall(req(), { kind: 'api-key', key: 'sk-super-secret' });
    expect(call.url.includes('sk-super-secret')).toBe(false);
    expect(JSON.stringify(call.body).includes('sk-super-secret')).toBe(false);
    expect(JSON.stringify(call.headers).includes('sk-super-secret')).toBe(true);
  });
});
