import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { listMatters, getMatter, saveMatter, newMatter, deleteMatter } from './matters';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { DocumentRecord, Review, PlaybookVersion } from '../../types';

beforeEach(async () => {
  const db = await getDb();
  await Promise.all([
    db.clear(STORES.matters),
    db.clear(STORES.documents),
    db.clear(STORES.blobs),
    db.clear(STORES.reviews),
  ]);
});

afterEach(() => closeDb());

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeDocument(matterId: string): DocumentRecord {
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

/** Seeds a matter with `docCount` documents (each with a blob) and one
 *  review referencing them, writing directly to the stores so the setup
 *  does not depend on repositories this task does not produce. */
async function seedMatterWithData(matterId: string, docCount: number) {
  const db = await getDb();
  const docs = Array.from({ length: docCount }, () => makeDocument(matterId));
  const review = makeReview(matterId, docs.map(d => d.id));
  for (const doc of docs) {
    await db.put(STORES.documents, doc);
    await db.put(STORES.blobs, { documentId: doc.id, bytes: new Blob(['x']), mime: 'application/pdf' });
  }
  await db.put(STORES.reviews, review);
  return { docs, review };
}

describe('matter CRUD', () => {
  it('starts empty', async () => {
    expect(await listMatters()).toEqual([]);
  });

  it('creates a matter with the given owner', () => {
    const m = newMatter('Acme Merger', 'owner-1');
    expect(m.name).toBe('Acme Merger');
    expect(m.ownerId).toBe('owner-1');
    expect(m.id).toBeTruthy();
    expect(m.createdAt).toBeGreaterThan(0);
    expect(m.updatedAt).toBeGreaterThan(0);
  });

  it('saves and reads back a matter', async () => {
    const m = newMatter('Acme Merger', 'owner-1');
    await saveMatter(m);
    expect((await getMatter(m.id))?.name).toBe('Acme Merger');
  });

  it('updates in place rather than duplicating', async () => {
    const m = newMatter('Draft', 'owner-1');
    await saveMatter(m);
    await saveMatter({ ...m, name: 'Renamed' });
    const all = await listMatters();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('advances updatedAt on save', async () => {
    const m = newMatter('M', 'owner-1');
    const saved = await saveMatter({ ...m, updatedAt: 0 });
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('lists most-recently-updated first', async () => {
    const a = await saveMatter({ ...newMatter('A', 'owner-1'), updatedAt: 1 });
    await saveMatter({ ...newMatter('B', 'owner-1'), updatedAt: 2 });
    await saveMatter({ ...a, name: 'A2', updatedAt: 3 });
    expect((await listMatters())[0].name).toBe('A2');
  });

  it('returns null for an unknown id', async () => {
    expect(await getMatter('nope')).toBeNull();
  });

  it('assigns distinct sequence numbers to concurrent saves and orders them deterministically', async () => {
    // Both saves race to read the current max _seq and write theirs. If the
    // read-then-write were not scoped to one shared transaction, both could
    // read the same max and persist duplicate _seq values, which would make
    // the same-millisecond tiebreak in listMatters non-deterministic.
    const a = newMatter('A', 'owner-1');
    const b = newMatter('B', 'owner-1');
    await Promise.all([saveMatter(a), saveMatter(b)]);

    const db = await getDb();
    const [rawA, rawB] = await Promise.all([
      db.get(STORES.matters, a.id) as Promise<(typeof a) & { _seq: number }>,
      db.get(STORES.matters, b.id) as Promise<(typeof b) & { _seq: number }>,
    ]);
    expect(rawA._seq).not.toBe(rawB._seq);

    // Force a same-millisecond tie on updatedAt so ordering can only come
    // from the _seq tiebreak, then confirm it's stable and matches which
    // save actually landed with the higher sequence number.
    const tie = Date.now();
    await db.put(STORES.matters, { ...rawA, updatedAt: tie });
    await db.put(STORES.matters, { ...rawB, updatedAt: tie });
    const winnerId = rawA._seq > rawB._seq ? a.id : b.id;
    expect((await listMatters())[0].id).toBe(winnerId);
  });
});

describe('deleteMatter cascade', () => {
  it('cascade-deletes documents, blobs and reviews', async () => {
    const matter = await saveMatter(newMatter('Target Matter', 'owner-1'));
    const { docs } = await seedMatterWithData(matter.id, 2);
    const [docId1, docId2] = docs.map(d => d.id);

    await deleteMatter(matter.id);

    const db = await getDb();
    expect(await db.getAllFromIndex(STORES.documents, 'byMatter', matter.id)).toEqual([]);
    expect(await db.getAllFromIndex(STORES.reviews, 'byMatter', matter.id)).toEqual([]);
    expect(await db.get(STORES.blobs, docId1)).toBeUndefined();
    expect(await db.get(STORES.blobs, docId2)).toBeUndefined();
    expect(await db.get(STORES.matters, matter.id)).toBeUndefined();
    expect(await getMatter(matter.id)).toBeNull();
  });

  it("does not touch another matter's data", async () => {
    const target = await saveMatter(newMatter('Target Matter', 'owner-1'));
    const other = await saveMatter(newMatter('Other Matter', 'owner-1'));

    await seedMatterWithData(target.id, 2);
    const { docs: otherDocs, review: otherReview } = await seedMatterWithData(other.id, 1);

    await deleteMatter(target.id);

    const db = await getDb();
    const remainingDocs = await db.getAllFromIndex(STORES.documents, 'byMatter', other.id);
    expect(remainingDocs.map(d => d.id).sort()).toEqual(otherDocs.map(d => d.id).sort());

    const remainingReviews = await db.getAllFromIndex(STORES.reviews, 'byMatter', other.id);
    expect(remainingReviews.map(r => r.id)).toEqual([otherReview.id]);

    for (const doc of otherDocs) {
      expect(await db.get(STORES.blobs, doc.id)).toBeDefined();
    }
    expect(await db.get(STORES.matters, other.id)).toBeDefined();
  });

  it('resolves quietly when the matter does not exist', async () => {
    await expect(deleteMatter('does-not-exist')).resolves.toBeUndefined();
  });
});
