import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { mount, buttonNamed, click } from '../../test/mount';
import { AccessRefusedPanel } from './AccessRefusedPanel';

function render(error: ModelError, onSignOut = vi.fn()) {
  const container = mount(<AccessRefusedPanel error={error} onSignOut={onSignOut} />);
  return { container, onSignOut };
}

describe('AccessRefusedPanel', () => {
  it('a no_role failure is told plainly, with the groups the token carried', () => {
    const { container } = render(new ModelError(
      'Your account is not in any group that LexPrompt maps to a role, so you have no access '
      + 'to it yet. Your sign-in carries these groups: all-staff. Ask an administrator to add '
      + 'one of them to the LexPrompt role mapping.',
      'no_role', 403,
    ));
    expect(container.textContent).toMatch(/do not have access to LexPrompt/i);
    expect(container.textContent).toContain('all-staff');
    expect(container.textContent).not.toMatch(/no matters yet/i);
    expect(container.querySelector('button[aria-label="New matter"]')).toBeNull();
  });

  it('offers Sign out, and NOT Retry', () => {
    const { container } = render(new ModelError('no access', 'no_role', 403));
    expect(buttonNamed(container, /sign out/i)).toBeTruthy();
    expect(buttonNamed(container, /^retry$/i)).toBeUndefined();
  });

  it('clicking Sign out calls the handler', () => {
    const { container, onSignOut } = render(new ModelError('no access', 'no_role', 403));
    click(buttonNamed(container, /sign out/i));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('a DISABLED account gets a different screen from a no-role one', () => {
    const { container } = render(new ModelError(
      'Your LexPrompt account has been disabled by an administrator. Signing in again will not '
      + 'change this. Ask an administrator to re-enable it.',
      'account_disabled', 403,
    ));
    expect(container.textContent).toMatch(/has been disabled/i);
    expect(container.textContent).not.toMatch(/not in any group/i);
  });

  it('chooses its OWN headline by error.code, not merely by echoing the message', () => {
    // A neutral message (the server's own wording could change any day) so
    // this can only pass if the HEADLINE itself is chosen per code — the
    // component's job, not the caller's. Distinguishes "dispatches on the
    // code" from "just prints whatever message text it was given".
    const NEUTRAL = 'See your administrator for details.';
    const headlineOf = (code: 'no_role' | 'account_disabled' | 'group_overage') =>
      render(new ModelError(NEUTRAL, code, 403)).container.textContent!.replace(NEUTRAL, '');
    const headlines = new Set([
      headlineOf('no_role'), headlineOf('account_disabled'), headlineOf('group_overage'),
    ]);
    expect(headlines.size).toBe(3);
  });

  it('GROUP OVERAGE gets its own screen, and is not folded into "no access"', () => {
    // Reading it as "in no mapped group" would tell a partner in forty
    // groups that they have no access — a wrong answer delivered
    // confidently, to the person least able to accept it.
    const { container } = render(new ModelError(
      'Your account is in too many groups for LexPrompt to read them from your sign-in (group '
      + 'overage). Ask your administrator to grant LexPrompt directory read access.',
      'group_overage', 403,
    ));
    expect(container.textContent).toMatch(/too many groups/i);
    expect(container.textContent).toMatch(/administrator/i);
    expect(container.textContent).not.toMatch(/not in any group/i);
    expect(container.textContent).not.toMatch(/has been disabled/i);
  });
});
