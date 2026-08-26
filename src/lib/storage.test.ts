import { describe, it, expect, beforeEach } from 'vitest';
import {
  listTemplates, getTemplate, saveTemplate, deleteTemplate,
  newTemplate, exportTemplate, importTemplate,
  loadSettings, saveSettings,
} from './storage';
import { TEMPLATE_SCHEMA_VERSION } from '../types';

beforeEach(() => localStorage.clear());

describe('template CRUD', () => {
  it('starts empty', async () => {
    expect(await listTemplates()).toEqual([]);
  });

  it('saves and reads back a template', async () => {
    const t = newTemplate('NDA Review');
    await saveTemplate(t);
    expect((await listTemplates()).map(x => x.name)).toEqual(['NDA Review']);
    expect((await getTemplate(t.id))?.name).toBe('NDA Review');
  });

  it('updates in place rather than duplicating', async () => {
    const t = newTemplate('Draft');
    await saveTemplate(t);
    await saveTemplate({ ...t, name: 'Renamed' });
    const all = await listTemplates();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('Renamed');
  });

  it('advances updatedAt on save', async () => {
    const t = newTemplate('T');
    const saved = await saveTemplate({ ...t, updatedAt: 0 });
    expect(saved.updatedAt).toBeGreaterThan(0);
  });

  it('sorts most-recently-updated first', async () => {
    const a = await saveTemplate({ ...newTemplate('A'), updatedAt: 1 });
    await saveTemplate({ ...newTemplate('B'), updatedAt: 2 });
    await saveTemplate({ ...a, name: 'A2' });
    expect((await listTemplates())[0].name).toBe('A2');
  });

  it('deletes', async () => {
    const t = newTemplate('Gone');
    await saveTemplate(t);
    await deleteTemplate(t.id);
    expect(await listTemplates()).toEqual([]);
    expect(await getTemplate(t.id)).toBeNull();
  });

  it('returns null for an unknown id', async () => {
    expect(await getTemplate('nope')).toBeNull();
  });

  it('quarantines corrupt storage instead of destroying it', async () => {
    // Seed localStorage with corrupt JSON
    const corruptBlob = '{not valid json';
    localStorage.setItem('lexprompt.templates.v2', corruptBlob);

    // listTemplates should silently return empty without throwing
    expect(await listTemplates()).toEqual([]);

    // Save a new template
    const t = newTemplate('Recovered');
    await saveTemplate(t);

    // The corrupt blob should have been quarantined under a key
    const quarantineKeys = Object.keys(localStorage)
      .filter(k => k.startsWith('lexprompt.templates.v2.corrupt.'));

    expect(quarantineKeys.length).toBe(1);
    expect(localStorage.getItem(quarantineKeys[0])).toBe(corruptBlob);
  });
});

describe('import / export', () => {
  it('round-trips through export and import', async () => {
    const t = newTemplate('Round Trip');
    t.clauses = [{ id: 'c1', title: 'Term', prompt: 'What is the term?' }];
    const text = await exportTemplate(t).text();
    const imported = await importTemplate(text);
    expect(imported.name).toBe('Round Trip');
    expect(imported.clauses[0].title).toBe('Term');
  });

  it('assigns a fresh id on import so it cannot clobber the original', async () => {
    const t = newTemplate('Original');
    await saveTemplate(t);
    const imported = await importTemplate(await exportTemplate(t).text());
    expect(imported.id).not.toBe(t.id);
    expect((await listTemplates()).length).toBe(2);
  });

  it('rejects malformed JSON', async () => {
    await expect(importTemplate('{not json')).rejects.toThrow(/not valid/i);
  });

  it('rejects JSON that is not a template', async () => {
    await expect(importTemplate('{"hello":"world"}')).rejects.toThrow(/not a template/i);
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
    const migrated = await importTemplate(legacy);
    expect(migrated.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
    expect(migrated.clauses[0].id).toBeTruthy();
    expect(migrated.createdAt).toBeGreaterThan(0);
  });
});

describe('settings', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadSettings().concurrency).toBe(5);
    expect(loadSettings().apiKey).toBe('');
  });

  it('persists and reloads', () => {
    saveSettings({ apiKey: 'k', modelId: 'm', concurrency: 3 });
    expect(loadSettings()).toEqual({ apiKey: 'k', modelId: 'm', concurrency: 3 });
  });

  it('survives corrupt stored JSON by falling back to defaults', () => {
    localStorage.setItem('lexprompt.settings', '{broken');
    expect(loadSettings().concurrency).toBe(5);
  });
});
