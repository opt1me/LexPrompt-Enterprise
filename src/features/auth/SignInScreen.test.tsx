import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { mount, buttonNamed, click } from '../../test/mount';
import { SignInScreen } from './SignInScreen';

describe('SignInScreen — the three states before the app', () => {
  it('offers Sign in, and only Sign in, when the check found nobody', () => {
    const onSignIn = vi.fn();
    const container = mount(
      <SignInScreen state={{ status: 'signed-out' }} onSignIn={onSignIn} onRetry={vi.fn()} />,
    );
    click(buttonNamed(container, /^sign in$/i));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(buttonNamed(container, /retry/i)).toBeUndefined();
  });

  it('says it is signing in, without an error and without a button', () => {
    const container = mount(
      <SignInScreen state={{ status: 'signing-in' }} onSignIn={vi.fn()} onRetry={vi.fn()} />,
    );
    expect(container.textContent).toContain('Signing in');
    expect(buttonNamed(container, /sign in/i)).toBeUndefined();
  });

  /**
   * Final review M1's compounding half. `failed` used to render a
   * `LoadErrorPanel` with Retry ALONE — and this screen is reached with the
   * provider's own answer still in the address bar, so Retry re-read the
   * same URL and reproduced the same refusal. There was no route out from
   * inside the app: only hand-editing the URL or a new tab recovered.
   */
  it('offers a way to start sign-in again, not only a Retry of the same check', () => {
    const onSignIn = vi.fn();
    const onRetry = vi.fn();
    const container = mount(
      <SignInScreen
        state={{ status: 'failed', message: 'No matching state found in storage' }}
        onSignIn={onSignIn}
        onRetry={onRetry}
      />,
    );
    expect(container.textContent).toContain('No matching state found in storage');

    const signIn = buttonNamed(container, /sign in/i);
    expect(signIn, 'the failed screen must offer a sign-in action, not just Retry').toBeTruthy();
    click(signIn);
    expect(onSignIn).toHaveBeenCalledTimes(1);

    // Retry still exists and still means "check again" — the two actions are
    // different repairs, not one relabelled.
    click(buttonNamed(container, /retry/i));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
