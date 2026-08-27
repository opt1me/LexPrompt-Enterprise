import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listCollections,
  getCollection,
  saveCollection,
  deleteCollection,
  newCollection,
} from './collections';
import { deleteMatter, newMatter, saveMatter } from './matters';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { DocumentRecord, Review, PlaybookVersion } from '../../types';

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeDocument(matterId: string, overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: uid(),
    matterId,
    name: 'contract.pdf',
    kind: 'pdf',
    text: 'Some extracted text.',
    byteSize: 1234,
    addedAt: Date.now(),
    addedByUserId: 'owner-1',
    role: 'standalone',
    ...overrides,
  };
}

const playbookSnapshot: PlaybookVersion = {
  id: 'pb-1-v1',
  playbookId: 'pb-1',
  version: 1,
  name: 'NDA',
  contractType: 'NDA',
  systemPrompt: '',
  formatPrompt: '',
  clauses: [],
  changeSummary: '',
  publishedAt: Date.now(),
  publishedByUserId: 'owner-1',
  schemaVersion: 6,
};

function makeReview(matterId: string, documentIds: string[]): Review {
  return {
    id: uid(),
    matterId,
    playbookSnapshot,
    documentIds,
    target: { kind: 'documents', documentIds },
    findings: {},
    modelId: 'test-model',
    startedAt: Date.now(),
    createdByUserId: 'owner-1',
  };
}

beforeEach(async () => {
  const db = await getDb();
  await Promise.all([
    db.clear(STORES.collections),
    db.clear(STORES.documents),
    db.clear(STORES.blobs),
    db.clear(STORES.reviews),
    db.clear(STORES.matters),
  ]);
});

afterEach(() => closeDb());

describe('collections repository', () => {
  it('saves and reads a collection back', async () => {
    const c = newCollection('matter-1', 'Lease + DoV', 'doc-base', 'owner-1');
    await saveCollection(c);
    expect(await getCollection(c.id)).toEqual(c);
  });

  it("lists a matter's collections, most recent first", async () => {
    const older = newCollection('matter-1', 'Older', 'doc-a', 'owner-1');
    const newer = newCollection('matter-1', 'Newer', 'doc-b', 'owner-1');
    await saveCollection({ ...older, createdAt: 1 });
    await saveCollection({ ...newer, createdAt: 2 });

    expect((await listCollections('matter-1')).map(c => c.name)).toEqual(['Newer', 'Older']);
  });

  it('rejects rather than resolving to [] when the database fails', async () => {
    const db = await getDb();
    const spy = vi.spyOn(db, 'getAllFromIndex').mockRejectedValue(new Error('db is down'));
    try {
      await expect(listCollections('matter-1')).rejects.toThrow(/db is down/);
    } finally {
      spy.mockRestore();
    }
  });

  it('deleting a collection leaves its member documents intact', async () => {
    const db = await getDb();
    const base = makeDocument('matter-1', { role: 'base' });
    const varies = makeDocument('matter-1', { role: 'varies' });
    const c = newCollection('matter-1', 'Lease + DoV', base.id, 'owner-1');
    const withVaries = { ...c, variesDocumentIds: [varies.id] };
    await db.put(STORES.documents, { ...base, collectionId: c.id });
    await db.put(STORES.documents, { ...varies, collectionId: c.id });
    await saveCollection(withVaries);

    await deleteCollection(c.id);

    expect(await getCollection(c.id)).toBeNull();
    const remainingBase = await db.get(STORES.documents, base.id);
    const remainingVaries = await db.get(STORES.documents, varies.id);
    expect(remainingBase).toEqual({ ...base, collectionId: c.id });
    expect(remainingVaries).toEqual({ ...varies, collectionId: c.id });
  });

  it('deleting a matter deletes its collections', async () => {
    const matter = await saveMatter(newMatter('Target Matter', 'owner-1'));
    const other = await saveMatter(newMatter('Other Matter', 'owner-1'));
    const c = await saveCollection(newCollection(matter.id, 'Lease + DoV', 'doc-base', 'owner-1'));
    const otherC = await saveCollection(newCollection(other.id, 'Other Collection', 'doc-x', 'owner-1'));

    await deleteMatter(matter.id);

    expect(await getCollection(c.id)).toBeNull();
    expect(await listCollections(matter.id)).toEqual([]);
    expect(await getCollection(otherC.id)).toEqual(otherC);
  });

  it('deleting a matter still leaves no orphaned documents, blobs or reviews', async () => {
    const db = await getDb();
    const matter = await saveMatter(newMatter('Target Matter', 'owner-1'));
    const base = makeDocument(matter.id, { role: 'base' });
    const varies = makeDocument(matter.id, { role: 'varies' });
    const c = await saveCollection(newCollection(matter.id, 'Lease + DoV', base.id, 'owner-1'));
    await db.put(STORES.documents, { ...base, collectionId: c.id });
    await db.put(STORES.documents, { ...varies, collectionId: c.id });
    await db.put(STORES.blobs, { documentId: base.id, bytes: new Blob(['x']), mime: 'application/pdf' });
    await db.put(STORES.blobs, { documentId: varies.id, bytes: new Blob(['x']), mime: 'application/pdf' });
    const review = makeReview(matter.id, [base.id, varies.id]);
    await db.put(STORES.reviews, review);

    await deleteMatter(matter.id);

    expect(await db.getAllFromIndex(STORES.documents, 'byMatter', matter.id)).toEqual([]);
    expect(await db.getAllFromIndex(STORES.reviews, 'byMatter', matter.id)).toEqual([]);
    expect(await db.get(STORES.blobs, base.id)).toBeUndefined();
    expect(await db.get(STORES.blobs, varies.id)).toBeUndefined();
    expect(await listCollections(matter.id)).toEqual([]);
    expect(await getCollection(c.id)).toBeNull();
  });
});
