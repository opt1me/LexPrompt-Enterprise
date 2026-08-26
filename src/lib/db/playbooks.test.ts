import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listPlaybooks, getPlaybook, savePlaybook, deletePlaybook,
  newPlaybook, exportPlaybook, importPlaybook,
} from './playbooks';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import { TEMPLATE_SCHEMA_VERSION } from '../../types';

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.playbooks);
});

afterEach(() => closeDb());

describe('playbook CRUD', () => {
  it('starts empty', async () => {
    expect(await listPlaybooks()).toEqual([]);
  });

  it('saves and reads back a playbook', async () => {
    const p = newPlaybook('NDA Review');
    await savePlaybook(p);
    expect((await listPlaybooks()).map(x => x.name)).toEqual(['NDA Review']);
    expect((await getPlaybook(p.id))?.name).toBe('NDA Review');
  });

  it('updates in place rather than duplicating', async () => {
    const p = newPlaybook('Draft');
    await savePlaybook(p);
    await savePlaybook({ ...p, name: 'Renamed' });
    const all = await listPlaybooks();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('advances updatedAt on save', async () => {
    const p = newPlaybook('P');
    const saved = await savePlaybook({ ...p, updatedAt: 0 });
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('sorts most-recently-updated first, deterministically on a same-millisecond tie', async () => {
    const a = await savePlaybook({ ...newPlaybook('A'), updatedAt: 1 });
    await savePlaybook({ ...newPlaybook('B'), updatedAt: 2 });
    await savePlaybook({ ...a, name: 'A2' });
    expect((await listPlaybooks())[0].name).toBe('A2');
  });

  it('deletes', async () => {
    const p = newPlaybook('Gone');
    await savePlaybook(p);
    await deletePlaybook(p.id);
    expect(await listPlaybooks()).toEqual([]);
    expect(await getPlaybook(p.id)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await getPlaybook('nope')).toBeNull();
  });

  it('never deletes records it cannot read', async () => {
    // Write a structurally invalid record directly, bypassing the repository.
    const db = await getDb();
    await db.put('playbooks', { id: 'broken' } as never);
    const all = await listPlaybooks();
    // The broken record must not crash the list, and must still be present in the store.
    expect(Array.isArray(all)).toBe(true);
    expect(await db.get('playbooks', 'broken')).toBeTruthy();
  });

  it('migrates a malformed record on read without discarding any of it', async () => {
    const db = await getDb();
    await db.put('playbooks', { id: 'partial', name: 'Partial', clauses: [{ title: 'Rent' }] } as never);
    const [found] = await listPlaybooks();
    expect(found.name).toBe('Partial');
    expect(found.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(found.clauses[0].id).toBeTruthy();
    expect(found.clauses[0].title).toBe('Rent');
    expect(found.createdAt).toBeGreaterThan(0);
  });

  it('savePlaybook rejects with a clear message when storage is full', async () => {
    const db = await getDb();
    const putSpy = vi.spyOn(db, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      await expect(savePlaybook(newPlaybook('Too Big'))).rejects.toThrow(/storage is full/i);
    } finally {
      putSpy.mockRestore();
    }
  });

  it('deletePlaybook rejects with a clear message when storage is full', async () => {
    const p = newPlaybook('Doomed');
    await savePlaybook(p);
    const db = await getDb();
    const deleteSpy = vi.spyOn(db, 'delete').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      await expect(deletePlaybook(p.id)).rejects.toThrow(/storage is full/i);
    } finally {
      deleteSpy.mockRestore();
    }
  });
});

describe('import / export', () => {
  it('round-trips through export and import', async () => {
    const p = newPlaybook('Round Trip');
    p.clauses = [{ id: 'c1', title: 'Term', prompt: 'What is the term?' }];
    const text = await exportPlaybook(p).text();
    const imported = await importPlaybook(text);
    expect(imported.name).toBe('Round Trip');
    expect(imported.clauses[0].title).toBe('Term');
  });

  it('assigns a fresh id on import so it cannot clobber the original', async () => {
    const p = newPlaybook('Original');
    await savePlaybook(p);
    const imported = await importPlaybook(await exportPlaybook(p).text());
    expect(imported.id).not.toBe(p.id);
    expect((await listPlaybooks()).length).toBe(2);
  });

  it('rejects malformed JSON', async () => {
    await expect(importPlaybook('{not json')).rejects.toThrow(/not valid/i);
  });

  it('rejects JSON that is not a playbook', async () => {
    await expect(importPlaybook('{"hello":"world"}')).rejects.toThrow(/not a template/i);
  });

  it('migrates a v1 template that used content-era field names', async () => {
    // The shape the old Firestore-backed build wrote: no schemaVersion,
    // timestamps absent, clauses present.
    const legacy = JSON.stringify({
      name: 'Legacy Lease',
      contractType: 'Lease',
      mode: 'risk',
      systemPrompt: 'You are a reviewer.',
      formatPrompt: 'Return JSON.',
      clauses: [{ title: 'Rent', prompt: 'What is the rent?' }],
    });
    const migrated = await importPlaybook(legacy);
    expect(migrated.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(migrated.clauses[0].id).toBeTruthy();
    expect(migrated.createdAt).toBeGreaterThan(0);
  });
});
