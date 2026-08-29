import { describe, it, expect } from 'vitest';
import { rewriteAttribution, rewriteAttributionCounted } from './attribution';

describe('rewriteAttribution (P16)', () => {
  it('rewrites every *UserId from the local profile id to the uploading app_user id', () => {
    const out = rewriteAttribution({ ownerId: 'local-abc' }, 'local-abc', 'uuid-1');
    expect(out.ownerId).toBe('uuid-1');
    expect(rewriteAttribution({ addedByUserId: 'local-abc' }, 'local-abc', 'uuid-1').addedByUserId)
      .toBe('uuid-1');
    expect(rewriteAttribution({ publishedByUserId: 'local-abc' }, 'local-abc', 'uuid-1')
      .publishedByUserId).toBe('uuid-1');
  });

  it('rewrites attributions nested inside a review findings map', () => {
    // `Verification.byUserId`, `Note.byUserId` and `NetPosition.byUserId` all
    // live inside `review.findings` jsonb. A dangling id there breaks no
    // constraint — which is exactly why it would survive — and renders as
    // "Verified by <nobody>".
    const review = {
      id: 'r1',
      createdByUserId: 'local-abc',
      findings: {
        k: {
          c1: {
            verification: { state: 'verified', byUserId: 'local-abc' },
            notes: [{ id: 'n1', byUserId: 'local-abc', text: 'ok' }],
            netPosition: { state: 'confirmed', byUserId: 'local-abc', trail: [] },
          },
        },
      },
    };
    const out = rewriteAttribution(review, 'local-abc', 'uuid-1');
    expect(out.findings.k.c1.verification.byUserId).toBe('uuid-1');
    expect(out.findings.k.c1.notes[0].byUserId).toBe('uuid-1');
    expect(out.findings.k.c1.netPosition.byUserId).toBe('uuid-1');
    // Everything else is untouched, including the array staying an array.
    expect(Array.isArray(out.findings.k.c1.notes)).toBe(true);
    expect(out.findings.k.c1.notes[0].text).toBe('ok');
  });

  it('maps an EMPTY attribution to null, not to the uploading user', () => {
    // `importPlaybook(json, byUserId = '')` produces one. A playbook
    // imported from a file was written by whoever wrote the file, and
    // claiming the person doing the upload wrote it would be a fabricated
    // provenance in the one place provenance is the product.
    expect(rewriteAttribution({ createdByUserId: '' }, 'local-abc', 'uuid-1').createdByUserId)
      .toBeNull();
  });

  it('leaves an id that is NOT the local profile id alone, and counts it', () => {
    // There has only ever been one local profile, so this should not happen.
    // If it does, the honest thing is to leave it and say so on the report,
    // not to sweep it into the uploader's own identity.
    const { record, unmapped } = rewriteAttributionCounted(
      { ownerId: 'someone-else' }, 'local-abc', 'uuid-1');
    expect(record.ownerId).toBe('someone-else');
    expect(unmapped).toBe(1);
  });

  it('counts every id as unmapped when the local profile could not be read', () => {
    // A browser whose profile store is unreadable knows nothing about whose
    // ids these are. Guessing would attribute somebody's verification to
    // whoever happened to run the upload.
    const { record, unmapped } = rewriteAttributionCounted(
      { ownerId: 'local-abc', createdByUserId: 'local-abc' }, undefined, 'uuid-1');
    expect(record.ownerId).toBe('local-abc');
    expect(unmapped).toBe(2);
  });

  it('does not count an absent attribution as unmappable', () => {
    // A number on the report that includes "there was nothing here" is a
    // number that means nothing.
    const { unmapped } = rewriteAttributionCounted(
      { ownerId: null, byUserId: undefined, name: 'Brookvale' }, 'local-abc', 'uuid-1');
    expect(unmapped).toBe(0);
  });

  it('leaves keys that merely look like ids alone', () => {
    const out = rewriteAttribution(
      { documentIds: ['local-abc'], baseDocumentId: 'local-abc', modelId: 'local-abc' },
      'local-abc', 'uuid-1');
    expect(out.documentIds).toEqual(['local-abc']);
    expect(out.baseDocumentId).toBe('local-abc');
    expect(out.modelId).toBe('local-abc');
  });
});
