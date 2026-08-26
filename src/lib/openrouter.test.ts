import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chat, chatJson, listModels, parseJsonLoose, OpenRouterError } from './openrouter';

const KEY = 'test-key';
const req = { apiKey: KEY, modelId: 'test/model', user: 'hello' };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function completion(content: string) {
  return jsonResponse({ choices: [{ message: { content } }] });
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('parseJsonLoose', () => {
  it('parses clean JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('recovers JSON wrapped in a prose preamble', () => {
    expect(parseJsonLoose('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('recovers JSON inside a fenced code block', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('handles nested braces and braces inside strings', () => {
    expect(parseJsonLoose('x {"a":{"b":"}"},"c":2} y')).toEqual({ a: { b: '}' }, c: 2 });
  });

  it('throws a readable error when there is no JSON at all', () => {
    expect(() => parseJsonLoose('no json here')).toThrow(/could not parse/i);
  });

  // Finding 2 (fix round 1): the first `{` candidate can fail to parse (it
  // isn't really JSON) while a real JSON object sits later in the text.
  // Must not give up after the first failed candidate.
  it('skips a non-JSON first brace and finds a later valid object', () => {
    expect(parseJsonLoose('Cost is {approx} then {"a":1}')).toEqual({ a: 1 });
  });

  // Finding 2 (fix round 1): when multiple balanced, independently-valid JSON
  // objects are present, the LAST one is the model's real answer (an example
  // shown before it is a decoy). Returning the first is a silent wrong-answer
  // bug, not a crash — the dangerous kind for a contract review tool.
  it('returns the LAST balanced object when multiple valid JSON objects are present', () => {
    const text = 'Example: {"a":1} Real answer: {"a":2}';
    expect(parseJsonLoose(text)).toEqual({ a: 2 });
  });

  it('throws on a truncated/unclosed-brace response rather than returning junk', () => {
    expect(() => parseJsonLoose('Sure, {"a":1')).toThrow(/could not parse/i);
  });
});

describe('chat', () => {
  it('sends the key as a bearer token and returns the message content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('hi there'));
    vi.stubGlobal('fetch', fetchMock);

    expect(await chat(req)).toBe('hi there');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(init.body).model).toBe('test/model');
  });

  it('fails immediately on 401 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad key' } }, 401));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat(req)).rejects.toThrow(OpenRouterError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails immediately on 402 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'no credit' } }, 402));
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat(req)).rejects.toThrow(/credit/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 429 and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'slow down' } }, 429))
      .mockResolvedValueOnce(completion('recovered'));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a 500 and gives up after the retry budget', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'oops' } }, 500));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    const assertion = expect(p).rejects.toThrow(OpenRouterError);
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('marks the error retryable only for transient statuses', async () => {
    // Finding 3 (fix round 1): the previous version used .catch(e => {...})
    // with no `rejects` guard, so if chat() ever resolved instead of
    // rejecting, the assertions inside .catch simply never ran and the test
    // passed green regardless. Using `.rejects.toMatchObject` forces a
    // failure if chat() resolves.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, 401)));
    await expect(chat(req)).rejects.toMatchObject({ status: 401, retryable: false });
  });

  // Finding 1 (fix round 1): a network-level fetch rejection (offline, DNS
  // failure, TypeError: Failed to fetch) must not bypass the retry policy or
  // propagate as a raw TypeError — downstream callers read `.status` and
  // `.retryable` on every error from this module.
  it('wraps a network-level fetch rejection in a retryable OpenRouterError and retries the full budget', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    const assertion = expect(p).rejects.toMatchObject({ name: 'OpenRouterError', status: 0, retryable: true });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('recovers from a transient network error on retry', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(completion('recovered'));
    vi.stubGlobal('fetch', fetchMock);

    const p = chat(req);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Finding 4 (fix round 2): the network-error catch added for finding 1 was
  // unconditional, so a user-initiated cancellation (AbortController.abort())
  // got wrapped as a retryable OpenRouterError and retried 3 times over ~3s
  // instead of failing immediately. A cancellation is a deliberate user
  // decision, not a transient fault, and retrying it makes the UI appear to
  // keep working during the exact window the user might click Cancel again.
  it('propagates an abort immediately, without retrying, when the request is cancelled', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await expect(chat(req, controller.signal)).rejects.toBe(abortError);
    // The call-count assertion is the important half: without it, this test
    // would still pass even if the retry loop kept running underneath.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('includes a json_schema response format when a schema is supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    await chatJson({ ...req, jsonSchema: { type: 'object', properties: { ok: { type: 'boolean' } } } });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.type).toBe('object');
  });

  it('attaches images as image_url content parts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ ...req, images: [{ mime: 'image/jpeg', data: 'AAAA' }] });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const parts = body.messages.at(-1).content;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some((p: { type: string }) => p.type === 'image_url')).toBe(true);
  });

  it('prepends the system message when one is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion('ok'));
    vi.stubGlobal('fetch', fetchMock);

    await chat({ ...req, system: 'be terse' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be terse' });
  });

  it('rejects when no API key is set, before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(chat({ ...req, apiKey: '' })).rejects.toThrow(/api key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chatJson parses a schema-shaped response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(completion('{"summary":"s","citations":[]}')));
    expect(await chatJson<{ summary: string }>(req)).toEqual({ summary: 's', citations: [] });
  });
});

