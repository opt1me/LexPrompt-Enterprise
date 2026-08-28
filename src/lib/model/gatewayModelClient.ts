import {
  ModelError, parseJsonLoose, readFrames,
  type AllowedModel, type InferRequest, type InferResponse, type ModelClient,
  type ModelErrorCode,
} from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc';
import { config } from '../config';

export interface GatewayClientDeps {
  baseUrl: string;
  getToken(): Promise<string>;
  fetch: typeof globalThis.fetch;
}

/**
 * Both shapes an abort arrives in: a real `DOMException` in a browser, and
 * a plain object with `name === 'AbortError'` from an environment or a mock
 * that does not produce one. `openrouter.ts` checked both for the same
 * reason and this is the same check.
 */
const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * A failure response becomes the `ModelError` the gateway meant.
 *
 * The status alone is kept when the body cannot be read: a refusal with an
 * unreadable body is still a refusal, and inventing a code for it would put
 * a specific wrong reason in front of a reader.
 */
async function toModelError(response: Response): Promise<ModelError> {
  let code: ModelErrorCode = 'unknown';
  let message = `HTTP ${response.status}`;
  let callId: string | undefined;
  try {
    const body = await response.json() as {
      error?: { code?: ModelErrorCode; message?: string; callId?: string };
    };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    callId = body?.error?.callId;
  } catch {
    // keep the status
  }
  return new ModelError(message, code, response.status, callId);
}

/**
 * Reads a `ReadableStream` as an async iterable of bytes.
 *
 * Written by hand rather than `for await (const c of response.body)` for
 * two reasons, both of them things this file must not lose:
 *
 *  - **Async iteration over a `ReadableStream` is not universally
 *    implemented in browsers** (Safari has never shipped it). A `for await`
 *    straight over `response.body` throws "is not async iterable" there,
 *    which would make the assistant panel fail on one browser and work on
 *    the rest.
 *  - `reader.releaseLock()` on EVERY exit path — normal completion, a
 *    thrown parse error, or an abort. That was a real fix in
 *    `openrouter.ts`: nothing released the lock, so a non-abort mid-stream
 *    failure left `response.body` locked forever with nothing to release
 *    it. `readFrames` takes an `AsyncIterable` and cannot do this itself,
 *    so the lock discipline stays here, with the reader that acquires it.
 */
