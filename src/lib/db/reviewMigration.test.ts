import { describe, it, expect } from 'vitest';
import { migrateReviewRecord } from './reviewMigration';

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
});
