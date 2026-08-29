import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { ModelError, SERVICE_CONFIG_HINT } from '@lexprompt/core';
import { mount, buttons, buttonNamed, click } from '../test/mount';
import { ServiceConfigError, DISMISS_RETRIES_NOTHING } from './ServiceConfigError';

function error(callId?: string): ModelError {
  return new ModelError(
    "The AI provider rejected LexPrompt's credentials. This is a configuration problem in the "
    + `firm's deployment, ${SERVICE_CONFIG_HINT}.`,
    'service_misconfigured',
    503,
    callId,
  );
}

describe('ServiceConfigError', () => {
  it('renders the "not something you can fix here" sentence', () => {
    const container = mount(<ServiceConfigError error={error()} onRetry={() => {}} />);
    expect(container.textContent).toContain(SERVICE_CONFIG_HINT);
  });

  it('renders the callId as a quotable reference when one is present', () => {
    const container = mount(<ServiceConfigError error={error('call-abc-123')} onRetry={() => {}} />);
    expect(container.textContent).toContain('call-abc-123');
  });

  it('renders no reference line when callId is absent, rather than an empty label', () => {
    const container = mount(<ServiceConfigError error={error(undefined)} onRetry={() => {}} />);
    // No dangling "reference:" (or similar) label with nothing after it —
    // the whole clause is omitted, not rendered empty.
    expect(container.textContent).not.toMatch(/reference/i);
    expect(container.textContent).not.toContain('undefined');
  });

  it('renders a Retry that calls onRetry', () => {
    const onRetry = vi.fn();
    const container = mount(<ServiceConfigError error={error('call-1')} onRetry={onRetry} />);
    const retry = buttonNamed(container, /retry/i);
    expect(retry).toBeTruthy();
    click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('contains no link or button to Settings', () => {
    const container = mount(<ServiceConfigError error={error('call-1')} onRetry={() => {}} />);
    expect(buttonNamed(container, /settings/i)).toBeUndefined();
    // Belt and braces: no anchor either, since a Settings "link" need not be a <button>.
    const settingsLink = Array.from(container.querySelectorAll('a'))
      .find(a => /settings/i.test(a.textContent || ''));
    expect(settingsLink).toBeUndefined();
    // Sanity: the button query itself works (Retry exists), so an absent
    // Settings match above is a real negative, not `buttons()` finding nothing.
    expect(buttons(container).length).toBeGreaterThan(0);
  });

  /**
   * Final review M5. This component is mounted at TWO call sites, and only
   * one of them has anything to re-attempt: `ResultsView` passes
   * `onRetryCell`, which runs the clause again, while App's shell-level
   * banner used to pass `() => setServiceConfigError(null)` — a button
   * labelled Retry that dismissed the panel and re-attempted nothing, above
   * a screen with no in-place result to check it against. "Banner gone, no
   * new error" reads as "it worked".
   */
  describe('the button says what it actually does', () => {
    it('renders Dismiss, not Retry, when there is nothing to re-attempt', () => {
      const onDismiss = vi.fn();
      const container = mount(<ServiceConfigError error={error('call-1')} onDismiss={onDismiss} />);
      expect(buttonNamed(container, /retry/i)).toBeUndefined();
      const dismiss = buttonNamed(container, /dismiss/i);
      expect(dismiss).toBeTruthy();
      click(dismiss);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('says in words that dismissing is not a retry', () => {
      const container = mount(<ServiceConfigError error={error('call-1')} onDismiss={() => {}} />);
      expect(container.textContent).toContain(DISMISS_RETRIES_NOTHING);
    });

    it('says nothing about dismissing when a real retry is wired', () => {
      const container = mount(<ServiceConfigError error={error('call-1')} onRetry={() => {}} />);
      expect(container.textContent).not.toContain(DISMISS_RETRIES_NOTHING);
      expect(buttonNamed(container, /dismiss/i)).toBeUndefined();
    });
  });
});
