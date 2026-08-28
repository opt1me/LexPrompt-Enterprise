import { describe, it, expect } from 'vitest';
import { matterActivity } from './matterActivity';
import type { Finding, Review } from '../types';

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1',
    playbookSnapshot: { id: 'v1', playbookId: 'p1', version: 1, name: 'Lease review', contractType: 'lease', systemPrompt: '', formatPrompt: '', clauses: [{ id: 'c1', title: 'Break right', extractPrompt: '' }], changeSummary: '', publishedAt: 1, publishedByUserId: 'u1', schemaVersion: 6 },
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 100, createdByUserId: 'u1',
    ...over,
  };
}

describe('matterActivity', () => {
  it('derives an entry per human action, newest first', () => {
    const entries = matterActivity([review({
      startedAt: 100, completedAt: 200,
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me', at: 300 } }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['verified', 'review-completed', 'review-started']);
    expect(entries[0].at).toBe(300);
    expect(entries[0].clauseTitle).toBe('Break right');
    expect(entries[0].reviewName).toBe('Lease review');
  });

  it('marks an action by the local profile as yours', () => {
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'flagged', byUserId: 'me', at: 400 } }) } },
    })], 'me');
    expect(entry).toMatchObject({ kind: 'flagged', byYou: true });
  });

  it('does not claim an unrecognised author is you, and invents no other name', () => {
    // R-GP5: there is no store of other display names. The honest render is
    // the event with no actor, never "someone else".
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'rejected', byUserId: 'ghost', reason: 'x', at: 400 } }) } },
    })], 'me');
    expect(entry.byYou).toBe(false);
    expect(Object.values(entry)).not.toContain('ghost');
  });

  it('derives notes and net-position confirmations', () => {
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({
        notes: [{ id: 'n1', findingId: 'd1::c1', text: 'Ask the client.', byUserId: 'me', at: 500 }],
        netPosition: { proposed: 'Six months.', state: 'confirmed', byUserId: 'me', at: 600, trail: [] },
      }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['net-confirmed', 'note', 'review-started']);
  });

  it('reports an amended net position as amended, not merely confirmed', () => {
    const [entry] = matterActivity([review({
      findings: { d1: { c1: finding({
        netPosition: { proposed: 'Six months.', amended: 'Nine months.', state: 'confirmed', byUserId: 'me', at: 700, trail: [] },
      }) } },
    })], 'me');
    // Amending is a STRONGER claim than confirming — a person wrote every
    // word — so the feed must not flatten it into "confirmed".
    expect(entry.kind).toBe('net-amended');
  });

  it('skips an unchecked verification, which is not an action anyone took', () => {
    const entries = matterActivity([review({ findings: { d1: { c1: finding() } } })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['review-started']);
  });

  it('skips a verification with no timestamp rather than dating it now', () => {
    const entries = matterActivity([review({
      findings: { d1: { c1: finding({ verification: { state: 'verified', byUserId: 'me' } }) } },
    })], 'me');
    expect(entries.map(e => e.kind)).toEqual(['review-started']);
  });

  it('caps the list', () => {
    const findings: Record<string, Record<string, Finding>> = { d1: {} };
    for (let i = 0; i < 40; i++) {
      findings.d1[`c${i}`] = finding({ clauseId: `c${i}`, verification: { state: 'verified', byUserId: 'me', at: 1000 + i } });
    }
    expect(matterActivity([review({ findings })], 'me', 20)).toHaveLength(20);
  });
});
