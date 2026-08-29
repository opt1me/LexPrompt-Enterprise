import { describe, it, expect } from 'vitest';
import { ModelError } from '@lexprompt/core';
import { isAccessRefusedError, isAuthFailure } from './authFailure';

describe('isAccessRefusedError', () => {
  it.each(['no_role', 'account_disabled', 'group_overage'] as const)(
    'is true for %s',
    (code) => {
      expect(isAccessRefusedError(new ModelError('msg', code, 403))).toBe(true);
    },
  );

  it('is false for a code that is not one of the three', () => {
    expect(isAccessRefusedError(new ModelError('msg', 'service_misconfigured', 503))).toBe(false);
    expect(isAccessRefusedError(new ModelError('msg', 'not_permitted', 403))).toBe(false);
  });

  it('is false for a non-ModelError', () => {
    expect(isAccessRefusedError(new Error('plain'))).toBe(false);
    expect(isAccessRefusedError(undefined)).toBe(false);
  });

  it('group_overage counts as both isAccessRefusedError and isAuthFailure — deliberately, for different consumers', () => {
    const e = new ModelError('msg', 'group_overage', 403);
    expect(isAccessRefusedError(e)).toBe(true);
    expect(isAuthFailure(e)).toBe(true);
  });
});
