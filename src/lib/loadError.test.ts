import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { UnconvertedPlaybookError } from './db/playbookMigration';
import { describeLoadError } from './loadError';
import { DbBlockedError, DbOpenTimeoutError } from './db/open';

describe('describeLoadError (Important 4)', () => {
  it('surfaces a DbBlockedError\'s own message verbatim, ignoring the fallback', () => {
    const error = new DbBlockedError();
    expect(describeLoadError(error, 'fallback text')).toBe(error.message);
    expect(describeLoadError(error, 'fallback text')).not.toBe('fallback text');
  });

  it('falls back to the subject-specific message for any other error', () => {
    expect(describeLoadError(new Error('boom'), 'The widgets could not be loaded. Try again.'))
      .toBe('The widgets could not be loaded. Try again.');
  });

  it('falls back for a non-Error thrown value too', () => {
    expect(describeLoadError('a string was thrown', 'fallback')).toBe('fallback');
    expect(describeLoadError(undefined, 'fallback')).toBe('fallback');
  });

  // This module is the single classification point for every "an honest
  // error instead of an empty list" call site, so its own suite is where the
  // next person looks for the list of what passes through. The second
  // pass-through type was covered only transitively from `App.test.tsx`,
  // which is not where anyone would think to check.
  it('passes an UnconvertedPlaybookError through, like DbBlockedError', () => {
    const e = new UnconvertedPlaybookError();
    expect(describeLoadError(e, 'fallback')).toBe(e.message);
  });

  it('passes a DbOpenTimeoutError through, so a silent database says so', () => {
    // The backstop exists because an open that never settles would leave
    // every screen spinning with no error. Reaching the UI as the generic
    // fallback would keep the loudness but lose the only sentence that
    // makes a 30-second silence intelligible — that the data is still there.
    const e = new DbOpenTimeoutError();
    expect(describeLoadError(e, 'fallback')).toBe(e.message);
    expect(e.message).toMatch(/not been lost/i);
  });

  it('still falls back for an ordinary Error, so the pass-through list stays a list', () => {
    // The negative half: without it, "pass everything through" would satisfy
    // the test above while destroying the distinction the module exists for.
    expect(describeLoadError(new Error('some internal detail'), 'fallback')).toBe('fallback');
  });

  // Task 7: moving storage behind HTTP adds new ways to be broken — a 401,
  // a 403, a network failure — and none of them may render as an empty
  // list. Each carries its own specific, user-facing instruction, which is
  // exactly why `ModelError` joins the pass-through list rather than being
  // folded into the generic fallback.
  it.each([
    ['sign_in_required', 'You are not signed in to LexPrompt. Sign in again to continue.'],
    ['not_permitted', 'This needs the partner role.'],
    ['network', "LexPrompt could not reach your firm's service."],
    ['service_misconfigured', "This is a configuration problem in the firm's deployment."],
  ] as const)('surfaces a ModelError\'s own message for code %s, ignoring the fallback', (code, message) => {
    const error = new ModelError(message, code, code === 'network' ? 0 : 500);
    expect(describeLoadError(error, 'fallback text')).toBe(message);
    expect(describeLoadError(error, 'fallback text')).not.toBe('fallback text');
  });
});
