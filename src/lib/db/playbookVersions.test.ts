import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { publishVersion, getVersion, listVersions } from './playbookVersions';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { PlaybookDraft } from '../../types';

function draft(overrides: Partial<PlaybookDraft> = {}): PlaybookDraft {
  return {
    name: 'NDA Playbook',
    contractType: 'NDA',
    systemPrompt: 'You are an expert legal contract reviewer.',
    formatPrompt: 'Answer strictly from the document text. Quote verbatim.',
    clauses: [],
    changeSummary: '',
    ...overrides,
  };
}

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.playbookVersions);
});

afterEach(() => closeDb());

describe('playbookVersions repository', () => {
  it('assigns monotonic version numbers per playbook', async () => {
    const v1 = await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
    const v2 = await publishVersion('pb1', draft({ changeSummary: 'added break clause' }), 'u1');
    const other = await publishVersion('pb2', draft({ changeSummary: '' }), 'u1');
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect(other.version).toBe(1); // per playbook, not per store
  });

  it('refuses a change summary that is missing after v1', async () => {
    await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
    await expect(publishVersion('pb1', draft({ changeSummary: '  ' }), 'u1'))
      .rejects.toThrow(/change summary/i);
  });

  it('allows an empty change summary on v1 only', async () => {
    const v1 = await publishVersion('pb1', draft({ changeSummary: '' }), 'u1');
    expect(v1.changeSummary).toBe('');
  });

  it('never overwrites a published version', async () => {
    const v1 = await publishVersion('pb1', draft({ name: 'original' }), 'u1');
    await publishVersion('pb1', draft({ name: 'later', changeSummary: 'renamed' }), 'u1');
    const reread = await getVersion(v1.id);
    expect(reread!.name).toBe('original');
    expect(reread!.version).toBe(1);
  });

  it('lists versions newest first', async () => {
    await publishVersion('pb1', draft({}), 'u1');
    await publishVersion('pb1', draft({ changeSummary: 'b' }), 'u1');
    await publishVersion('pb1', draft({ changeSummary: 'c' }), 'u1');
    const got = await listVersions('pb1');
    expect(got.map(v => v.version)).toEqual([3, 2, 1]);
  });

  it('two concurrent publishes do not collide on a version number', async () => {
    await publishVersion('pb1', draft({}), 'u1');
    const [a, b] = await Promise.all([
      publishVersion('pb1', draft({ changeSummary: 'a' }), 'u1'),
      publishVersion('pb1', draft({ changeSummary: 'b' }), 'u1'),
    ]);
    expect(new Set([a.version, b.version]).size).toBe(2);
  });
});
