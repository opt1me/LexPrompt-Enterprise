import {
  ModelError, isModelErrorCode,
  type ModelErrorCode,
} from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc';
import { config } from '../config';

/**
 * The code a refusal carries when its BODY did not name one.
 *
 * `apps/api` is not the only thing that can answer this browser with a 401.
 * A reverse proxy, an ingress, Azure Easy Auth or an expired-token
 * rejection can all emit one with an HTML page or some other envelope
 * entirely, and reading the code only out of `body.error.code` left every
 * one of those as `code: 'unknown'` — which `isSignInError` does not see,
 * so the sign-in gate this whole branch exists to build never fired. The
 * user got "HTTP 401" and a Retry that could only fail again, forever.
 *
 * `openrouter.ts`'s `isAuthError` was `status === 401 || status === 403`,
 * and that half of it is restored here rather than left to the body: 401 is
 * "we do not know who you are" (signing in again is the repair) and 403 is
 * "we know, and no" (`not_permitted`, which does NOT redirect). Both are in
 * `SIGN_IN_CODES`, so both reach `isAuthFailure`.
 *
 * Nothing else is guessed. A 502 from an ingress is not evidence that the
 * firm's deployment is misconfigured, and mapping it to
 * `service_misconfigured` would put a specific wrong reason — and the wrong
 * panel — in front of a reader. Everything but 401/403 stays `unknown`,
 * which is exactly what it is.
 */
export function codeFromStatus(status: number): ModelErrorCode {
  if (status === 401) return 'sign_in_required';
  if (status === 403) return 'not_permitted';
  return 'unknown';
}

/**
 * A failure response becomes the `ModelError` the gateway meant.
 *
 * The status alone is kept when the body cannot be read: a refusal with an
 * unreadable body is still a refusal, and inventing a code for it would put
 * a specific wrong reason in front of a reader — but the STATUS is not
 * nothing, and `codeFromStatus` above says what it is worth.
 *
 * `body.error.code` is checked against `MODEL_ERROR_CODES` rather than cast
 * into the union. An unrecognised code string used to land outside both
 * classifier sets by accident: `isSignInError` and `isServiceConfigError`
 * would both read false for a refusal that was plainly one or the other.
 * A code nothing recognises now falls through to the status, exactly like a
 * body that could not be read at all.
 */
export async function toModelError(response: Response): Promise<ModelError> {
  let code: ModelErrorCode | undefined;
  let message = `HTTP ${response.status}`;
  let callId: string | undefined;
  try {
    const body = await response.json() as {
      error?: { code?: unknown; message?: string; callId?: string };
    };
    if (isModelErrorCode(body?.error?.code)) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
    callId = body?.error?.callId;
  } catch {
    // keep the status
  }
  return new ModelError(message, code ?? codeFromStatus(response.status), response.status, callId);
}

export interface ApiDeps {
  baseUrl: string;
  getToken(): Promise<string>;
  fetch: typeof globalThis.fetch;
}

