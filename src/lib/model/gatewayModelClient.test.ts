import { describe, it, expect, vi } from 'vitest';
import {
  ModelError, encodeFrame, isServiceConfigError, isSignInError,
  type AllowedModel, type InferRequest, type Jurisdiction, type ModelClient,
} from '@lexprompt/core';
import { makeGatewayModelClient } from './gatewayModelClient';

const TOKEN = 'test-access-token';
const BASE = 'https://api.example.test';

const UK_SOUTH: Jurisdiction = { bloc: 'UK', region: 'uksouth', label: 'UK South' };

const REQ: InferRequest = {
  modelChoiceId: 'uks-gpt4o',
  purpose: 'review.clause',
  user: 'What does clause 4 say?',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function inferResponse(content: string): Response {
  return jsonResponse({
    content,
    usage: { promptTokens: 12, completionTokens: 4 },
    callId: 'call-7',
    provider: 'azure-foundry',
    jurisdiction: UK_SOUTH,
  });
}

/** An SSE body built from real frames, so the browser reads exactly what
 *  `apps/gateway` writes rather than a hand-shaped approximation of it. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status, headers: { 'content-type': 'text/event-stream' },
  });
}

const DONE = encodeFrame({
  type: 'done',
  usage: { promptTokens: 5, completionTokens: 2 },
  callId: 'call-9',
  provider: 'azure-foundry',
  jurisdiction: UK_SOUTH,
});

interface Harness {
  client: ModelClient;
  fetchMock: ReturnType<typeof vi.fn>;
  getToken: ReturnType<typeof vi.fn>;
}

function harness(
  responder: (...args: unknown[]) => unknown,
  getToken: () => Promise<string> = () => Promise.resolve(TOKEN),
): Harness {
  const fetchMock = vi.fn(responder as never);
  const tokenMock = vi.fn(getToken as never);
  return {
    fetchMock,
    getToken: tokenMock,
    client: makeGatewayModelClient({
      baseUrl: BASE,
      getToken: tokenMock as unknown as () => Promise<string>,
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    }),
  };
}

function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[0][1] as RequestInit;
}

function authHeader(fetchMock: ReturnType<typeof vi.fn>): string | undefined {
  return (lastInit(fetchMock).headers as Record<string, string> | undefined)?.Authorization;
}

describe('chat', () => {
  it('POSTs to /v1/infer with the bearer token and returns the parsed InferResponse', async () => {
    const { client, fetchMock } = harness(() => inferResponse('the answer'));

    const result = await client.chat(REQ);

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v1/infer`);
    expect(lastInit(fetchMock).method).toBe('POST');
    expect(authHeader(fetchMock)).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({
      content: 'the answer',
      usage: { promptTokens: 12, completionTokens: 4 },
      callId: 'call-7',
      provider: 'azure-foundry',
      jurisdiction: UK_SOUTH,
    });
  });

  it('sends purpose, modelChoiceId and context through unchanged, and never an apiKey or a modelId', async () => {
    const { client, fetchMock } = harness(() => inferResponse('ok'));

    await client.chat({
      ...REQ,
      context: { matterId: 'm1', reviewId: 'r1', clauseId: 'c1', documentIds: ['d1', 'd2'] },
    });

    const sentBody = lastInit(fetchMock).body as string;
    expect(JSON.parse(sentBody)).toMatchObject({
      modelChoiceId: 'uks-gpt4o',
      purpose: 'review.clause',
      context: { matterId: 'm1', reviewId: 'r1', clauseId: 'c1', documentIds: ['d1', 'd2'] },
    });
    // The whole point of Stage 1: neither a user's key nor a provider-side
    // model name may leave this browser.
    expect(sentBody).not.toContain('apiKey');
    expect(sentBody).not.toContain('modelId');
  });

  it('makes no request at all when no token can be acquired', async () => {
    const { client, fetchMock } = harness(
      () => inferResponse('ok'),
      () => Promise.reject(new ModelError('Sign in again.', 'sign_in_required', 401)),
    );

    await expect(client.chat(REQ)).rejects.toMatchObject({ code: 'sign_in_required' });
    // An unauthenticated request would come back as an anonymous 401, which
    // reads as "you have no access" rather than "sign in again".
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chatJson', () => {
  it('runs the response content through parseJsonLoose, so prose around the JSON still parses', async () => {
    const { client } = harness(() => inferResponse(
      'Sure! Here you go:\n```json\n{"summary":"s","citations":[]}\n```',
    ));

    expect(await client.chatJson<{ summary: string }>(REQ))
      .toEqual({ summary: 's', citations: [] });
  });

  it('works when destructured off the client rather than called as a method', async () => {
    // A `this.chat(...)` implementation would be `undefined` here, and every
    // call site and test mock that destructures would break at runtime with
    // nothing failing at compile time.
    const { client } = harness(() => inferResponse('{"ok":true}'));
    const { chatJson } = client;

    expect(await chatJson<{ ok: boolean }>(REQ)).toEqual({ ok: true });
  });
});

describe('failures carry the gateway\'s own reason', () => {
  it('turns a 400 model_not_allowed into a service-configuration error, not a sign-in one', async () => {
    const { client } = harness(() => jsonResponse(
      { error: { code: 'model_not_allowed', message: 'not on this allowlist' } }, 400,
    ));

    const error = await client.chat(REQ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe('model_not_allowed');
    expect(isServiceConfigError(error)).toBe(true);
    // There is nothing in Settings the user can change; routing them there
    // would be a confident wrong answer.
    expect(isSignInError(error)).toBe(false);
  });

  it('turns a 401 into sign_in_required, which the user can actually fix', async () => {
    const { client } = harness(() => jsonResponse(
      { error: { code: 'sign_in_required', message: 'token expired' } }, 401,
    ));

    const error = await client.chat(REQ).catch((e: unknown) => e);
    expect((error as ModelError).code).toBe('sign_in_required');
    expect(isSignInError(error)).toBe(true);
    expect(isServiceConfigError(error)).toBe(false);
  });

  it('carries the callId of a 503 service_misconfigured through, so the UI can quote it', async () => {
    const { client } = harness(() => jsonResponse(
      { error: { code: 'service_misconfigured', message: 'credential unresolvable', callId: 'call-42' } },
      503,
    ));

    await expect(client.chat(REQ)).rejects.toMatchObject({
      code: 'service_misconfigured', callId: 'call-42', status: 503,
    });
  });

  it('keeps the status when the error body cannot be read, rather than inventing a reason', async () => {
    const { client } = harness(() => new Response('<html>gateway timeout</html>', { status: 502 }));

    await expect(client.chat(REQ)).rejects.toMatchObject({ code: 'unknown', status: 502 });
  });

  it('turns a network-level fetch rejection into a ModelError, never a raw TypeError', async () => {
    // The failure `openrouter.ts` fixed: an unwrapped TypeError crashes
    // every caller that reads `.code`.
    const { client } = harness(() => Promise.reject(new TypeError('Failed to fetch')));

    const error = await client.chat(REQ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).code).toBe('network');
    expect((error as ModelError).retryable).toBe(true);
  });

  it('turns a 200 with an unreadable body into a ModelError, not a SyntaxError', async () => {
    const { client } = harness(() => new Response('not json at all', { status: 200 }));

    await expect(client.chat(REQ)).rejects.toMatchObject({
      name: 'ModelError', code: 'upstream_failed',
    });
  });

  it('propagates an abort unwrapped and does not retry it', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const { client, fetchMock } = harness(() => Promise.reject(abortError));
    const controller = new AbortController();

    await expect(client.chat(REQ, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    // The call count is the half that catches a regression: a retry loop
    // that eventually rejected with the same object would still pass without
    // it, while the UI looked busy for three seconds after Cancel.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 500 — the gateway owns the retry policy', async () => {
    const { client, fetchMock } = harness(() => jsonResponse(
      { error: { code: 'upstream_failed', message: 'boom' } }, 500,
    ));

    await expect(client.chat(REQ)).rejects.toMatchObject({ code: 'upstream_failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('chatStream', () => {
  it('POSTs to /v1/infer/stream with the bearer token', async () => {
    const { client, fetchMock } = harness(() => sseResponse([DONE]));

    await client.chatStream(REQ, () => {});

    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v1/infer/stream`);
    expect(authHeader(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  it('invokes onDelta per delta in order and resolves with the text, usage, callId and where it ran', async () => {
    const { client } = harness(() => sseResponse([
      encodeFrame({ type: 'delta', text: 'Hel' }),
      encodeFrame({ type: 'delta', text: 'lo' }),
      DONE,
    ]));

    const chunks: string[] = [];
    const result = await client.chatStream(REQ, c => chunks.push(c));

    expect(chunks).toEqual(['Hel', 'lo']);
    expect(result).toEqual({
      content: 'Hello',
      usage: { promptTokens: 5, completionTokens: 2 },
      callId: 'call-9',
      provider: 'azure-foundry',
      jurisdiction: UK_SOUTH,
    });
  });

  it('does not drop a delta split across two network chunks', async () => {
    const whole = encodeFrame({ type: 'delta', text: 'split' }) + DONE;
    const { client } = harness(() => sseResponse([whole.slice(0, 14), whole.slice(14)]));

    expect((await client.chatStream(REQ, () => {})).content).toBe('split');
  });

  // The founding defect, guarded from the browser side. A half-answer about
  // a contract that renders as a whole one is the thing this app exists not
  // to produce.
  it('rejects with stream_truncated when the body ends with no done frame', async () => {
    const { client } = harness(() => sseResponse([
      encodeFrame({ type: 'delta', text: 'half an ans' }),
    ]));

    const seen: string[] = [];
    await expect(client.chatStream(REQ, c => seen.push(c)))
      .rejects.toMatchObject({ name: 'ModelError', code: 'stream_truncated' });
    // What arrived was still reported: the caller can show it AND know it
    // is incomplete.
    expect(seen).toEqual(['half an ans']);
  });

  it('rejects with the error frame\'s own code and message', async () => {
    const { client } = harness(() => sseResponse([
      encodeFrame({ type: 'delta', text: 'partial' }),
      encodeFrame({
        type: 'error', code: 'upstream_failed', status: 502,
        message: 'the provider stopped answering', callId: 'call-3',
      }),
    ]));

    await expect(client.chatStream(REQ, () => {})).rejects.toMatchObject({
      name: 'ModelError', code: 'upstream_failed',
      message: 'the provider stopped answering', callId: 'call-3',
    });
  });

  it('reports an error status without attempting to read a stream', async () => {
    const { client } = harness(() => jsonResponse(
      { error: { code: 'purpose_not_allowed', message: 'unknown purpose' } }, 400,
    ));

    await expect(client.chatStream(REQ, () => {}))
      .rejects.toMatchObject({ code: 'purpose_not_allowed' });
  });

  it('propagates an abort from the initial fetch immediately, without wrapping or retrying', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const { client, fetchMock } = harness(() => Promise.reject(abortError));
    const controller = new AbortController();

    await expect(client.chatStream(REQ, () => {}, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops reading and propagates the abort when the signal fires mid-stream', async () => {
    // The real fetch/ReadableStream behaviour: an aborted request rejects
    // the reader's in-flight read(). That rejection must surface as the
    // abort it is, never swallowed into a resolved value by the finally
    // that releases the lock.
    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const encoder = new TextEncoder();
    let pulls = 0;
    let rejectPending: ((err: unknown) => void) | undefined;

    const stream = new ReadableStream({
      pull(ctrl) {
        pulls++;
        if (pulls === 1) {
          ctrl.enqueue(encoder.encode(encodeFrame({ type: 'delta', text: 'a' })));
          return;
        }
        return new Promise((_resolve, reject) => { rejectPending = reject; });
      },
    });
    controller.signal.addEventListener('abort', () => rejectPending?.(abortError));

    const { client } = harness(() => new Response(stream, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }));

    const promise = client.chatStream(REQ, () => {}, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('releases the stream reader on every exit path, including a truncated one', async () => {
    const truncated = sseResponse([encodeFrame({ type: 'delta', text: 'x' })]);
    const { client } = harness(() => truncated);

    await expect(client.chatStream(REQ, () => {})).rejects.toBeInstanceOf(ModelError);

    // A lock never released leaves response.body unusable with nothing able
    // to release it — `openrouter.ts` shipped that bug once.
    expect(() => truncated.body!.getReader()).not.toThrow();
  });
});

describe('listModels', () => {
  it('sends the bearer token and returns the array from { models: [...] }', async () => {
    const models: AllowedModel[] = [{
      id: 'uks-gpt4o', provider: 'azure-foundry', model: 'gpt-4o', label: 'GPT-4o',
      jurisdiction: UK_SOUTH, contextLength: 128000,
      supportsImages: true, supportsStructuredOutput: true, isDefault: true,
    }];
    const { client, fetchMock } = harness(() => jsonResponse({ models }));

    expect(await client.listModels()).toEqual(models);
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/v1/models`);
    expect(authHeader(fetchMock)).toBe(`Bearer ${TOKEN}`);
  });

  // The empty-versus-broken distinction, at the wire.
  it('returns [] for an empty allowlist and does not throw', async () => {
    const { client } = harness(() => jsonResponse({ models: [] }));

    await expect(client.listModels()).resolves.toEqual([]);
  });

  it('returns [] when the envelope has no models key at all, rather than throwing', async () => {
    const { client } = harness(() => jsonResponse({}));

    await expect(client.listModels()).resolves.toEqual([]);
  });

  it('throws service_misconfigured on a 503', async () => {
    const { client } = harness(() => jsonResponse(
      { error: { code: 'service_misconfigured', message: 'no allowlist configured' } }, 503,
    ));

    const error = await client.listModels().catch((e: unknown) => e);
    expect((error as ModelError).code).toBe('service_misconfigured');
    expect(isServiceConfigError(error)).toBe(true);
  });

  it('turns a network-level rejection into a ModelError, never a raw TypeError', async () => {
    const { client } = harness(() => Promise.reject(new TypeError('Failed to fetch')));

    await expect(client.listModels()).rejects.toMatchObject({
      name: 'ModelError', code: 'network',
    });
  });
});
