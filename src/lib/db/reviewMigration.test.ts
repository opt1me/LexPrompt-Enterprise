import { describe, it, expect } from 'vitest';
import { migrateReviewRecord } from './reviewMigration';
import { migrateDocumentRecord } from './documents';

function legacyReview() {
  return {
    id: 'rev-1',
    matterId: 'matter-1',
    playbookSnapshot: { id: 'pb', name: 'PB', contractType: 'NDA', mode: 'extraction', systemPrompt: '', formatPrompt: '', clauses: [], createdAt: 0, updatedAt: 0, schemaVersion: 2 },
    documentIds: ['doc-1'],
    findings: {
      'doc-1': {
        'clause-1': {
          clauseId: 'clause-1',
          status: 'done',
          summary: 'Capped at the Charges.',
          citations: ['Liability is capped at the Charges.'],
          riskLevel: 'Medium',
          riskAnalysis: 'Standard.',
        },
      },
    },
    modelId: 'some/model',
    startedAt: 10,
    completedAt: 20,
    createdByUserId: 'user-1',
  };
}

describe('migrateReviewRecord', () => {
  it('upgrades string citations to attributed citations against their own document', () => {
    const review = migrateReviewRecord(legacyReview());
    expect(review.findings['doc-1']['clause-1'].citations).toEqual([
      { quote: 'Liability is capped at the Charges.', documentId: 'doc-1' },
    ]);
  });

  it('derives pages when a document text lookup is supplied', () => {
    const review = migrateReviewRecord(legacyReview(), () =>
      '[Page 1]\nIntro.\n\n[Page 2]\nLiability is capped at the Charges.\n\n');
    expect(review.findings['doc-1']['clause-1'].citations[0].page).toBe(2);
  });

  it('marks every migrated finding unchecked — nothing was ever verified before B existed', () => {
    const review = migrateReviewRecord(legacyReview());
    expect(review.findings['doc-1']['clause-1'].verification).toEqual({ state: 'unchecked' });
    expect(review.findings['doc-1']['clause-1'].notes).toEqual([]);
  });

  it('leaves an already-migrated review untouched, including its verification', () => {
    const finding = {
      clauseId: 'clause-1',
      status: 'done',
      summary: 'Capped.',
      citations: [{ quote: 'q', documentId: 'doc-1', page: 3 }],
      verification: { state: 'verified', byUserId: 'user-1', at: 55 },
      notes: [{ id: 'n1', findingId: 'doc-1::clause-1', text: 'ok', byUserId: 'user-1', at: 56 }],
    };
    const input = { ...legacyReview(), findings: { 'doc-1': { 'clause-1': finding } } };
    const review = migrateReviewRecord(input);
    expect(review.findings['doc-1']['clause-1'].verification).toEqual({ state: 'verified', byUserId: 'user-1', at: 55 });
    expect(review.findings['doc-1']['clause-1'].citations).toEqual([{ quote: 'q', documentId: 'doc-1', page: 3 }]);
    expect(review.findings['doc-1']['clause-1'].notes).toHaveLength(1);
  });

  it('is idempotent', () => {
    const once = migrateReviewRecord(legacyReview());
    const twice = migrateReviewRecord(once);
    expect(twice).toEqual(once);
  });

  it('repairs a malformed finding rather than dropping it', () => {
    const input = {
      ...legacyReview(),
      findings: { 'doc-1': { 'clause-1': { summary: 'orphaned', citations: 'not an array' } } },
    };
    const finding = migrateReviewRecord(input).findings['doc-1']['clause-1'];
    expect(finding.summary).toBe('orphaned');
    expect(finding.clauseId).toBe('clause-1');   // recovered from its own key
    expect(finding.status).toBe('error');        // unknown status is not silently 'done'
    expect(finding.citations).toEqual([]);
    expect(finding.verification).toEqual({ state: 'unchecked' });
  });

  it('keeps an unrecognised finding status out of done', () => {
    const input = {
      ...legacyReview(),
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'weird', citations: [] } } },
    };
    expect(migrateReviewRecord(input).findings['doc-1']['clause-1'].status).toBe('error');
  });

  it('survives a findings map that is missing or not an object', () => {
    expect(migrateReviewRecord({ ...legacyReview(), findings: undefined }).findings).toEqual({});
    expect(migrateReviewRecord({ ...legacyReview(), findings: 'nope' }).findings).toEqual({});
  });

  it('does not mutate the record it was given', () => {
    const input = legacyReview();
    migrateReviewRecord(input);
    expect(input.findings['doc-1']['clause-1'].citations).toEqual(['Liability is capped at the Charges.']);
  });

  it('does not alias input citation arrays even for a record that already looks migrated', () => {
    const input = {
      ...legacyReview(),
      findings: {
        'doc-1': {
          'clause-1': {
            clauseId: 'clause-1',
            status: 'done',
            citations: [{ quote: 'q', documentId: 'doc-1' }],
            verification: { state: 'unchecked' },
            notes: [],
          },
        },
      },
    };
    const output = migrateReviewRecord(input);
    output.findings['doc-1']['clause-1'].citations.push({ quote: 'new', documentId: 'doc-1' });
    expect(input.findings['doc-1']['clause-1'].citations).toHaveLength(1);
  });

  it('comes back unchecked when a stored rejection has no reason', () => {
    const input = {
      ...legacyReview(),
      findings: {
        'doc-1': {
          'clause-1': {
            clauseId: 'clause-1',
            status: 'done',
            citations: [],
            verification: { state: 'rejected' },
          },
        },
      },
    };
    expect(migrateReviewRecord(input).findings['doc-1']['clause-1'].verification).toEqual({ state: 'unchecked' });
  });

  describe('target (Task 6)', () => {
    it('migrates a review with documentIds and no target into a documents target', () => {
      const review = migrateReviewRecord(legacyReview());
      expect(review.target).toEqual({ kind: 'documents', documentIds: ['doc-1'] });
    });

    it('retains documentIds alongside target — every existing consumer reads it', () => {
      const review = migrateReviewRecord(legacyReview());
      expect(review.documentIds).toEqual(['doc-1']);
      expect('documentIds' in review).toBe(true);
    });

    // Ruling F-C1: two copies of one list is this project's signature
    // defect shape. `target.documentIds` must be rebuilt from the
    // top-level `Review.documentIds` on EVERY read, even when a target is
    // already stored — never trusted as its own source of truth.
    it('F-C1: rebuilds target.documentIds from Review.documentIds even when a stored target disagrees', () => {
      const input = {
        ...legacyReview(),
        documentIds: ['doc-1', 'doc-2'],
        target: { kind: 'documents', documentIds: ['doc-1'] },
      };
      const review = migrateReviewRecord(input);
      expect(review.target).toEqual({ kind: 'documents', documentIds: ['doc-1', 'doc-2'] });
      expect(review.documentIds).toEqual(['doc-1', 'doc-2']);
    });

    it('keeps a collection target\'s kind and collectionId, re-deriving only its documentIds', () => {
      const input = {
        ...legacyReview(),
        documentIds: ['doc-1', 'doc-2'],
        target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['doc-1'] },
      };
      const review = migrateReviewRecord(input);
      expect(review.target).toEqual({ kind: 'collection', collectionId: 'coll-1', documentIds: ['doc-1', 'doc-2'] });
    });

    it('defaults to an empty documents target when neither target nor documentIds is present, rather than an absent target', () => {
      const input = { ...legacyReview(), documentIds: undefined, target: undefined };
      const review = migrateReviewRecord(input);
      expect(review.target).toEqual({ kind: 'documents', documentIds: [] });
    });

    it('is idempotent for target, and does not mutate the input\'s target', () => {
      const input = {
        ...legacyReview(),
        documentIds: ['doc-1', 'doc-2'],
        target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['doc-1'] },
      };
      const once = migrateReviewRecord(input);
      const twice = migrateReviewRecord(once);
      expect(twice.target).toEqual(once.target);
      expect(input.target).toEqual({ kind: 'collection', collectionId: 'coll-1', documentIds: ['doc-1'] });
    });
  });

  describe('DocumentRecord role (Task 6)', () => {
    function legacyDocument() {
      return {
        id: 'doc-1',
        matterId: 'matter-1',
        name: 'nda.txt',
        kind: 'txt' as const,
        text: 'text',
        byteSize: 10,
        addedAt: 1,
        addedByUserId: 'user-1',
      };
    }

    it('reads a document with no role back as standalone', () => {
      expect(migrateDocumentRecord(legacyDocument()).role).toBe('standalone');
    });

    it('keeps a role a document already carries', () => {
      const withRole = { ...legacyDocument(), role: 'base' as const, collectionId: 'coll-1' };
      const migrated = migrateDocumentRecord(withRole);
      expect(migrated.role).toBe('base');
      expect(migrated.collectionId).toBe('coll-1');
    });

    it('keeps a varies role too', () => {
      const withRole = { ...legacyDocument(), role: 'varies' as const, collectionId: 'coll-1' };
      expect(migrateDocumentRecord(withRole).role).toBe('varies');
    });
  });
});