export interface ApiClient {
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  /** For the repository reads that answer `T | null`. A 404 is "no such
   *  record", which is a fact, not a failure — `getDocumentBlob`'s docstring
   *  makes the same distinction and gives the same reason. */
  getOrNull<T>(path: string, signal?: AbortSignal): Promise<T | null>;
  send<T>(method: 'PUT' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  sendForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T>;
  getBlobOrNull(path: string, signal?: AbortSignal): Promise<Blob | null>;
  del(path: string, signal?: AbortSignal): Promise<void>;
}

const isAbort = (e: unknown): boolean => (e as { name?: string } | null)?.name === 'AbortError';

/**
 * The browser's one HTTP transport to `apps/api` — every repository read
 * and write in `src/lib/db/` goes through this, so there is exactly one
 * place that turns a failed `Response` (or a failed `fetch` itself) into a
 * `ModelError`, sharing that vocabulary with `gatewayModelClient.ts` rather
 * than reimplementing it (the sibling-drift risk this module exists to
 * close — see `toModelError`/`codeFromStatus` above, moved here verbatim).
 */
export function makeApiClient(deps: ApiDeps): ApiClient {
  async function call(method: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const token = await deps.getToken();
    if (!token) {
      // Never send an unauthenticated request. It would be answered 401 and
      // would be indistinguishable from an expired session, which is a
      // sign-in loop with no exit — the shape Stage 1's Task 19 mutation
      // found on `getAccessToken` resolving empty rather than rejecting.
      throw new ModelError(
        'You are not signed in to LexPrompt. Sign in again to continue.',
        'sign_in_required', 401,
      );
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init.body !== undefined && !(init.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    try {
      return await deps.fetch(`${deps.baseUrl}${path}`, { ...init, method, headers, signal });
    } catch (err) {
      // An abort is a cancellation and must propagate as one: swallowing it
      // into a network error would make a user's navigation look like a
      // failure of the firm's service.
      if (isAbort(err)) throw err;
      throw new ModelError(
        `LexPrompt could not reach your firm's service (${(err as Error).message}). Your work `
        + 'is on the server, not in this browser, so nothing is lost — but nothing can be '
        + 'read or saved until the connection is back.',
        'network', 0,
      );
    }
  }

  async function readJson<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;
    try {
      return await response.json() as T;
    } catch (err) {
      throw new ModelError(
        `LexPrompt's server returned a response that could not be read (${(err as Error).message}).`,
        'upstream_failed', 502,
      );
    }
  }

  return {
    async get<T>(path: string, signal?: AbortSignal): Promise<T> {
      const response = await call('GET', path, {}, signal);
      if (!response.ok) throw await toModelError(response);
      return readJson<T>(response);
    },

    async getOrNull<T>(path: string, signal?: AbortSignal): Promise<T | null> {
      const response = await call('GET', path, {}, signal);
      if (response.status === 404) return null;
      if (!response.ok) throw await toModelError(response);
      return readJson<T>(response);
    },

    async send<T>(
      method: 'PUT' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal,
    ): Promise<T> {
      const response = await call(method, path, { body: JSON.stringify(body) }, signal);
      if (!response.ok) throw await toModelError(response);
      return readJson<T>(response);
    },

    async sendForm<T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> {
      // No `Content-Type` here — the browser sets the multipart boundary
      // itself. Setting it by hand produces a body the server cannot parse,
      // with an error that names neither cause.
      const response = await call('POST', path, { body: form }, signal);
      if (!response.ok) throw await toModelError(response);
      return readJson<T>(response);
    },

    async getBlobOrNull(path: string, signal?: AbortSignal): Promise<Blob | null> {
      const response = await call('GET', path, {}, signal);
      if (response.status === 404) return null;
      if (!response.ok) throw await toModelError(response);
      return response.blob();
    },

    async del(path: string, signal?: AbortSignal): Promise<void> {
      const response = await call('DELETE', path, {}, signal);
      if (!response.ok) throw await toModelError(response);
    },
  };
}

/** The app's one instance. A second `makeApiClient` call in `src/` is a
 *  second transport and is what `client.test.ts`'s wiring case forbids. */
export const api: ApiClient = makeApiClient({
  baseUrl: config.apiBaseUrl,
  getToken: getAccessToken,
  fetch: globalThis.fetch.bind(globalThis),
});

// Thin, named wrappers over the one instance above — the surface the
// repositories in `src/lib/db/` are meant to call, so a repository imports
// a function rather than reaching for the singleton object directly.
export const apiGet = <T>(path: string, signal?: AbortSignal): Promise<T> => api.get<T>(path, signal);
export const apiGetOrNull = <T>(path: string, signal?: AbortSignal): Promise<T | null> =>
  api.getOrNull<T>(path, signal);
export const apiSend = <T>(
  method: 'PUT' | 'POST' | 'PATCH', path: string, body: unknown, signal?: AbortSignal,
): Promise<T> => api.send<T>(method, path, body, signal);
export const apiSendBlob = <T>(path: string, form: FormData, signal?: AbortSignal): Promise<T> =>
  api.sendForm<T>(path, form, signal);
export const apiGetBlob = (path: string, signal?: AbortSignal): Promise<Blob | null> =>
  api.getBlobOrNull(path, signal);
export const apiDelete = (path: string, signal?: AbortSignal): Promise<void> => api.del(path, signal);
