import { describe, it, expect } from 'vitest';
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
});
