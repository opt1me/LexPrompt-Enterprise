import { describe, it, expect } from 'vitest';
import { progressLabel, progressPercent, verificationCounts } from './reviewProgress';
import type { Finding, Review } from '../types';

function f(state: Finding['verification']['state']): Finding {
  return { clauseId: 'c', status: 'done', citations: [], notes: [], verification: { state } } as Finding;
}

const FINDINGS: Review['findings'] = {
  'doc-1': { a: f('verified'), b: f('verified'), c: f('unchecked'), d: f('flagged') },
};

describe('reviewProgress', () => {
  it('re-exports the same counter the exports use', () => {
    expect(verificationCounts(FINDINGS).verified).toBe(2);
  });

  it('says how many of how many are verified', () => {
    expect(progressLabel(FINDINGS)).toBe('2 of 4 verified');
  });

  it('reports a percentage for a progress bar', () => {
    expect(progressPercent(FINDINGS)).toBe(50);
  });

  it('reports 0 percent rather than NaN for an empty review', () => {
    expect(progressPercent({})).toBe(0);
    expect(progressLabel({})).toBe('0 of 0 verified');
  });

  it('counts only verified toward progress — a flag is not a pass', () => {
    expect(progressPercent({ 'doc-1': { a: f('flagged'), b: f('rejected') } })).toBe(0);
  });
});
