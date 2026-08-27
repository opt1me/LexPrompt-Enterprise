import { describe, it, expect } from 'vitest';
import { UnconvertedPlaybookError } from './db/playbookMigration';
import { describeLoadError } from './loadError';
import { DbBlockedError } from './db/open';

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

  it('still falls back for an ordinary Error, so the pass-through list stays a list', () => {
    // The negative half: without it, "pass everything through" would satisfy
    // the test above while destroying the distinction the module exists for.
    expect(describeLoadError(new Error('some internal detail'), 'fallback')).toBe('fallback');
  });
});