async function* streamBytes(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      // No try/catch around read(): if the signal aborts mid-stream this
      // rejects with an AbortError, and that rejection must propagate as
      // the cancellation it is — never swallowed into a normal completion,
      // never retried.
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * The one route from this browser to a model (S1).
 *
 * `openrouter.ts`'s shape, minus the key and minus the model id. What that
 * module carried has not been dropped — it has moved:
 *
 *   retry policy (429/5xx only) -> apps/gateway/src/callModel.ts
 *   parseJsonLoose              -> packages/core, still the fallback below
 *   the SSE parser              -> packages/core, reached through readFrames
 *   isAuthError                 -> isSignInError / isServiceConfigError
 *   "no message content"        -> each adapter's readResponse, via callModel
 *   the abort rule              -> here, and in callModel
 *   the network-error wrap      -> here
 *   the reader-lock release     -> here, in streamBytes
 *
 * A deleted module whose reasoning went with it is how a fixed bug returns.
 *
 * There is deliberately NO retry in this file. The gateway retries 429 and
 * 5xx on the outward call, where it knows the provider's own status; a
 * second retry loop in the browser would multiply every attempt by three
 * and turn one slow provider into a nine-attempt wait.
 */
export function makeGatewayModelClient(deps: GatewayClientDeps): ModelClient {
  /**
   * Every request this browser makes carries the bearer token from
   * `getAccessToken`, which is the only source of one. A token failure
   * propagates as its own `sign_in_required` `ModelError` and no request is
   * made — sending an unauthenticated request instead would produce an
   * anonymous 401 rather than "sign in again".
   */
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<Response> => {
    const token = await deps.getToken();
    try {
      return await deps.fetch(`${deps.baseUrl}${path}`, {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A cancellation is a deliberate decision and propagates as itself.
      if (isAbort(err)) throw err;
      // A network-level failure (offline, DNS, CORS) never reaches an HTTP
      // response and throws a raw TypeError out of fetch. Left unwrapped it
      // crashes every caller that reads `.code` — the exact defect
      // `openrouter.ts` fixed, in the exact place it fixed it.
      throw new ModelError(
        `LexPrompt could not reach its server (${(err as Error).message}). `
        + 'Check your connection and try again.',
        'network', 0,
      );
    }
  };

  /** A 200 whose body is not the JSON it claims is a failed call wearing a
   *  success, and it must not reach a caller as a raw `SyntaxError`. */
  const readJson = async <T>(response: Response): Promise<T> => {
    try {
      return await response.json() as T;
    } catch (err) {
      throw new ModelError(
        `LexPrompt's server returned a response that could not be read (${(err as Error).message}).`,
        'upstream_failed', 502,
      );
    }
  };

  const chat = async (req: InferRequest, signal?: AbortSignal): Promise<InferResponse> => {
    const response = await post('/v1/infer', req, signal);
    if (!response.ok) throw await toModelError(response);
    return await readJson<InferResponse>(response);
  };

  const chatJson = async <T>(req: InferRequest, signal?: AbortSignal): Promise<T> =>
    // parseJsonLoose survives verbatim: models vary in schema adherence and
    // a run must not fail because one added "Sure! Here you go:".
    parseJsonLoose<T>((await chat(req, signal)).content);

  const chatStream = async (
    req: InferRequest, onDelta: (chunk: string) => void, signal?: AbortSignal,
  ): Promise<InferResponse> => {
    const response = await post('/v1/infer/stream', req, signal);
    if (!response.ok) throw await toModelError(response);
    if (!response.body) {
      throw new ModelError('The server returned no response body to stream.', 'upstream_failed', 502);
    }
    let content = '';
    // readFrames throws stream_truncated if the stream ends with no done
    // frame (P2), so a half-answer cannot be returned as a whole one.
    const end = await readFrames(streamBytes(response.body), chunk => {
      content += chunk;
      onDelta(chunk);
    });
    // `provider` and `jurisdiction` come off the done frame — the gateway's
    // record of which backend actually answered and where. They are never
    // defaulted here: a plausible-looking invented region is worse than no
    // answer, and `Frame`'s `done` variant requires both so there is no
    // shape this could receive that lacks them.
    return {
      content,
      usage: end.usage,
      callId: end.callId,
      provider: end.provider,
      jurisdiction: end.jurisdiction,
    };
  };

  const listModels = async (): Promise<AllowedModel[]> => {
    const token = await deps.getToken();
    let response: Response;
    try {
      response = await deps.fetch(`${deps.baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw new ModelError(
        `LexPrompt could not reach its server (${(err as Error).message}). `
        + 'Check your connection and try again.',
        'network', 0,
      );
    }
    if (!response.ok) throw await toModelError(response);
    const body = await readJson<{ models?: AllowedModel[] }>(response);
    // An empty list is a successful empty list, not a failure — the
    // empty-versus-broken distinction at the wire. Task 22 renders it as
    // "no model has been configured yet".
    return Array.isArray(body.models) ? body.models : [];
  };

  // Returned as plain closures rather than object methods so that a
  // destructured `const { chatJson } = client` still works: `chatJson`
  // calling `this.chat` would be `undefined` the moment anyone did that,
  // and a client that breaks on destructuring is a trap for every call site
  // and every test mock.
  return { chat, chatJson, chatStream, listModels };
}

export const gatewayModelClient = makeGatewayModelClient({
  // Through src/lib/config.ts, never `import.meta.env` directly: that module
  // is the web app's only reader of it (S30), and `configSurface` (Task 26)
  // fails the build on a second one.
  baseUrl: config.apiBaseUrl,
  getToken: getAccessToken,
  fetch: globalThis.fetch.bind(globalThis),
});
