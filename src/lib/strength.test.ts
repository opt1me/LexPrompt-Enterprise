import { describe, it, expect } from 'vitest';
import { computeStrength, isContradicted, strengthLabel } from './strength';
import type { BasisEntry } from './strength';

// Helpers the brief's own snippets use without defining: a supporting and an
// opposing BasisEntry for a given document id.
function s(documentId: string): BasisEntry {
  return { documentId, supports: true };
}
function o(documentId: string): BasisEntry {
  return { documentId, supports: false };
}

describe('computeStrength', () => {
  it('is consistent when every document supports it', () => {
    expect(computeStrength([s('a'), s('b'), s('c'), s('d')])).toBe('consistent');
  });

  it('is weak on a single instance, even a supporting one', () => {
    // One strike may have been a trade on that deal, not a policy. This is the
    // distinction the whole feature turns on.
    expect(computeStrength([s('a')])).toBe('weak');
  });

  it('is mixed when documents disagree', () => {
    expect(computeStrength([s('a'), s('b'), o('c')])).toBe('mixed');
  });

  it('is mixed, not consistent, when one of many opposes', () => {
    expect(computeStrength([s('a'), s('b'), s('c'), o('d')])).toBe('mixed');
  });

  it('a single OPPOSING instance is weak, not consistent', () => {
    // `supporting === total` must not be satisfied by 0 === 0.
    expect(computeStrength([o('a')])).toBe('weak');
  });

  it('an empty basis is weak and never consistent', () => {
    // Vacuous unanimity is the exact shape of "guessed from silence".
    expect(computeStrength([])).toBe('weak');
  });
});

describe('isContradicted', () => {
  it('sets contradicted only when the basis actually disagrees', () => {
    expect(isContradicted([s('a'), o('b')])).toBe(true);
    expect(isContradicted([s('a'), s('b')])).toBe(false);
    expect(isContradicted([])).toBe(false);
  });
});

describe('strengthLabel', () => {
  it('labels n of m honestly', () => {
    expect(strengthLabel('consistent', 4, 4)).toBe('Consistent — 4 of 4');
    expect(strengthLabel('mixed', 3, 4)).toBe('Mixed — 3 of 4');
    expect(strengthLabel('weak', 1, 1)).toBe('Weak — a single instance');
  });
});
