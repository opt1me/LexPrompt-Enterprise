import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { ModelError } from '@lexprompt/core';
import { mountOnce, flushUntil } from '../../test/mount';

// `useAuth`/`getAccessToken` talk to `oidc-client-ts`'s `UserManager`
// through this project's own thin wrapper (`./oidc`), but the wrapper
// itself is real and unmocked here — only the external package's
// `UserManager` class is replaced. That lets this file exercise the REAL
// branching logic in both `useAuth.ts` and `oidc.ts` (in particular
// `getAccessToken`'s silent/redirect/failure split) against a fully
// controllable double, rather than testing a hand-mocked restatement of it.
// `ErrorResponse` and everything else oidc-client-ts exports come through
// untouched via `importOriginal`, so `instanceof ErrorResponse` in
// `oidc.ts` still means something real.
const getUserMock = vi.fn();
const signinSilentMock = vi.fn();
const signinRedirectMock = vi.fn();
const signinRedirectCallbackMock = vi.fn();
const signoutRedirectMock = vi.fn();

vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oidc-client-ts')>();
  class MockUserManager {
    constructor(_settings: unknown) { /* settings shape is irrelevant to this double */ }
    getUser(...args: unknown[]) { return getUserMock(...args); }
    signinSilent(...args: unknown[]) { return signinSilentMock(...args); }
    signinRedirect(...args: unknown[]) { return signinRedirectMock(...args); }
    signinRedirectCallback(...args: unknown[]) { return signinRedirectCallbackMock(...args); }
    signoutRedirect(...args: unknown[]) { return signoutRedirectMock(...args); }
  }
  return { ...actual, UserManager: MockUserManager };
});

import { ErrorResponse } from 'oidc-client-ts';
import { useAuth, initialsOf, type AuthState, type UseAuthResult } from './useAuth';
import { getAccessToken } from './oidc';

beforeEach(() => {
  getUserMock.mockReset();
  signinSilentMock.mockReset();
  signinRedirectMock.mockReset();
  signinRedirectCallbackMock.mockReset();
  signoutRedirectMock.mockReset();
  signinRedirectMock.mockResolvedValue(undefined);
  signoutRedirectMock.mockResolvedValue(undefined);
  // No `?code=` in the URL by default — the `signinRedirectCallback` path
  // is exercised explicitly by the one test that sets it.
  window.history.replaceState(null, '', '/');
});

/** Mounts a probe that renders `useAuth()`'s status (and, once signed in or
 *  failed, the fields a test needs to inspect) straight into text content,
 *  and hands back the latest hook result for calling `retry`/`signIn` on. */
function mountProbe(): { container: HTMLDivElement; unmount: () => void; latest: () => UseAuthResult } {
  let latest: UseAuthResult | null = null;
  function Probe() {
    const result = useAuth();
    latest = result;
    const { state } = result;
    return (
      <div>
        <div data-role="status">{state.status}</div>
        {state.status === 'failed' && <div data-role="message">{state.message}</div>}
        {state.status === 'signed-in' && <div data-role="account">{JSON.stringify(state.account)}</div>}
      </div>
    );
  }
  const { container, unmount } = mountOnce(<Probe />);
  return { container, unmount, latest: () => latest! };
}

function statusOf(container: HTMLDivElement): string {
  return container.querySelector('[data-role="status"]')?.textContent ?? '';
}

function accountOf(container: HTMLDivElement): AuthState & { status: 'signed-in' } {
  const text = container.querySelector('[data-role="account"]')?.textContent ?? '{}';
  return { status: 'signed-in', account: JSON.parse(text) };
}

/** Resolves to whatever a rejecting promise rejected with, typed as
 *  `unknown` rather than forcing every caller through `Promise<T | E>`'s
 *  awkward union (which is what `.catch((e) => e as E)` produces — the cast
 *  only narrows the CALLBACK's return type, not the outer promise, so
 *  `result.catch(...)` is still typed as `T | E` and a `.code` read on it
 *  does not typecheck). A rejecting `getAccessToken()` is asserted never to
 *  resolve at all (see each call site's `toBeInstanceOf`/`not.toBe('')`
 *  check), so this helper is only ever reached on the rejection path. */
