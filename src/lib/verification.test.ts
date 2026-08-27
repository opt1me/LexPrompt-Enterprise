import { describe, it, expect } from 'vitest';
import {
  unchecked, applyVerification, requiresReason, resetVerification,
  findingKey, makeNote, VerificationError,
} from './verification';

describe('unchecked', () => {
  it('starts with no attribution and no timestamp', () => {
    expect(unchecked()).toEqual({ state: 'unchecked' });
  });
});

describe('requiresReason', () => {
  it('is true only for rejected', () => {
    expect(requiresReason('rejected')).toBe(true);
    expect(requiresReason('verified')).toBe(false);
    expect(requiresReason('flagged')).toBe(false);
    expect(requiresReason('unchecked')).toBe(false);
  });
});

describe('applyVerification', () => {
  it('records who and when on verify', () => {
    const v = applyVerification(unchecked(), { state: 'verified' }, 'user-1', 1000);
    expect(v).toEqual({ state: 'verified', byUserId: 'user-1', at: 1000 });
  });

  it('carries the reason on reject', () => {
    const v = applyVerification(unchecked(), { state: 'rejected', reason: 'Wrong clause' }, 'user-1', 1000);
    expect(v).toEqual({ state: 'rejected', byUserId: 'user-1', at: 1000, reason: 'Wrong clause' });
  });

  it('refuses to reject without a reason', () => {
    expect(() => applyVerification(unchecked(), { state: 'rejected' }, 'user-1', 1000))
      .toThrow(VerificationError);
  });

  it('refuses to reject with a whitespace-only reason', () => {
    expect(() => applyVerification(unchecked(), { state: 'rejected', reason: '   ' }, 'user-1', 1000))
      .toThrow(VerificationError);
  });

  it('trims the reason it stores', () => {
    const v = applyVerification(unchecked(), { state: 'rejected', reason: '  bad  ' }, 'u', 1);
    expect(v.reason).toBe('bad');
  });

  it('drops a stale reason when moving off rejected', () => {
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'bad' }, 'u', 1);
    const verified = applyVerification(rejected, { state: 'verified' }, 'u', 2);
    expect(verified.reason).toBeUndefined();
    expect(verified.state).toBe('verified');
  });

  it('preserves assigneeId across a state change', () => {
    const assigned = { ...unchecked(), assigneeId: 'someone' };
    const v = applyVerification(assigned, { state: 'flagged' }, 'u', 5);
    expect(v.assigneeId).toBe('someone');
  });

  it('allows every state to reach every other state', () => {
    const states = ['unchecked', 'verified', 'flagged', 'rejected'] as const;
    for (const from of states) {
      for (const to of states) {
        const start = applyVerification(
          unchecked(),
          from === 'rejected' ? { state: from, reason: 'r' } : { state: from },
          'u', 1,
        );
        const next = applyVerification(
          start,
          to === 'rejected' ? { state: to, reason: 'r' } : { state: to },
          'u', 2,
        );
        expect(next.state).toBe(to);
      }
    }
  });
});

describe('resetVerification', () => {
  it('returns a bare unchecked verification, dropping attribution and reason', () => {
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'bad' }, 'u', 1);
    expect(resetVerification(rejected)).toEqual({ state: 'unchecked' });
  });

  it('keeps assigneeId, which is about the clause and not about the run', () => {
    const v = { state: 'verified' as const, byUserId: 'u', at: 1, assigneeId: 'someone' };
    expect(resetVerification(v)).toEqual({ state: 'unchecked', assigneeId: 'someone' });
  });
});

describe('findingKey', () => {
  it('combines both ids, since neither alone is unique within a review', () => {
    expect(findingKey('doc-1', 'clause-2')).toBe('doc-1::clause-2');
    expect(findingKey('doc-1', 'clause-2')).not.toBe(findingKey('doc-2', 'clause-1'));
  });
});

describe('makeNote', () => {
  it('trims the text and records attribution against the composite key', () => {
    const note = makeNote('doc-1', 'clause-2', '  check the cap  ', 'user-1', 99, 'note-1');
    expect(note).toEqual({
      id: 'note-1',
      findingId: 'doc-1::clause-2',
      text: 'check the cap',
      byUserId: 'user-1',
      at: 99,
    });
  });
});
