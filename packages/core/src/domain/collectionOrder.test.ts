import { describe, it, expect } from 'vitest';
import { orderedMembers } from './collectionOrder.ts';
import type { Collection, DocumentRecord } from './types.ts';

function doc(id: string, name: string): DocumentRecord {
  return { id, matterId: 'm1', name, kind: 'pdf', text: '', byteSize: 1, addedAt: 1, addedByUserId: 'u1', role: 'standalone' };
}
const collection: Collection = {
  id: 'c1', matterId: 'm1', name: 'Lease as varied',
  baseDocumentId: 'lease', variesDocumentIds: ['dov', 'licence'],
  createdAt: 1, createdByUserId: 'u1',
};

describe('orderedMembers', () => {
  it('puts the base first, then amendments in their stored order', () => {
    const out = orderedMembers(collection, [doc('licence','L.pdf'), doc('lease','Lease.pdf'), doc('dov','DoV.pdf')]);
    expect(out.map(m => m.documentId)).toEqual(['lease', 'dov', 'licence']);
    expect(out.map(m => m.kind)).toEqual(['original', 'varies', 'varies']);
  });

  it('numbers positions from 1 in reading order', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('dov','D'), doc('licence','X')]);
    expect(out.map(m => m.position)).toEqual([1, 2, 3]);
  });

  it('ignores documentDate — order is the stored order, not a sort', () => {
    const docs = [
      { ...doc('lease','L'), documentDate: 3000 },
      { ...doc('dov','D'), documentDate: 1000 },
      { ...doc('licence','X'), documentDate: 2000 },
    ];
    expect(orderedMembers(collection, docs).map(m => m.documentId)).toEqual(['lease', 'dov', 'licence']);
  });

  it('surfaces a missing member rather than dropping it', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('licence','X')]);
    expect(out).toHaveLength(3);
    expect(out[1]).toMatchObject({ documentId: 'dov', document: null });
  });

  it('surfaces a missing BASE rather than promoting an amendment', () => {
    const out = orderedMembers(collection, [doc('dov','D'), doc('licence','X')]);
    expect(out[0]).toMatchObject({ documentId: 'lease', document: null, kind: 'original' });
    expect(out[1].kind).toBe('varies');
  });

  it('ignores documents that are not members', () => {
    const out = orderedMembers(collection, [doc('lease','L'), doc('dov','D'), doc('licence','X'), doc('stray','S')]);
    expect(out.map(m => m.documentId)).not.toContain('stray');
  });
});

describe('orderedMembers is generic over the document shape', () => {
  it('accepts a hydrated DocumentFile-shaped member, which carries page images', () => {
    // Extraction works from hydrated documents, not persisted records:
    // page images are never stored (sub-project A) and are regenerated on
    // demand for scans. If this function could only take DocumentRecord,
    // a collection holding a scanned amendment would be reviewed as though
    // that document said nothing.
    const hydrated = [
      { id: 'lease', name: 'Lease.pdf', text: 'base text', kind: 'pdf' as const,
        file: new File([], 'Lease.pdf') },
      { id: 'dov', name: 'DoV.pdf', text: '', kind: 'pdf' as const,
        file: new File([], 'DoV.pdf'),
        pageImages: [{ mime: 'image/jpeg', data: 'AAAA' }] },
    ];
    const out = orderedMembers(collection, hydrated);
    expect(out.map(m => m.documentId)).toEqual(['lease', 'dov', 'licence']);
    // The page images survive the round trip — the type is not widened to
    // something that drops them.
    expect(out[1].document?.pageImages).toHaveLength(1);
    expect(out[2].document).toBeNull();
  });
});
