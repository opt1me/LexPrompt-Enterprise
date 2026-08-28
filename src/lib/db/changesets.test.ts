import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveChangeset, getChangeset, listChangesets } from './changesets';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { Changeset } from '../../types';

function changeset(overrides: Partial<Changeset> = {}): Changeset {
  return {
    id: 'cs1',
    playbookId: 'pb1',
    fromVersionId: 'v1',
    sourceSummary: 'Brookvale Retail Park — our markup + executed, Jul 2026',
    items: [],
    createdAt: Date.now(),
    createdByUserId: 'u1',
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.changesets);
});

afterEach(() => closeDb());

describe('changesets repository', () => {
  it('saves and retrieves a changeset', async () => {
    await saveChangeset(changeset());
    const found = await getChangeset('cs1');
    expect(found?.playbookId).toBe('pb1');
    expect(found?.items).toEqual([]);
  });

  it('returns null for a changeset that does not exist', async () => {
    expect(await getChangeset('nope')).toBeNull();
  });

  it('upserts — saving the same id again replaces rather than duplicating', async () => {
    await saveChangeset(changeset({ sourceSummary: 'first' }));
    await saveChangeset(changeset({ sourceSummary: 'second' }));
    const found = await getChangeset('cs1');
    expect(found?.sourceSummary).toBe('second');
    expect((await listChangesets('pb1')).length).toBe(1);
  });

  it('lists a playbook\'s changesets newest first', async () => {
    await saveChangeset(changeset({ id: 'cs1', playbookId: 'pb1', createdAt: 1 }));
    await saveChangeset(changeset({ id: 'cs2', playbookId: 'pb1', createdAt: 3 }));
    await saveChangeset(changeset({ id: 'cs3', playbookId: 'pb1', createdAt: 2 }));
    const got = await listChangesets('pb1');
    expect(got.map(c => c.id)).toEqual(['cs2', 'cs3', 'cs1']);
  });

  it('does not return another playbook\'s changesets', async () => {
    await saveChangeset(changeset({ id: 'cs1', playbookId: 'pb1' }));
    await saveChangeset(changeset({ id: 'cs2', playbookId: 'pb2' }));
    expect((await listChangesets('pb1')).map(c => c.id)).toEqual(['cs1']);
  });

  it('round-trips a decision made on an item, including an absent clauseId', async () => {
    // `clauseId` absent on a `new_clause` item must survive a real
    // IndexedDB write/read — `structuredClone` (how IndexedDB writes every
    // record) PRESERVES an `undefined`-valued key, so this only proves
    // anything if the key is truly absent rather than `undefined`.
    const cs = changeset({
      items: [{
        id: 'i1',
        kind: 'new_clause',
        proposedText: 'A brand new clause.',
        rationale: 'Raised in two of three deals.',
        basis: [],
        decision: 'open',
      }],
    });
    await saveChangeset(cs);
    const found = await getChangeset('cs1');
    expect('clauseId' in found!.items[0]).toBe(false);
  });
});
