import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateIfNeeded } from './migrate';
import { listPlaybooks } from './playbooks';
import { getDb, closeDb } from './open';

const V1_KEY = 'lexprompt.templates.v2';

function seedV1(templates: unknown[]) {
  localStorage.setItem(V1_KEY, JSON.stringify(templates));
}

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
});

describe('migrateIfNeeded', () => {
  it('reports not-needed when there is nothing to migrate', async () => {
    expect((await migrateIfNeeded()).status).toBe('not-needed');
  });

  it('migrates v1 templates into playbooks', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [{ id: 'c1', title: 'Rent', prompt: 'p' }] }]);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');
    expect(result.count).toBe(1);
    expect((await listPlaybooks()).map(p => p.name)).toEqual(['Lease']);
  });

  it('LEAVES the localStorage source intact after migrating', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    await migrateIfNeeded();
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });

  it('is idempotent — running twice does not duplicate', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    await migrateIfNeeded();
    await migrateIfNeeded();
    expect((await listPlaybooks()).length).toBe(1);
  });

  it('resolves correctly after an interrupted run', async () => {
    seedV1([
      { id: 't1', name: 'A', clauses: [] },
      { id: 't2', name: 'B', clauses: [] },
    ]);
    // Simulate a half-done migration: t1 already present.
    const db = await getDb();
    await db.put('playbooks', { id: 't1', name: 'A', clauses: [] } as never);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');
    expect((await listPlaybooks()).length).toBe(2);
  });

  it('reports failure loudly and leaves localStorage intact', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    const db = await getDb();
    vi.spyOn(db, 'put').mockRejectedValueOnce(new Error('quota'));
    const result = await migrateIfNeeded();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/quota/i);
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });

  it('does not treat unparseable localStorage as "nothing to migrate"', async () => {
    localStorage.setItem(V1_KEY, '{corrupt');
    const result = await migrateIfNeeded();
    // Silently reporting not-needed would look like a clean install to a user
    // whose playbooks are sitting right there, unreadable.
    expect(result.status).toBe('failed');
  });

  // The two tests above ("running twice" / "interrupted run") use content
  // that is byte-identical to what v1 originally had, so a `put` (an
  // idempotent upsert keyed by id) would pass them even with the
  // already-present check deleted outright — a same-id put just rewrites
  // the same bytes. This test uses DIFFERING content at the same id to
  // make that check's effect actually observable: a playbook the user has
  // since edited inside the app must never be silently reverted to its
  // original v1 content by a later, redundant migration pass.
  it('does not clobber a playbook already edited since an earlier migration attempt', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    const db = await getDb();
    await db.put('playbooks', { id: 't1', name: 'Lease (renamed by user)', clauses: [] } as never);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');
    const found = (await listPlaybooks()).find(p => p.id === 't1');
    expect(found?.name).toBe('Lease (renamed by user)');
  });
});
