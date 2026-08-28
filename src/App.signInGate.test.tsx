import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushUntil } from './test/mount';

// Task 19's front-door gate: `App` must never render its own screens for
// anyone but a signed-in caller. `vitest.setup.ts` mocks `oidc-client-ts`'s
// `UserManager` project-wide as already-signed-in (the seam that keeps the
// other ~14 App-mounting test files unedited); this file is the one place
// that deliberately overrides that default, to prove the gate itself is
// load-bearing rather than merely present.
const getUserMock = vi.fn();

vi.mock('oidc-client-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oidc-client-ts')>();
  class SignedOutUserManager {
    constructor(_settings: unknown) { /* irrelevant to this double */ }
    getUser() { return getUserMock(); }
    signinSilent() { return Promise.resolve(null); }
    signinRedirect() { return Promise.resolve(); }
    signinRedirectCallback() { return Promise.resolve(null); }
    signoutRedirect() { return Promise.resolve(); }
  }
  return { ...actual, UserManager: SignedOutUserManager };
});

import App from './App';

beforeEach(() => {
  getUserMock.mockReset();
  getUserMock.mockResolvedValue(null); // signed-out: nobody stored
});

function bodyText(container: HTMLDivElement): string {
  return container.textContent ?? '';
}

describe('App — the sign-in gate (Task 19)', () => {
  it('renders the sign-in prompt, never the app shell, when no account is signed in', async () => {
    const container = mount(<App />);
    await flushUntil(() => bodyText(container).includes('Sign in to LexPrompt'), 'the sign-in screen to render');
    // The negative half of the assertion is the one that actually proves
    // the gate: rendering the app SHELL BEHIND the prompt (a modal over an
    // empty library) would still contain this same "Sign in" text, so the
    // absence of any app chrome is what distinguishes a real gate from a
    // decorative one.
    expect(bodyText(container)).not.toMatch(/Matters|Playbook library|Settings/);
  });

  it('renders an explicit failure, not the app, when the sign-in check itself cannot complete', async () => {
    getUserMock.mockReset();
    getUserMock.mockRejectedValue(new Error('the identity provider is unreachable'));
    const container = mount(<App />);
    await flushUntil(
      () => bodyText(container).includes("LexPrompt couldn't sign you in"),
      'the sign-in failure screen to render',
    );
    expect(bodyText(container)).toContain('the identity provider is unreachable');
  });
});