// Found by driving the real app in sub-project C's browser verification.
// `migrateFinding` rebuilds a persisted `Finding` field by field, and it was
// never taught about `netPosition` — so every reopened collection review
// silently lost the whole output of sub-project C while the record on disk
// stayed perfectly intact. On screen that read as a review that had produced
// no position at all: evidence and verify controls, no synthesis, no trail,
// indistinguishable from an ordinary single-document finding.
//
// This is the founding failure mode in a new place ("a failed storage
// migration rendering an empty library, indistinguishable from a fresh
// install") and the reason a field-by-field rebuild needs a test per field.
describe('reviewMigration — a collection review keeps its net position', () => {
  function collectionReview(netPosition: unknown) {
    return {
      id: 'rev-c', matterId: 'm1',
      playbookSnapshot: { id: 'pb', name: 'PB', contractType: 'NDA', mode: 'extraction', systemPrompt: '', formatPrompt: '', clauses: [], createdAt: 0, updatedAt: 0, schemaVersion: 2 },
      documentIds: ['doc-1', 'doc-2'],
      target: { kind: 'collection', collectionId: 'coll-1', documentIds: ['doc-1', 'doc-2'] },
      findings: {
        'coll-1': {
          'clause-1': {
            clauseId: 'clause-1', status: 'done',
            citations: [{ quote: 'six months', documentId: 'doc-2', page: 3 }],
            verification: { state: 'unchecked' }, notes: [],
            netPosition,
          },
        },
      },
      modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    };
  }

  const trail = [
    { documentId: 'doc-1', kind: 'original', effect: 'Three months.', citations: [{ quote: 'three months', documentId: 'doc-1' }] },
    { documentId: 'doc-2', kind: 'varies', effect: 'Extends to six.', citations: [{ quote: 'six months', documentId: 'doc-2' }] },
  ];

  it('preserves an unconfirmed position, its proposed text and its whole trail', () => {
    const out = migrateReviewRecord(collectionReview({ proposed: 'Six months notice.', state: 'unconfirmed', trail }));
    const f = out.findings['coll-1']['clause-1'];
    expect(f.netPosition).toBeDefined();
    expect(f.netPosition!.proposed).toBe('Six months notice.');
    expect(f.netPosition!.state).toBe('unconfirmed');
    expect(f.netPosition!.trail).toHaveLength(2);
    expect(f.netPosition!.trail[1].effect).toBe('Extends to six.');
    expect(f.netPosition!.trail[1].citations[0].quote).toBe('six months');
  });

  it('preserves a human confirmation, with who and when', () => {
    const out = migrateReviewRecord(collectionReview(
      { proposed: 'Six months notice.', state: 'confirmed', byUserId: 'u1', at: 999, trail }));
    const np = out.findings['coll-1']['clause-1'].netPosition!;
    expect(np.state).toBe('confirmed');
    expect(np.byUserId).toBe('u1');
    expect(np.at).toBe(999);
  });

  it('preserves an amendment — a person wrote that text', () => {
    const out = migrateReviewRecord(collectionReview(
      { proposed: 'model wording', amended: 'the words a person wrote', state: 'confirmed', byUserId: 'u1', at: 5, trail }));
    expect(out.findings['coll-1']['clause-1'].netPosition!.amended).toBe('the words a person wrote');
  });

  it('downgrades an unreadable state to unconfirmed, never to confirmed', () => {
    // Same posture as `readStatus` and `readVerification`: the safe default
    // is the one that puts the question back in front of a human.
    for (const bad of ['CONFIRMED', 'accepted', '', null, 7, undefined]) {
      const out = migrateReviewRecord(collectionReview({ proposed: 'x', state: bad, trail }));
      expect(out.findings['coll-1']['clause-1'].netPosition!.state).toBe('unconfirmed');
    }
  });

  it('drops a position with no proposed text rather than showing an empty one', () => {
    const out = migrateReviewRecord(collectionReview({ state: 'confirmed', trail }));
    expect('netPosition' in out.findings['coll-1']['clause-1']).toBe(false);
  });

  it('leaves a finding that never had a net position without the key at all', () => {
    // Absent and `undefined` are different to `structuredClone`, which is how
    // IndexedDB writes every record — an `undefined`-valued key persists and
    // reads back as "there was a position here".
    const out = migrateReviewRecord(collectionReview(undefined));
    expect('netPosition' in out.findings['coll-1']['clause-1']).toBe(false);
  });

  it('repairs a malformed trail rather than dropping the position', () => {
    const out = migrateReviewRecord(collectionReview({ proposed: 'Six months.', state: 'unconfirmed', trail: 'not an array' }));
    const np = out.findings['coll-1']['clause-1'].netPosition!;
    expect(np.proposed).toBe('Six months.');
    expect(np.trail).toEqual([]);
  });
});

