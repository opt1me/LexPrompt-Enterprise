import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { UnconvertedPlaybookError } from './db/playbookMigration';
import {
  controlDisabledReason, describeLoadError,
  RESYNCING_NOTICE, STALE_CONTROL_NOTICE, STALE_NOTICE,
} from './loadError';
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

/**
 * §3's fourth state, and the reason it is a SIBLING rather than a branch.
 *
 * `describeLoadError` is a function over an ERROR. `stale` is not an error —
 * nothing failed — so it has no error to be described from, and the two must
 * not collapse into one sentence.
 */
describe('the fourth load state has its own words, and they are not an error s', () => {
  it('never claims anything failed or could not be loaded', () => {
    for (const notice of [STALE_NOTICE, STALE_CONTROL_NOTICE, RESYNCING_NOTICE]) {
      expect(notice).not.toMatch(/could not be loaded|failed|error/i);
    }
    // …and the check bites, so those three passes are about the wording
    // rather than about a regex that matches nothing.
    expect(/could not be loaded|failed|error/i.test('The matters could not be loaded.'))
      .toBe(true);
  });

  it('says the two different things a stale client has to say', () => {
    // The banner is about the SCREEN; the control notice is about the SAVE.
    // "Try again in a moment" is the one instruction that is not true at a
    // dead control, because the write would be refused rather than delayed.
    expect(STALE_NOTICE).toContain('no longer being updated');
    expect(STALE_CONTROL_NOTICE).toContain('would not be saved');
    expect(RESYNCING_NOTICE).toContain('Reconnecting');
    expect(STALE_NOTICE).not.toBe(STALE_CONTROL_NOTICE);
  });

  it('describeLoadError is untouched by any of it', () => {
    // A `stale` branch inside `describeLoadError` is exactly the collapse
    // this arrangement exists to prevent; there is no error value that could
    // produce one.
    expect(describeLoadError(new Error('boom'), 'The review could not be read.'))
      .toBe('The review could not be read.');
  });

  it('reports a stale control s reason, and says nothing for a busy one', () => {
    expect(controlDisabledReason({ stale: true })).toBe(STALE_CONTROL_NOTICE);
    // `busy` explains itself by waiting. A sentence there would tell a
    // reviewer something is wrong when their write is simply in flight.
    expect(controlDisabledReason({ busy: true })).toBeUndefined();
    expect(controlDisabledReason({})).toBeUndefined();
    // Stale WINS over busy: a write in flight against a screen nobody can
    // vouch for is the worse of the two facts, and it is the one to say.
    expect(controlDisabledReason({ busy: true, stale: true })).toBe(STALE_CONTROL_NOTICE);
  });
});
