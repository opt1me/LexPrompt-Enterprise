import { describe, it, expect } from 'vitest';
import { buildPositionHealthMap, positionPublishedAt } from './positionHealthMap';
import { positionHealthLabel } from './positionHealth';
import {
  SCHEMA_VERSION,
  type Finding, type PlaybookClause, type PlaybookVersion, type Review,
} from '../types';

function clause(id: string, positionText?: string): PlaybookClause {
  const c: PlaybookClause = { id, title: id, extractPrompt: 'p' };
  if (positionText !== undefined) {
    c.standardPosition = { text: positionText, origin: 'authored', reviewedByHuman: true };
  }
  return c;
}

function version(n: number, publishedAt: number, clauses: PlaybookClause[]): PlaybookVersion {
  return {
    id: `v${n}`,
    playbookId: 'pb1',
    version: n,
    name: 'Lease Review',
    contractType: 'Lease',
    systemPrompt: 's',
    formatPrompt: 'f',
    clauses,
    changeSummary: n === 1 ? '' : `changed in v${n}`,
    publishedAt,
    publishedByUserId: 'u1',
    schemaVersion: SCHEMA_VERSION,
  };
}

function finding(
  clauseId: string,
  outcome: 'meets' | 'deviates' | 'unclear' | undefined,
  verifiedAt?: number,
): Finding {
  const f: Finding = {
    clauseId,
    status: 'done',
    summary: 'x',
    citations: [],
    verification: verifiedAt === undefined
      ? { state: 'unchecked' }
      : { state: 'verified', byUserId: 'u1', at: verifiedAt },
    notes: [],
  };
  if (outcome !== undefined) f.positionOutcome = outcome;
  return f;
}

function review(
  id: string,
  matterId: string,
  playbookVersionId: string | undefined,
  findings: Record<string, Record<string, Finding>>,
): Review {
  const r: Review = {
    id,
    matterId,
    playbookSnapshot: version(1, 1000, []),
    documentIds: ['d1'],
    target: { kind: 'documents', documentIds: ['d1'] },
    findings,
    modelId: 'm',
    startedAt: 1,
    createdByUserId: 'u1',
  };
  if (playbookVersionId !== undefined) r.playbookVersionId = playbookVersionId;
  return r;
}

describe('positionPublishedAt — R-D17', () => {
  // The bug this exists to avoid: publish v5 to change clause B, and clause
  // A — untouched, verified for months — suddenly reads UNTESTED, because
  // `positionHealth` discards every verification older than the date it is
  // given. "Nobody has tested this" and "we forgot what we knew" are
  // different claims, and the app would be making the first one falsely.
  it('dates a position from the version its text last changed in, not the newest one', () => {
    const versions = [
      version(3, 3000, [clause('a', 'Six months.'), clause('b', 'Capped.')]),
      version(2, 2000, [clause('a', 'Six months.'), clause('b', 'Uncapped.')]),
      version(1, 1000, [clause('a', 'Six months.')]),
    ];
    expect(positionPublishedAt(versions, 'a', 'Six months.')).toBe(1000);
  });

  it('dates a position from the version that changed it when it did change', () => {
    const versions = [
      version(3, 3000, [clause('a', 'Nine months.')]),
      version(2, 2000, [clause('a', 'Nine months.')]),
      version(1, 1000, [clause('a', 'Six months.')]),
    ];
    expect(positionPublishedAt(versions, 'a', 'Nine months.')).toBe(2000);
  });

  // A position reverted to earlier wording was still CHANGED in between,
  // so the run of versions carrying the current text starts at v3 — not at
  // v1, whose date would let a verification made while v2 said something
  // else count towards the wording it disagreed with.
  it('dates from the latest run of unchanged versions, not an earlier spell of the same wording', () => {
    const versions = [
      version(3, 3000, [clause('a', 'Six months.')]),
      version(2, 2000, [clause('a', 'Nine months.')]),
      version(1, 1000, [clause('a', 'Six months.')]),
    ];
    expect(positionPublishedAt(versions, 'a', 'Six months.')).toBe(3000);
  });

  it('has no date for wording that has never been published', () => {
    const versions = [version(1, 1000, [clause('a', 'Six months.')])];
    expect(positionPublishedAt(versions, 'a', 'Six months, no conditions.')).toBeUndefined();
  });

  it('has no date for a clause the published versions do not carry', () => {
    const versions = [version(1, 1000, [clause('a', 'Six months.')])];
    expect(positionPublishedAt(versions, 'b', 'Anything.')).toBeUndefined();
  });

  // The order the caller happens to pass is not allowed to change the
  // answer: a wrong date is silently wrong, and this one governs whether
  // months of evidence are counted or discarded.
  it('does not depend on the order the caller passes versions in', () => {
    const v1 = version(1, 1000, [clause('a', 'Six months.')]);
    const v2 = version(2, 2000, [clause('a', 'Six months.')]);
    expect(positionPublishedAt([v1, v2], 'a', 'Six months.')).toBe(1000);
    expect(positionPublishedAt([v2, v1], 'a', 'Six months.')).toBe(1000);
  });
});

