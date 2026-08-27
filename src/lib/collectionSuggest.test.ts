import { describe, it, expect } from 'vitest';
import { suggestCollections } from './collectionSuggest';
import type { DocumentRecord } from '../types';

function doc(id: string, name: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id, matterId: 'm1', name, kind: 'pdf', text: '', byteSize: 1,
    addedAt: 1, addedByUserId: 'u1', role: 'standalone', ...overrides,
  };
}

describe('suggestCollections', () => {
  it('proposes a base plus a clearly-named amendment sharing its stem', () => {
    const base = doc('lease', '123 Oak Street Lease.pdf');
    const amendment = doc('dov', '123 Oak Street Lease - Deed of Variation.pdf');
    const out = suggestCollections([base, amendment]);

    expect(out).toHaveLength(1);
    expect(out[0].baseDocumentId).toBe('lease');
    expect(out[0].variesDocumentIds).toEqual(['dov']);
  });

  it('names which document it thinks is the base in every suggestion, and gives a reason', () => {
    const base = doc('lease', 'Warehouse Lease.pdf');
    const amendment = doc('sl', 'Warehouse Lease - Side Letter.pdf');
    const out = suggestCollections([base, amendment]);

    expect(out).toHaveLength(1);
    expect(out[0].baseDocumentId).toBe('lease');
    expect(typeof out[0].reason).toBe('string');
    expect(out[0].reason.length).toBeGreaterThan(0);
    // The reason must be evaluable: it should name the actual documents involved.
    expect(out[0].reason).toContain(base.name);
    expect(out[0].reason).toContain(amendment.name);
  });

  it('does not propose a collection for two unrelated documents with no amendment naming', () => {
    const a = doc('a', 'Retail Lease - Unit 4.pdf');
    const b = doc('b', 'Office Lease - Unit 9.pdf');
    expect(suggestCollections([a, b])).toEqual([]);
  });

  it('does not group two unrelated leases just because they share the generic word "lease"', () => {
    // Neither document is named as an amendment of the other — filename
    // similarity alone (R-C4) must never be enough.
    const a = doc('a', 'Lease - 10 High Street.pdf');
    const b = doc('b', 'Lease - 20 High Street.pdf');
    expect(suggestCollections([a, b])).toEqual([]);
  });

  it('never proposes a collection for a single document', () => {
    expect(suggestCollections([doc('solo', 'Standalone Lease.pdf')])).toEqual([]);
  });

  it('never proposes a collection from an empty document list', () => {
    expect(suggestCollections([])).toEqual([]);
  });

  it('does not propose an amendment-worded document as its own base', () => {
    // No other document shares its stem, so there is nothing to propose it
    // against — it must not be paired with an unrelated document instead.
    const amendment = doc('dov', 'Random Deed of Variation.pdf');
    const unrelated = doc('other', 'Completely Different Contract.pdf');
    expect(suggestCollections([amendment, unrelated])).toEqual([]);
  });

  it('requires an EXACT stem match, not a substring overlap, against a candidate base', () => {
    // The amendment's stem ("new lease extension") contains the word
    // "lease", which is also the entirety of the unrelated document's
    // name. A substring-based match would wrongly pair them; only an
    // exact match on the full normalized name is conservative enough.
    const unrelated = doc('lease', 'Lease.pdf');
    const amendment = doc('nle', 'New Lease Extension - Deed of Variation.pdf');
    expect(suggestCollections([unrelated, amendment])).toEqual([]);
  });

  it('groups multiple amendments naming the same base into one suggestion', () => {
    const base = doc('lease', 'Unit 7 Lease.pdf');
    const dov = doc('dov', 'Unit 7 Lease - Deed of Variation.pdf');
    const addendum = doc('add', 'Unit 7 Lease - Addendum.pdf');
    const out = suggestCollections([base, dov, addendum]);

    expect(out).toHaveLength(1);
    expect(out[0].baseDocumentId).toBe('lease');
    expect(out[0].variesDocumentIds.sort()).toEqual(['add', 'dov']);
  });
});
