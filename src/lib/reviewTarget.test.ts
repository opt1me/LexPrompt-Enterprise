import { describe, it, expect } from 'vitest';
import { findingsKeyFor, targetDocumentIds, isCollectionTarget } from './reviewTarget';

const docs = { kind: 'documents' as const, documentIds: ['d1', 'd2'] };
const coll = { kind: 'collection' as const, collectionId: 'c1', documentIds: ['d1', 'd2', 'd3'] };

describe('reviewTarget', () => {
  it('keys a document review by each document', () => {
    expect(findingsKeyFor(docs, 'd2')).toBe('d2');
  });

  it('keys a collection review by the collection, whichever document is passed', () => {
    expect(findingsKeyFor(coll, 'd1')).toBe('c1');
    expect(findingsKeyFor(coll, 'd3')).toBe('c1');
  });

  it('keys a collection review even with no document supplied', () => {
    expect(findingsKeyFor(coll)).toBe('c1');
  });

  it('refuses to key a document review with no document — there is no single answer', () => {
    expect(() => findingsKeyFor(docs)).toThrow();
  });

  it('exposes the flat document list for both kinds', () => {
    expect(targetDocumentIds(docs)).toEqual(['d1', 'd2']);
    expect(targetDocumentIds(coll)).toEqual(['d1', 'd2', 'd3']);
  });

  it('discriminates the two kinds', () => {
    expect(isCollectionTarget(coll)).toBe(true);
    expect(isCollectionTarget(docs)).toBe(false);
  });
});
