import { describe, it, expect } from 'vitest';
import { buildPositionRows } from './standardPositions';
import type { Playbook, PlaybookVersion, Review, Finding } from '../types';

function version(over: Partial<PlaybookVersion> = {}): PlaybookVersion {
  return {
    id: 'v1', playbookId: 'p1', version: 1, name: 'Lease', contractType: 'lease',
    systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '',
    publishedAt: 100, publishedByUserId: 'me', schemaVersion: 6, ...over,
  };
}
const playbook: Playbook = { id: 'p1', name: 'Lease', createdAt: 1, updatedAt: 1, currentVersionId: 'v1', schemaVersion: 6 };

function finding(over: Partial<Finding> = {}): Finding {
  return { clauseId: 'c1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...over };
}
function review(over: Partial<Review> = {}): Review {
  return {
    id: 'r1', matterId: 'm1', playbookSnapshot: version(), playbookVersionId: 'v1',
    documentIds: ['d1'], target: { kind: 'documents', documentIds: ['d1'] },
    findings: {}, modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'me', ...over,
  };
}

describe('buildPositionRows', () => {
  it('returns one row per clause that carries a standard position', () => {
    const v = version({ clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
      { id: 'c2', title: 'Rent', extractPrompt: '' },
    ] });
    const rows = buildPositionRows({ playbooks: [{ playbook, versions: [v] }], reviews: [] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ playbookName: 'Lease', clauseTitle: 'Break right', positionText: 'Six months.' });
  });

  it('reports health from verified findings, through D’s own derivation', () => {
    const v = version({ clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
    ] });
    const rows = buildPositionRows({
      playbooks: [{ playbook, versions: [v] }],
      reviews: [review({ findings: { d1: { c1: finding({ positionOutcome: 'deviates', verification: { state: 'verified', byUserId: 'me', at: 200 } }) } } })],
    });
    expect(rows[0].health).toEqual({ kind: 'conceded', count: 1 });
  });

  it('sorts conceded first, then untested, then held', () => {
    const clause = (id: string, text: string) =>
      ({ id, title: id, extractPrompt: '', standardPosition: { text, origin: 'authored' as const, reviewedByHuman: true } });
    const v = version({ clauses: [clause('c1', 'Held.'), clause('c2', 'Untested.'), clause('c3', 'Conceded.')] });
    const rows = buildPositionRows({
      playbooks: [{ playbook, versions: [v] }],
      reviews: [review({ findings: { d1: {
        c1: finding({ clauseId: 'c1', positionOutcome: 'meets', verification: { state: 'verified', byUserId: 'me', at: 200 } }),
        c3: finding({ clauseId: 'c3', positionOutcome: 'deviates', verification: { state: 'verified', byUserId: 'me', at: 200 } }),
      } } })],
    });
    // The ordering IS the answer to the question the screen exists to ask.
    expect(rows.map(r => r.health.kind)).toEqual(['conceded', 'untested', 'held']);
  });

  it('reads the current published version only, never a draft', () => {
    const v1 = version({ id: 'v1', version: 1, clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'Six months.', origin: 'authored', reviewedByHuman: true } },
    ] });
    const withDraft: Playbook = { ...playbook, draft: { name: 'Lease', contractType: 'lease', systemPrompt: '', formatPrompt: '', changeSummary: '', clauses: [
      { id: 'c1', title: 'Break right', extractPrompt: '', standardPosition: { text: 'NINE months.', origin: 'authored', reviewedByHuman: true } },
    ] } };
    const rows = buildPositionRows({ playbooks: [{ playbook: withDraft, versions: [v1] }], reviews: [] });
    // A draft is unpublished: no review has ever run against it, so
    // reporting its wording here would attribute evidence to words nothing
    // was measured against.
    expect(rows[0].positionText).toBe('Six months.');
  });

  it('skips a playbook that has never been published', () => {
    const unpublished: Playbook = { id: 'p2', name: 'New', createdAt: 1, updatedAt: 1, schemaVersion: 6 };
    expect(buildPositionRows({ playbooks: [{ playbook: unpublished, versions: [] }], reviews: [] })).toEqual([]);
  });
});