async function catchOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('catchOf() was given a promise that resolved instead of rejecting.');
}

const FRESH_USER = (profile: Record<string, unknown>) => ({
  profile,
  expired: false,
  access_token: 'fresh-access-token',
});

describe('useAuth — the four states', () => {
  it('starts in signing-in while the sign-in check is pending', () => {
    getUserMock.mockReturnValue(new Promise(() => { /* never resolves within this test */ }));
    const { container, unmount } = mountProbe();
    // Asserted BEFORE any flush — the promise above is deliberately never
    // resolved, so this is the synchronous, immediate-post-mount state.
    expect(statusOf(container)).toBe('signing-in');
    unmount();
  });

  it('reaches signed-in with oid, name, email and computed initials when an account is returned', async () => {
    getUserMock.mockResolvedValue(FRESH_USER({ sub: 'entra-oid-1', name: 'A. Gray', email: 'a.gray@example.com' }));
    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) === 'signed-in', 'useAuth to reach signed-in');
    expect(accountOf(container).account).toEqual({
      oid: 'entra-oid-1', name: 'A. Gray', email: 'a.gray@example.com', initials: 'AG',
    });
    unmount();
  });

  it('reaches signed-out, not failed, when no account is returned', async () => {
    getUserMock.mockResolvedValue(null);
    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) !== 'signing-in', 'useAuth to settle');
    expect(statusOf(container)).toBe('signed-out');
    unmount();
  });

  it('reaches failed with the message when the sign-in check rejects, and does not fall through to signed-out', async () => {
    getUserMock.mockRejectedValue(new Error('the identity provider could not be reached'));
    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) !== 'signing-in', 'useAuth to settle');
    expect(statusOf(container)).toBe('failed');
    expect(container.querySelector('[data-role="message"]')?.textContent)
      .toBe('the identity provider could not be reached');
    unmount();
  });

  it('retry() from failed returns to signing-in', async () => {
    getUserMock.mockRejectedValueOnce(new Error('boom'));
    const { container, unmount, latest } = mountProbe();
    await flushUntil(() => statusOf(container) === 'failed', 'useAuth to reach failed');
    getUserMock.mockReturnValue(new Promise(() => { /* leave the retry pending */ }));
    act(() => { latest().retry(); });
    expect(statusOf(container)).toBe('signing-in');
    unmount();
  });
});

describe('initialsOf', () => {
  it('takes the first letters of the first and last words', () => {
    expect(initialsOf('A. Gray')).toBe('AG');
    expect(initialsOf('Priya Okafor')).toBe('PO');
    expect(initialsOf('Cher')).toBe('C');
  });
});

