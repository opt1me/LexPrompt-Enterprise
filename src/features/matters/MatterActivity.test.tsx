import React from 'react';
import { describe, it, expect } from 'vitest';
import { mount } from '../../test/mount';
import { MatterActivity } from './MatterActivity';
import type { Finding, Review } from '../../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'me',
    ...over,
  };
}

describe('MatterActivity', () => {
  it('says nothing is recorded rather than rendering a placeholder row', () => {
    const c = mount(<MatterActivity reviews={[]} localUserId="me" />);
    expect(c.textContent).toContain('Nothing recorded in this matter yet.');
    expect(c.querySelectorAll('li')).toHaveLength(0);
  });

  it('writes your own actions in the first person', () => {
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).toContain('You verified');
    expect(c.textContent).toContain('Break right');
  });

  it('names no second actor for an unrecognised author', () => {
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'ghost', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).toContain('Flagged');
    expect(c.textContent).not.toMatch(/You flagged|by ghost|someone/i);
  });

  it('never says a flag was raised FOR anybody', () => {
    // "…flagged for M. Okafor" is dropped: a flag is flagged, full stop.
    // Flagging reaches no one (R-G1).
    const c = mount(<MatterActivity reviews={[review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'me', at: 300 } }) } },
    })]} localUserId="me" />);
    expect(c.textContent).not.toMatch(/flagged for/i);
  });
});