/**
 * M3. `migrateFinding` rebuilds a `Finding` field by field, so a field
 * nobody adds there is a field silently discarded on every read — which is
 * exactly how `netPosition` was lost once already. `truncatedDocuments`
 * carries the NAMES of the documents a collection run had to cut short, and
 * losing them on reload would put the reader back in front of the singular,
 * unactionable "this document was truncated" it exists to replace.
 */
describe('reviewMigration — truncation names survive a read', () => {
  function truncatedReview(finding: Record<string, unknown>) {
    return {
      id: 'rev-t', matterId: 'm1',
      playbookSnapshot: { id: 'pb', name: 'PB', contractType: 'NDA', mode: 'extraction', systemPrompt: '', formatPrompt: '', clauses: [], createdAt: 0, updatedAt: 0, schemaVersion: 2 },
      documentIds: ['doc-1'],
      findings: { 'doc-1': { 'clause-1': { clauseId: 'clause-1', status: 'done', citations: [], verification: { state: 'unchecked' }, notes: [], ...finding } } },
      modelId: 'm', startedAt: 1, completedAt: 2, createdByUserId: 'u1',
    };
  }

  it('preserves the names of the documents that were cut short', () => {
    const out = migrateReviewRecord(truncatedReview({ truncated: true, truncatedDocuments: ['Lease.pdf', 'Deed of Variation.pdf'] }));
    const f = out.findings['doc-1']['clause-1'];
    expect(f.truncated).toBe(true);
    expect(f.truncatedDocuments).toEqual(['Lease.pdf', 'Deed of Variation.pdf']);
  });

  it('drops a malformed list rather than carrying junk to the reader, and leaves no key behind', () => {
    const out = migrateReviewRecord(truncatedReview({ truncated: true, truncatedDocuments: ['Lease.pdf', 7, null] }));
    expect(out.findings['doc-1']['clause-1'].truncatedDocuments).toEqual(['Lease.pdf']);

    const none = migrateReviewRecord(truncatedReview({ truncated: true, truncatedDocuments: 'Lease.pdf' }));
    expect('truncatedDocuments' in none.findings['doc-1']['clause-1']).toBe(false);
  });

  it('leaves no key at all on a finding that was never truncated', () => {
    const out = migrateReviewRecord(truncatedReview({}));
    expect('truncatedDocuments' in out.findings['doc-1']['clause-1']).toBe(false);
    expect('truncated' in out.findings['doc-1']['clause-1']).toBe(false);
  });
});

