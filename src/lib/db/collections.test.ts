import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listCollections,
  getCollection,
  saveCollection,
  deleteCollection,
  newCollection,
} from './collections';
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

  // The two `deleteMatter` cascade cases that stood here moved to
  // `apps/api/test/matters.pg.test.ts` with the matters repository itself
  // (Stage 2, Task 9). `deleteMatter` is an HTTP call now, and the cascade
  // it triggers is `on delete cascade` in `002_records.sql` — a real
  // database enforcing it rather than a hand-written transaction, proven
  // there against a real Postgres and in `records.pg.test.ts` at the schema
  // level. Keeping a fake-IndexedDB version here would assert a mechanism
  // that no longer exists.
  //
  // WHAT IS NOT YET PROVEN ANYWHERE, and is a finding rather than an
  // omission: this file's own store is still IndexedDB until Task 12, so
  // between these two tasks a deleted matter's collections, documents and
  // blobs survive in the browser with nothing left that can reach them.
  // Task 12 closes it by moving this repository too.
});
