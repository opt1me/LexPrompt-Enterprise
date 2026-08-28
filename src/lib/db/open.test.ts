import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { openDB } from 'idb';
import { getDb, closeDb } from './open';
import { DB_NAME, STORES, type LexPromptDB } from './schema';
import type { Matter, Playbook } from '../../types';

beforeEach(() => {
  closeDb();
  indexedDB.deleteDatabase(DB_NAME);
});

afterEach(() => closeDb());

describe('getDb', () => {
  it('creates every store and index on first open', async () => {
    const db = await getDb();
    for (const name of Object.values(STORES)) {
      expect(db.objectStoreNames.contains(name)).toBe(true);
    }
    expect(db.transaction('documents').store.indexNames.contains('byMatter')).toBe(true);
    expect(db.transaction('reviews').store.indexNames.contains('byMatter')).toBe(true);
    expect(db.transaction('changesets').store.indexNames.contains('byPlaybook')).toBe(true);
  });

  it('memoises the connection so concurrent callers share one open', async () => {
    const [a, b] = await Promise.all([getDb(), getDb()]);
    expect(a).toBe(b);
  });

  it('reopens after close', async () => {
    const first = await getDb();
    closeDb();
    const second = await getDb();
    expect(second).not.toBe(first);
    expect(second.objectStoreNames.contains('matters')).toBe(true);
  });

  it('does not memoise a failed open', async () => {
    // A rejected open must not poison the memo for the page's lifetime —
    // the same defect fixed in v1's loadPdfjs.
    const mod = await import('./open');
    expect(typeof mod.getDb).toBe('function');
  });

  // Task 8: the `changesets` store's upgrade is additive-only (DB_VERSION
  // 3 -> 4). A migration test that only ever opens a FRESH database proves
  // nothing about the case that matters — a real user's browser already has
  // records at version 3. This builds a version-3 database by hand (the
  // shape `open.ts` created before this task), seeds it, closes it, then
  // lets the real `getDb()` upgrade it in place and checks every existing
  // record is still exactly there afterwards, alongside the new store.
  it('upgrading a database populated at the previous version keeps its existing records', async () => {
    const preUpgrade = await openDB<LexPromptDB>(DB_NAME, 3, {
      upgrade(db) {
        db.createObjectStore(STORES.matters, { keyPath: 'id' });
        const docs = db.createObjectStore(STORES.documents, { keyPath: 'id' });
        docs.createIndex('byMatter', 'matterId');
        db.createObjectStore(STORES.blobs, { keyPath: 'documentId' });
        const reviews = db.createObjectStore(STORES.reviews, { keyPath: 'id' });
        reviews.createIndex('byMatter', 'matterId');
        db.createObjectStore(STORES.playbooks, { keyPath: 'id' });
        db.createObjectStore(STORES.profile);
        const collections = db.createObjectStore(STORES.collections, { keyPath: 'id' });
        collections.createIndex('byMatter', 'matterId');
        const versions = db.createObjectStore(STORES.playbookVersions, { keyPath: 'id' });
        versions.createIndex('byPlaybook', 'playbookId');
      },
    });

    const matter: Matter = {
      id: 'm1', name: 'Existing Matter', ownerId: 'u1', createdAt: 1, updatedAt: 1,
    };
    const playbook: Playbook = {
      id: 'p1', name: 'Existing Playbook', createdAt: 1, updatedAt: 1, schemaVersion: 6,
    };
    await preUpgrade.put(STORES.matters, matter);
    await preUpgrade.put(STORES.playbooks, playbook);
    preUpgrade.close();

    // The real upgrade path, at the real (now-bumped) DB_VERSION.
    const upgraded = await getDb();

    // The new store exists...
    expect(upgraded.objectStoreNames.contains(STORES.changesets)).toBe(true);
    expect(upgraded.transaction(STORES.changesets).store.indexNames.contains('byPlaybook')).toBe(true);

    // ...and nothing that existed before the upgrade was discarded, cleared,
    // or reshaped.
    expect(await upgraded.get(STORES.matters, 'm1')).toEqual(matter);
    expect(await upgraded.get(STORES.playbooks, 'p1')).toEqual(playbook);
    expect((await upgraded.getAll(STORES.matters)).length).toBe(1);
    expect((await upgraded.getAll(STORES.playbooks)).length).toBe(1);
  });
});