describe('buildPositionHealthMap', () => {
  const versions = [
    version(2, 2000, [clause('a', 'Six months.'), clause('b', 'Capped.')]),
    version(1, 1000, [clause('a', 'Six months.'), clause('b', 'Uncapped.')]),
  ];
  const clauses = [clause('a', 'Six months.'), clause('b', 'Capped.')];

  it('shows HELD n of m from verified findings across every matter', () => {
    const reviews = [
      review('r1', 'm1', 'v1', { d1: { a: finding('a', 'meets', 1500) } }),
      review('r2', 'm2', 'v2', { d2: { a: finding('a', 'meets', 2500) } }),
    ];
    const map = buildPositionHealthMap({ clauses, versions, reviews });
    expect(positionHealthLabel(map.a!)).toBe('HELD 2 of 2');
  });

  it('does not reset a position history when an UNRELATED clause is republished', () => {
    // Clause b's position changed in v2; clause a's did not. A verification
    // made against a while v1 was current must survive b's republish.
    const reviews = [review('r1', 'm1', 'v1', { d1: { a: finding('a', 'meets', 1500) } })];
    const map = buildPositionHealthMap({ clauses, versions, reviews });
    expect(positionHealthLabel(map.a!)).toMatch(/HELD/);
    // Dating from the current version's publishedAt (2000) would have made
    // this UNTESTED — the whole point of R-D17.
    expect(positionHealthLabel(map.a!)).not.toBe('UNTESTED');
  });

  it('does discard a verification made against wording the position no longer has', () => {
    // Clause b's text DID change in v2, so a verification from v1's era
    // tested a sentence that is no longer the firm's position.
    const reviews = [review('r1', 'm1', 'v1', { d1: { b: finding('b', 'meets', 1500) } })];
    const map = buildPositionHealthMap({ clauses, versions, reviews });
    expect(positionHealthLabel(map.b!)).toBe('UNTESTED');
  });

  it('ignores reviews that ran against a version of some other playbook', () => {
    const reviews = [review('r1', 'm1', 'other-version', { d1: { a: finding('a', 'meets', 1500) } })];
    expect(positionHealthLabel(buildPositionHealthMap({ clauses, versions, reviews }).a!))
      .toBe('UNTESTED');
  });

  it('ignores a review that never recorded which version it ran against', () => {
    const reviews = [review('r1', 'm1', undefined, { d1: { a: finding('a', 'meets', 1500) } })];
    expect(positionHealthLabel(buildPositionHealthMap({ clauses, versions, reviews }).a!))
      .toBe('UNTESTED');
  });

  // A collection review keys its findings by the COLLECTION id, not a
  // document id (R-C5). Health asks "what has this position been tested
  // against", which is every finding for the clause under whatever key.
  it('counts findings keyed by a collection as well as by a document', () => {
    const reviews = [
      review('r1', 'm1', 'v1', { 'coll-1': { a: finding('a', 'deviates', 1500) } }),
    ];
    expect(positionHealthLabel(buildPositionHealthMap({ clauses, versions, reviews }).a!))
      .toBe('CONCEDED 1 times');
  });

  // "We have no house rule here" is not a health state — it is the absence
  // of the question. An entry would render a chip on every clause.
  it('gives no entry at all for a clause with no standard position', () => {
    const map = buildPositionHealthMap({
      clauses: [clause('a', 'Six months.'), clause('c')],
      versions,
      reviews: [],
    });
    expect('c' in map).toBe(false);
    expect('a' in map).toBe(true);
  });

  // An edited-but-unpublished position has never been tested by anything,
  // because no review has ever run against those words.
  it('reports an unpublished edit to a position as untested', () => {
    const reviews = [review('r1', 'm1', 'v1', { d1: { a: finding('a', 'meets', 1500) } })];
    const map = buildPositionHealthMap({
      clauses: [clause('a', 'Six months, no conditions.')],
      versions,
      reviews,
    });
    expect(positionHealthLabel(map.a!)).toBe('UNTESTED');
  });

  it('never counts an unverified finding, however confident the model was', () => {
    const reviews = [review('r1', 'm1', 'v1', { d1: { a: finding('a', 'meets') } })];
    expect(positionHealthLabel(buildPositionHealthMap({ clauses, versions, reviews }).a!))
      .toBe('UNTESTED');
  });
});
