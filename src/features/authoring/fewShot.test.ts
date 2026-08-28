import { describe, expect, it } from 'vitest';
import { buildFewShot, usedFewShotSources, type FewShotSource } from './fewShot';
import type { Finding, Playbook, PlaybookClause, PlaybookVersion, Review, Verification, VerificationState } from '../../types';

// Fixtures. None of these exist anywhere else in the repo — every helper
// below is defined for this file only. Named `verifiedFinding` /
// `uncheckedFinding`, never `verified` / `unchecked`: `src/lib/verification.ts`
// already exports `unchecked()`, and shadowing it is this codebase's most
// repeated defect shape.

function verification(state: VerificationState): Verification {
  return state === 'rejected'
    ? { state, byUserId: 'u1', at: 1, reason: 'wrong' }
    : { state, byUserId: 'u1', at: 1 };
}

function findingInState(state: VerificationState, summary: string): Finding {
  return {
    clauseId: 'c1',
    status: 'done',
    summary,
    citations: [],
    verification: verification(state),
    notes: [],
  };
}

function verifiedFinding(summary: string): Finding {
  return findingInState('verified', summary);
}

function uncheckedFinding(summary: string): Finding {
  return findingInState('unchecked', summary);
}

function reviewWith(finding: Finding, matterId = 'm1'): Review {
  return {
    id: 'r1',
    matterId,
    playbookSnapshot: {
      id: 'v1', playbookId: 'pb-src', version: 1, name: 'Snapshot', contractType: 'Lease',
      systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '', publishedAt: 0,
      publishedByUserId: 'u1', schemaVersion: 6,
    },
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings: { d1: { c1: finding } },
    modelId: 'test/model',
    startedAt: 0,
    createdByUserId: 'u1',
  };
}

function playbookClause(title: string, standardPositionText?: string): PlaybookClause {
  return {
    id: `c-${title}`,
    title,
    extractPrompt: `Find ${title}.`,
    ...(standardPositionText
      ? { standardPosition: { text: standardPositionText, origin: 'authored' as const, reviewedByHuman: true } }
      : {}),
  };
}

function versionWith(playbookId: string, title: string, standardPositionText: string): PlaybookVersion {
  return {
    id: `${playbookId}-current`, playbookId, version: 1, name: 'Snapshot', contractType: 'Lease',
    systemPrompt: '', formatPrompt: '', clauses: [playbookClause(title, standardPositionText)],
    changeSummary: '', publishedAt: 0, publishedByUserId: 'u1', schemaVersion: 6,
  };
}

function playbook(id: string): Playbook {
  return {
    id, name: 'Lease template', createdAt: 0, updatedAt: 0,
    currentVersionId: `${id}-current`, schemaVersion: 6,
  };
}

describe('buildFewShot', () => {
  it('includes a verified finding as style material', () => {
    const out = buildFewShot([], [], [reviewWith(verifiedFinding('The cap is 125% of the Charges.'))],
      [{ kind: 'matter', id: 'm1', name: 'Acme' } as FewShotSource]);
    expect(out).toContain('The cap is 125% of the Charges.');
  });

  it('EXCLUDES an unverified finding', () => {
    // An unverified finding is the model's own output. Feeding it back as
    // house style launders a guess into a rule — the single rule this
    // function exists to enforce.
    const out = buildFewShot([], [], [reviewWith(uncheckedFinding('The cap is 125%.'))],
      [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
    expect(out).not.toContain('The cap is 125%.');
  });

  it('excludes a flagged or rejected finding too', () => {
    for (const state of ['flagged', 'rejected'] as const) {
      const out = buildFewShot([], [], [reviewWith(findingInState(state, 'Suspect text.'))],
        [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
      expect(out).not.toContain('Suspect text.');
    }
  });

  it("includes a selected playbook's clause titles and standard positions", () => {
    const out = buildFewShot([playbook('pb1')], [versionWith('pb1', 'Break', 'We ask for six months.')], [],
      [{ kind: 'playbook', id: 'pb1', name: 'Lease' }]);
    expect(out).toContain('Break');
    expect(out).toContain('We ask for six months.');
  });

  it('ignores sources that were not selected', () => {
    const out = buildFewShot([playbook('pb1')], [versionWith('pb1', 'Break', 'x')], [], []);
    expect(out).toBe('');
  });

  it('ignores a matter with no verified findings at all (only unverified/flagged/rejected)', () => {
    const out = buildFewShot([], [], [
      reviewWith(uncheckedFinding('a')),
    ], [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
    expect(out).toBe('');
  });

  it('ignores a review belonging to a different matter than the one selected', () => {
    const out = buildFewShot([], [], [reviewWith(verifiedFinding('Only in matter X.'), 'm-other')],
      [{ kind: 'matter', id: 'm1', name: 'Acme' }]);
    expect(out).not.toContain('Only in matter X.');
  });

  it('ignores a selected playbook that has never been published (no currentVersionId)', () => {
    const draftOnly: Playbook = { id: 'pb2', name: 'Draft only', createdAt: 0, updatedAt: 0, schemaVersion: 6 };
    const out = buildFewShot([draftOnly], [], [], [{ kind: 'playbook', id: 'pb2', name: 'Draft only' }]);
    expect(out).toBe('');
  });
});

// m2 (final honesty review, sub-projects D/E): `learnedFrom` must name only
// sources that actually contributed material. `usedFewShotSources` is what
// a caller populates it from — these tests pin it against the exact
// scenarios `buildFewShot`'s own suite above already treats as "contributed
// nothing", so the two functions can never quietly disagree.
describe('usedFewShotSources', () => {
  it('excludes a matter with zero verified findings — the common case, not the edge case', () => {
    const source: FewShotSource = { kind: 'matter', id: 'm1', name: 'Acme' };
    const used = usedFewShotSources([], [], [reviewWith(uncheckedFinding('a'))], [source]);
    expect(used).toEqual([]);
  });

  it('includes a matter whose verified findings actually contributed', () => {
    const source: FewShotSource = { kind: 'matter', id: 'm1', name: 'Acme' };
    const used = usedFewShotSources([], [], [reviewWith(verifiedFinding('The cap is 125%.'))], [source]);
    expect(used).toEqual([source]);
  });

  it('excludes a playbook that has never been published', () => {
    const draftOnly: Playbook = { id: 'pb2', name: 'Draft only', createdAt: 0, updatedAt: 0, schemaVersion: 6 };
    const source: FewShotSource = { kind: 'playbook', id: 'pb2', name: 'Draft only' };
    const used = usedFewShotSources([draftOnly], [], [], [source]);
    expect(used).toEqual([]);
  });

  it('includes a playbook whose current version actually contributed clauses', () => {
    const source: FewShotSource = { kind: 'playbook', id: 'pb1', name: 'Lease' };
    const used = usedFewShotSources(
      [playbook('pb1')], [versionWith('pb1', 'Break', 'We ask for six months.')], [], [source],
    );
    expect(used).toEqual([source]);
  });

  it('reports only the sources that contributed, not every selected source', () => {
    const contributed: FewShotSource = { kind: 'matter', id: 'm1', name: 'Acme' };
    const empty: FewShotSource = { kind: 'matter', id: 'm2', name: 'Bolt' };
    const used = usedFewShotSources(
      [], [], [reviewWith(verifiedFinding('The cap is 125%.'), 'm1')], [contributed, empty],
    );
    expect(used).toEqual([contributed]);
  });
});
