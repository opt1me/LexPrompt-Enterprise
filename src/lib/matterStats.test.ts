import { describe, it, expect } from 'vitest';
import { summariseMatter } from './matterStats';
import type { Finding, Review } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}

function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    ...over,
  };
}

describe('summariseMatter', () => {
  it('sums verification counts across every review in the matter', () => {
    const s = summariseMatter([
      review({ id: 'r1', findings: { d1: { c1: finding({ verification: { state: 'verified' } }), c2: finding() } } }),
      review({ id: 'r2', findings: { d2: { c1: finding({ verification: { state: 'flagged' } }) } } }),
    ]);
    expect(s.counts).toEqual({ total: 3, verified: 1, unchecked: 1, flagged: 1, rejected: 0 });
  });

  it('counts what needs attention: flagged findings and deviations', () => {
    const s = summariseMatter([review({
      findings: { d1: {
        c1: finding({ verification: { state: 'flagged' } }),
        c2: finding({ positionOutcome: 'deviates' }),
        c3: finding({ positionOutcome: 'meets' }),
      } },
    })]);
    expect(s.needsAttention).toEqual({ flagged: 1, deviating: 1, hasPosition: true });
  });

  it('reports no standard position (not a zero deviating count) when no finding anywhere carries one', () => {
    // The defect found by driving the app: a matter where nothing was ever
    // compared to a house position rendered "0 Deviating from a standard
    // position" — a zero that reads as "compared, none deviated" when
    // nothing was compared at all. `hasPosition` is the only way a caller
    // can tell "no comparison happened" apart from "compared, zero deviated".
    const s = summariseMatter([review({
      findings: { d1: { c1: finding(), c2: finding({ verification: { state: 'flagged' } }) } },
    })]);
    expect(s.needsAttention).toEqual({ flagged: 1, deviating: 0, hasPosition: false });
  });

  it('does not count a positionOutcome carried onto a non-done finding', () => {
    // Mirrors TabularReview's own guard (`isVerifiable`/`hasStandingPosition`):
    // a comparison attached to a finding with no settled output must not be
    // counted, and must not flip `hasPosition` to true either.
    const s = summariseMatter([review({
      findings: { d1: { c1: finding({ status: 'error', error: 'boom', positionOutcome: 'deviates' }) } },
    })]);
    expect(s.needsAttention).toEqual({ flagged: 0, deviating: 0, hasPosition: false });
  });

  it('counts risk levels, ignoring findings the model never rated', () => {
    const s = summariseMatter([review({
      findings: { d1: {
        c1: finding({ riskLevel: 'High' }), c2: finding({ riskLevel: 'High' }),
        c3: finding({ riskLevel: 'Low' }), c4: finding({ status: 'error' }),
      } },
    })]);
    expect(s.risk).toEqual({ High: 2, Medium: 0, Low: 1, Info: 0 });
  });

  it('reports zero completed reviews for a matter whose only review is still running', () => {
    // R-G10: this is what stops the cards rendering three zeroes. Zero
    // verified out of zero is not a fact about this matter's safety.
    const s = summariseMatter([review({ completedAt: undefined })]);
    expect(s.completedReviews).toBe(0);
    expect(s.running).toBe(true);
  });

  it('does not count a cancelled review as running', () => {
    const s = summariseMatter([review({ completedAt: undefined, cancelledAt: 5 })]);
    expect(s.running).toBe(false);
    expect(s.completedReviews).toBe(0);
  });

  it('returns an all-zero summary with no completed reviews for an empty matter', () => {
    const s = summariseMatter([]);
    expect(s.completedReviews).toBe(0);
    expect(s.counts.total).toBe(0);
  });
});