describe('listModels', () => {
  it('maps the models envelope into ModelInfo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{
        id: 'anthropic/claude-sonnet-4.5',
        name: 'Claude Sonnet 4.5',
        context_length: 200000,
        pricing: { prompt: '0.000003', completion: '0.000015' },
        supported_parameters: ['response_format', 'structured_outputs'],
        architecture: { input_modalities: ['text', 'image'] },
      }],
    })));

    const models = await listModels();
    expect(models[0].id).toBe('anthropic/claude-sonnet-4.5');
    expect(models[0].contextLength).toBe(200000);
    expect(models[0].supportsStructuredOutput).toBe(true);
    expect(models[0].supportsImages).toBe(true);
  });

  it('tolerates entries with missing optional fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'x/y' }] })));
    const models = await listModels();
    expect(models[0].supportsStructuredOutput).toBe(false);
    expect(models[0].supportsImages).toBe(false);
    expect(models[0].contextLength).toBe(0);
  });

  it('supports response_format WITHOUT structured_outputs is NOT schema-capable', async () => {
    // Correction #1 (overrides brief): supportsStructuredOutput must test
    // structured_outputs ONLY. Of 417 live models, 37 advertise response_format
    // but not structured_outputs (a weaker {type:'json_object'} capability) and
    // must not be reported as schema-capable, since chat() always sends a
    // strict json_schema payload when jsonSchema is supplied.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: 'weak/model', supported_parameters: ['response_format'] }],
    })));
    const models = await listModels();
    expect(models[0].supportsStructuredOutput).toBe(false);
  });

  it('maps a negative sentinel price to null, not a negative number', async () => {
    // Correction #2 (overrides brief): pricing is per-single-token and -1 is a
    // "variable price" sentinel used by router/meta models (e.g.
    // openrouter/auto-beta). Number(pricing.prompt) would leak -1 into
    // ModelInfo; represent it as null instead.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: 'openrouter/auto-beta', pricing: { prompt: '-1', completion: '-1' } }],
    })));
    const models = await listModels();
    expect(models[0].promptPrice).toBeNull();
    expect(models[0].completionPrice).toBeNull();
  });

  it('treats a real zero price as a valid free price, not null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({
      data: [{ id: 'stealth/ox-alpha', pricing: { prompt: '0', completion: '0' } }],
    })));
    const models = await listModels();
    expect(models[0].promptPrice).toBe(0);
    expect(models[0].completionPrice).toBe(0);
  });

  it('tolerates a missing pricing object entirely', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'x/y' }] })));
    const models = await listModels();
    expect(models[0].promptPrice).toBeNull();
    expect(models[0].completionPrice).toBeNull();
  });
});