describe('getAccessToken', () => {
  it('returns the silent token when signinSilent resolves', async () => {
    getUserMock.mockResolvedValue(null);
    signinSilentMock.mockResolvedValue(FRESH_USER({ sub: 'entra-oid-2' }));
    await expect(getAccessToken()).resolves.toBe('fresh-access-token');
  });

  it('triggers a redirect and rejects when signinSilent fails with an interaction-required error, rather than returning an empty string', async () => {
    getUserMock.mockResolvedValue(null);
    signinSilentMock.mockRejectedValue(new ErrorResponse({ error: 'login_required' }));
    const rejected = await catchOf(getAccessToken());
    expect(rejected).not.toBe('');
    expect(signinRedirectMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with a ModelError of code sign_in_required on any other failure', async () => {
    getUserMock.mockResolvedValue(null);
    signinSilentMock.mockRejectedValue(new Error('network down'));
    const rejected = await catchOf(getAccessToken());
    expect(rejected).toBeInstanceOf(ModelError);
    expect((rejected as ModelError).code).toBe('sign_in_required');
    expect(signinRedirectMock).not.toHaveBeenCalled();
  });

  it('rejects with a ModelError rather than resolving an empty string when no token can be acquired at all', async () => {
    // Neither call throws — `signinSilent` simply produces no user (its real
    // return type is `Promise<User | null>`, not just "resolve or throw").
    // A caller reading `user.access_token` off that would read `undefined`
    // off `null`; the one thing `getAccessToken` must never do with it is
    // hand back `''`, which `apps/api` would see as an anonymous, tokenless
    // request rather than the expired-session it actually is.
    getUserMock.mockResolvedValue(null);
    signinSilentMock.mockResolvedValue(null);
    const rejected = await catchOf(getAccessToken());
    expect(rejected).toBeInstanceOf(ModelError);
    expect((rejected as ModelError).code).toBe('sign_in_required');
  });
});

// The same hook and the same code reach both issuers (task brief, case 10):
// `useAuth` and `getAccessToken` read `profile.sub` regardless of the
// claims shape around it. `subjectClaim` — which of a token's claims IS the
// subject for server-side authorisation decisions — is a Task 16 server
// concern; the browser never reads a second identity source.
describe.each([
  ['an Entra-shaped profile', { sub: 'entra-pairwise-oid', name: 'Priya Okafor', email: 'priya@example.com' }],
  ['a Keycloak-shaped profile', { sub: 'keycloak-sub-id', name: 'Priya Okafor', email: 'priya@example.com' }],
])('with %s', (_label, profile) => {
  it('reaches signed-in with oid taken from profile.sub and computed initials', async () => {
    getUserMock.mockResolvedValue(FRESH_USER(profile));
    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) === 'signed-in', 'useAuth to reach signed-in');
    expect(accountOf(container).account).toEqual({
      oid: profile.sub, name: profile.name, email: profile.email, initials: 'PO',
    });
    unmount();
  });

  it('acquires a token silently the same way', async () => {
    getUserMock.mockResolvedValue(null);
    signinSilentMock.mockResolvedValue(FRESH_USER(profile));
    await expect(getAccessToken()).resolves.toBe('fresh-access-token');
  });

describe('an identity provider that REFUSES the redirect', () => {
  // A provider answers a redirect in TWO shapes: `?code=` on success and
  // `?error=&error_description=` on refusal (RFC 6749 §4.1.2.1). Only `code`
  // used to count as a callback, so a refusal fell through to `getUser()`,
  // found nobody, and rendered the ordinary signed-out screen. A real
  // misconfiguration then looked exactly like a person who had not signed in
  // yet: press the button, come straight back, no explanation, forever.
  //
  // Found in a browser against a live Keycloak returning `invalid_scope`.
  it('reaches failed with the provider reason, not signed-out, on an error redirect', async () => {
    window.history.replaceState(null, '', '/?error=invalid_scope&error_description=Invalid+scopes&state=abc');
    signinRedirectCallbackMock.mockRejectedValue(new Error('Invalid scopes: openid profile email'));
    getUserMock.mockResolvedValue(null);

    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) !== 'signing-in', 'useAuth to settle');
    expect(statusOf(container)).toBe('failed');
    expect(container.querySelector('[data-role="message"]')?.textContent)
      .toContain('Invalid scopes');
    // The decisive half: an error redirect IS the callback, so the hook must
    // not fall back to asking whether a session happens to exist.
    expect(getUserMock).not.toHaveBeenCalled();
    unmount();
  });

  it('still treats a bare URL as "no callback here" and asks getUser', async () => {
    window.history.replaceState(null, '', '/');
    getUserMock.mockResolvedValue(null);
    const { container, unmount } = mountProbe();
    await flushUntil(() => statusOf(container) !== 'signing-in', 'useAuth to settle');
    expect(statusOf(container)).toBe('signed-out');
    expect(signinRedirectCallbackMock).not.toHaveBeenCalled();
    unmount();
  });
});
});
