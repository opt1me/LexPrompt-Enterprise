import { describe, it, expect } from 'vitest';
import type { DispositionWithHistory } from '@lexprompt/core';
import { mayApplyNow, sameCell, sameDisposition } from './pendingUpdate';

/**
 * The decision that decides whether a lawyer sees a state change.
 *
 * Two halves, and BOTH are tested here — the brief's own Step 4 says a guard
 * with an untested half is half a guard, and the `busyKey` half is the one
 * that has no visible symptom at all.
 */

const at = (version: number, over: Partial<DispositionWithHistory['disposition']> = {})
: DispositionWithHistory => ({
  disposition: {
    reviewId: 'r1', findingsKey: 'd1', clauseId: 'c1', state: 'verified',
    byUserId: 'u1', at: 1_000, changedCount: 1, version, ...over,
  },
});

describe('may this change be applied now', () => {
  it('applies immediately when nothing is open and nothing is in flight', () => {
    // THE DEFAULT, and it must stay the default. A guard that became "hold
    // everything" would make the app feel broken, which is a second and
    // quieter defect than the one it was written to close.
    expect(mayApplyNow({ busyKey: null, openModalKey: null, findingKey: 'c1' })).toBe(true);
  });

  it('holds while a disposition-composing control is open for THIS finding', () => {
    expect(mayApplyNow({ busyKey: null, openModalKey: 'c1', findingKey: 'c1' })).toBe(false);
  });

  it('holds while a write of THIS finding s disposition is in flight', () => {
    // The half with no visible symptom: an incoming row applied between the
    // request and its answer is then overwritten by the answer, or not,
    // depending on which lands first.
    expect(mayApplyNow({ busyKey: 'c1', openModalKey: null, findingKey: 'c1' })).toBe(false);
  });

  it('does NOT hold for somebody else s open control or somebody else s write', () => {
    // Not "any modal": a guard broader than its reason is a guard nobody can
    // reason about, and this one is read by the socket path as well.
    expect(mayApplyNow({ busyKey: 'c2', openModalKey: 'c3', findingKey: 'c1' })).toBe(true);
  });
});

describe('whether two dispositions are the same row', () => {
  it('compares versions, not object identity', () => {
    // `rememberDispositions` replaces a review's whole map on every read, so
    // every poll hands a card a structurally identical but referentially new
    // object. An identity comparison would announce "changed while you were
    // writing" every few seconds, about a change nobody made.
    expect(at(4)).not.toBe(at(4));
    expect(sameDisposition(at(4), at(4))).toBe(true);
    expect(sameDisposition(at(4), at(5))).toBe(false);
  });

  it('treats a different cell as a different row, never as a change to this one', () => {
    expect(sameDisposition(at(4), at(4, { clauseId: 'c2' }))).toBe(false);
    expect(sameCell(at(4), at(9))).toBe(true);
    expect(sameCell(at(4), at(4, { clauseId: 'c2' }))).toBe(false);
    expect(sameCell(at(4), undefined)).toBe(false);
  });

  it('tells a read disposition apart from one never read', () => {
    expect(sameDisposition(undefined, undefined)).toBe(true);
    expect(sameDisposition(at(1), undefined)).toBe(false);
    expect(sameDisposition(undefined, at(1))).toBe(false);
  });
});
