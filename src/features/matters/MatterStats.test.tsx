import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount, buttonNamed } from '../../test/mount';
import { MatterStats } from './MatterStats';
import type { Finding, Review } from '../../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding({ verification: { state: 'verified' } }), c2: finding() } },
    modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    ...over,
  };
}

describe('MatterStats', () => {
  it('shows the verified count over the total once a review has completed', () => {
    const c = mount(<MatterStats reviews={[review()]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('1');
    expect(c.textContent).toContain('of 2 findings verified');
  });

  it('renders the empty form, not three zeroes, when no review has completed', () => {
    // R-G10. "0 of 0 findings verified" reads as "nothing outstanding".
    const c = mount(<MatterStats reviews={[]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('No review has run yet');
    expect(c.textContent).not.toContain('of 0 findings verified');
  });

  it('says a run is in progress rather than presenting partial counts as final', () => {
    const c = mount(<MatterStats reviews={[review({ completedAt: undefined })]} reviewsError={null} onRetryReviews={() => {}} />);
    expect(c.textContent).toContain('A review is still running');
  });

  it('renders the load-error panel IN PLACE OF the stat row, with a retry', () => {
    // The stats are derived from the reviews. If the reviews are unknown
    // the statistics are unknown — never zeroes beneath an error.
    const c = mount(
      <MatterStats reviews={[]} reviewsError="This matter's reviews could not be loaded." onRetryReviews={() => {}} />,
    );
    expect(c.textContent).toContain("This matter's reviews could not be loaded.");
    expect(c.textContent).not.toContain('findings verified');
    expect(c.textContent).not.toContain('No review has run yet');
    expect(buttonNamed(c, /^Retry$/)).toBeTruthy();
  });

  it('counts what needs attention without inventing an owner', () => {
    const c = mount(<MatterStats
      reviews={[review({ findings: { d1: { c1: finding({ verification: { state: 'flagged' } }), c2: finding({ positionOutcome: 'deviates' }) } } })]}
      reviewsError={null}
      onRetryReviews={() => {}}
    />);
    expect(c.textContent).toContain('Flagged for follow-up');
    expect(c.textContent).toContain('Deviating from a standard position');
    // The mockup's third count — "unassigned / no owner" — is dropped:
    // nothing assigns to anyone (R-G1).
    expect(c.textContent).not.toMatch(/unassigned|no owner|assigned to/i);
  });
});
