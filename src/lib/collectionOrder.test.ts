import { describe, it, expect } from 'vitest';
import { orderedMembers } from './collectionOrder';
import type { Collection, DocumentRecord } from '../types';

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