// Task 4: a review records the playbook version it ran against.
//
// NOTE ON ARGUMENT ORDER: the task brief showed these as two-argument calls,
// `migrateReviewRecord(legacyReview(), { pb: 'v1-of-pb' })`. That collides
// with the existing `documentText` parameter, which already occupies
// position 2 and is exercised (unchanged) two-arg style just above by
// 'derives pages when a document text lookup is supplied'. Making
// `versionIndex` a second positional argument in front of `documentText`
// would have required rewriting that pre-existing test's call as
// three-argument too — reasonable, but a change the brief never asked for.
// Instead `versionIndex` is appended as a new THIRD parameter, defaulting to
// `{}`; every call below passes `undefined` for `documentText` to reach it.
describe('migrateReviewRecord — records the playbook version it ran against (Task 4)', () => {
  it('points a pre-D review at the migrated v1 of the playbook its snapshot names', () => {
    // The index maps playbookId -> that playbook's v1 version id. `legacyReview()`'s
    // snapshot id is 'pb', so that is the key the migration must look up.
    const migrated = migrateReviewRecord(legacyReview(), undefined, { pb: 'v1-of-pb' });
    expect(migrated.playbookVersionId).toBe('v1-of-pb');
  });

  it('leaves playbookVersionId absent when the playbook no longer exists', () => {
    const orphan = legacyReview();
    orphan.playbookSnapshot = { ...orphan.playbookSnapshot, id: 'deleted-pb' };
    const migrated = migrateReviewRecord(orphan, undefined, { pb: 'v1-of-pb' });
    // Absent, not undefined — `structuredClone` persists an undefined-valued key.
    expect('playbookVersionId' in migrated).toBe(false);
    // and it still opens on its snapshot, which is what makes such a review readable at all
    expect(migrated.playbookSnapshot).toBeDefined();
  });

  it('does not overwrite a version id a review already has', () => {
    const migrated = migrateReviewRecord(
      { ...legacyReview(), playbookVersionId: 'v4' },
      undefined,
      { pb: 'v1-of-pb' },
    );
    expect(migrated.playbookVersionId).toBe('v4');
  });

  it('an empty index leaves every review unbound rather than guessing', () => {
    expect('playbookVersionId' in migrateReviewRecord(legacyReview(), undefined, {})).toBe(false);
  });
});
