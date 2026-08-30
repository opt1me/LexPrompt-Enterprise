import { ModelError, modelErrorFrom } from '@lexprompt/core';
import { getAccessToken } from '../auth/oidc';
import { config } from '../config';

/**
 * A failed `Response` becomes the `ModelError` the gateway meant.
 *
 * Only the CONTAINER is handled here — reading a `fetch` `Response`'s body,
 * and keeping the status when that body cannot be read at all. Every
 * judgement past `JSON.parse` (which code a refusal carries, what to do with
 * an unrecognised one, what 401 and 403 mean when the body names nothing)
 * lives in `modelErrorFrom` in `@lexprompt/core`, because `apps/api` reaches
 * the same endpoint holding undici's `{ status, json }` pair instead and
 * must reach the same conclusions. Two copies of that judgement — one in a
 * browser bundle, one in a Node service — is the drift this project has paid
 * for six times, in the form where nobody can read them side by side.
 */
export async function toModelError(response: Response): Promise<ModelError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Keep the status. A refusal with an unreadable body is still a refusal.
  }
  return modelErrorFrom(response.status, body);
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
 * close — see `toModelError` above, and `modelErrorFrom` in `@lexprompt/core`).
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
