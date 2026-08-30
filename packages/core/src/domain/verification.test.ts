import { describe, it, expect } from 'vitest';
import {
  unchecked, applyVerification, requiresReason, effectiveReason, resetVerification,
  findingKey, makeNote, VerificationError,
} from './verification.ts';
import type { Verification } from './types.ts';

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

  it('carries NO assigneeId, however one reaches it (P24, Task 22)', () => {
    /*
     * INVERTED, NOT DELETED. This read *"preserves assigneeId across a state
     * change"* and it was right while the field existed: an assignment
     * pointed at a clause, not at the decision being made.
     *
     * The field is gone. It reached nobody (ruling R1) and has no home in
     * the server schema - an assignment is a record with an assigner, a
     * message and a resolution, and that table is Stage 4's. The cast is how
     * a value that no longer has a type still gets tried: real stored data
     * carries them, and the question is what this function does with one.
     */
    const legacy = { ...unchecked(), assigneeId: 'someone' } as Verification;
    const v = applyVerification(legacy, { state: 'flagged' }, 'u', 5);
    expect('assigneeId' in v, 'assigneeId came back').toBe(false);
    // The sanity check: this call did something, so the absence above is
    // about the field rather than about a function that returned nothing.
    expect(v).toEqual({ state: 'flagged', byUserId: 'u', at: 5 });
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
    // The rejection is still built, so the assertion is about a reset that
    // follows a real judgement rather than about a constant.
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'bad' }, 'u', 1);
    expect(rejected).toMatchObject({ state: 'rejected', byUserId: 'u', reason: 'bad' });
    expect(resetVerification()).toEqual({ state: 'unchecked' });
  });

  it('takes no argument at all now, because there was nothing left to carry across', () => {
    // Was "keeps assigneeId, which is about the clause and not about the
    // run". `assigneeId` was the ONLY thing this function carried over from
    // the verification it replaced, so removing the field (P24, Task 22)
    // left a parameter that was read for nothing. `toEqual` would pass on an
    // object with an extra `undefined`-valued key, so absence is asserted
    // the way this project asserts absence.
    const out = resetVerification();
    expect(out).toEqual({ state: 'unchecked' });
    expect(Object.keys(out)).toEqual(['state']);
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

/**
 * M4: the reason a state actually carries.
 *
 * `applyVerification` has dropped a reason on anything but `rejected` since
 * this module existed, and `setDisposition` restated the same rule on the
 * server. A THIRD place — the shadow writer's blob reader — kept the reason
 * for every state and then compared its undropped value against the stored,
 * dropped one. That comparison could never be equal, so a flagged finding
 * carrying a reason wrote a fresh row into the INSERT-only evidence table on
 * every autosave: roughly one every two seconds for the length of a run,
 * burying the one real change, with a `reconcileFindings` discrepancy that
 * no number of saves would clear.
 */
describe('effectiveReason', () => {
  it('keeps a reason only on rejected', () => {
    expect(effectiveReason('rejected', 'The cap is in schedule 6.')).toBe('The cap is in schedule 6.');
    expect(effectiveReason('flagged', 'look at this')).toBeNull();
    expect(effectiveReason('verified', 'look at this')).toBeNull();
    expect(effectiveReason('unchecked', 'look at this')).toBeNull();
  });

  it('answers null, not undefined, so it compares equal to a nullable column', () => {
    // Both database columns are nullable and every caller compares against a
    // stored `reason` that is `null` when absent. `undefined === null` is
    // false, which is exactly the comparison that never settled.
    expect(effectiveReason('flagged')).toBeNull();
    expect(effectiveReason('rejected', '   ')).toBeNull();
  });

  it('trims, so whitespace is not a reason', () => {
    expect(effectiveReason('rejected', '  wrong clause  ')).toBe('wrong clause');
  });

  it('agrees with applyVerification, which is the point of there being one of it', () => {
    const flagged = applyVerification(unchecked(), { state: 'flagged', reason: 'x' }, 'u1', 1);
    expect(flagged.reason).toBeUndefined();
    expect(effectiveReason('flagged', 'x')).toBeNull();
    const rejected = applyVerification(unchecked(), { state: 'rejected', reason: 'x' }, 'u1', 1);
    expect(rejected.reason).toBe('x');
    expect(effectiveReason('rejected', 'x')).toBe('x');
  });
});
