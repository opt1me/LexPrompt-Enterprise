import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateIfNeeded } from './migrate';
import { listPlaybooks, getPlaybook, getPlaybookContent } from './playbooks';
import { listVersions } from './playbookVersions';
import { getDb, closeDb } from './open';
import * as openModule from './open';

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

  // The load-bearing claim in this module's own docstring: "a v1 template
  // imported by step 1 is converted by step 2 before anything can read it."
  // Nothing tested it. `playbookMigration.test.ts` seeds the playbooks store
  // directly, so it never exercises the ORDER of the two steps; the tests
  // here seeded localStorage but never looked at a `currentVersionId`.
  //
  // It matters more than an ordinary gap. If step 2 ran first, D's flag
  // would be written with nothing converted and the imported records would
  // stay pre-D permanently, because the flag guard means the conversion
  // never runs again. From there `getPlaybookContent` finds no version, the
  // editor would open a blank draft over a playbook that still has clauses,
  // and Save would publish an empty v1 and `put` the clauses away.
  it('converts a template imported by step 1 in the SAME call — step 2 runs after step 1', async () => {
    seedV1([{
      id: 't1', name: 'Lease', mode: 'risk', contractType: 'Lease',
      systemPrompt: 'sys', formatPrompt: 'fmt', riskTolerance: 'Averse',
      clauses: [{ id: 'c1', title: 'Rent', prompt: 'What is the rent?' }],
    }]);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('migrated');

    // Imported AND converted, in one call: a version pointer exists...
    expect((await getPlaybook('t1'))!.currentVersionId).toBeTruthy();
    // ...exactly one version was published...
    expect((await listVersions('t1')).map(v => v.version)).toEqual([1]);
    // ...and it carries the imported content, read the way the app reads it.
    const content = await getPlaybookContent('t1');
    expect(content!.clauses[0].extractPrompt).toBe('What is the rent?');
    expect(content!.riskTolerance).toBe('Averse');
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
    // The blocking screen tells the user where their data still is, and the
    // two steps have different answers (Minor 5) — so which step failed has
    // to reach it rather than being assumed.
    expect(result.phase).toBe('v1');
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

  // `migrateIfNeeded` declares Promise<MigrationResult> — failure is meant
  // to be reported by RETURNING { status: 'failed' }, never by rejecting.
  // A `getDb()` failure (e.g. DbBlockedError, or IndexedDB unavailable) is
  // the starkest case: it happens before anything else runs, so if it
  // isn't caught, the whole promise rejects instead of resolving to a
  // result object — an unhandled rejection at the exact moment a user's
  // v1 playbooks are being moved.
  it('a getDb failure yields a failed result, not a rejected promise', async () => {
    seedV1([{ id: 't1', name: 'Lease', clauses: [] }]);
    const spy = vi.spyOn(openModule, 'getDb').mockRejectedValueOnce(new Error('indexeddb unavailable'));
    await expect(migrateIfNeeded()).resolves.toEqual({
      status: 'failed',
      count: 0,
      phase: 'v1',
      error: expect.stringMatching(/indexeddb unavailable/i),
    });
    spy.mockRestore();
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });

  it('a flag-write failure after successful record writes yields failed with the correct count', async () => {
    seedV1([
      { id: 't1', name: 'A', clauses: [] },
      { id: 't2', name: 'B', clauses: [] },
    ]);
    const db = await getDb();
    const realPut = db.put.bind(db);
    // Both playbook record writes must succeed; only the completion-flag
    // write (into the `profile` store) fails.
    vi.spyOn(db, 'put').mockImplementation(((storeName: string, ...args: unknown[]) => {
      if (storeName === 'profile') {
        return Promise.reject(new Error('flag quota exceeded'));
      }
      return (realPut as (...a: unknown[]) => Promise<unknown>)(storeName, ...args);
    }) as typeof db.put);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('failed');
    expect(result.count).toBe(2);
    expect(result.error).toMatch(/flag quota/i);
    expect(localStorage.getItem(V1_KEY)).not.toBeNull();
  });
});
