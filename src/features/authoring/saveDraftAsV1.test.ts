import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveDraftAsV1 } from './saveDraftAsV1';
import { getPlaybook, listPlaybooks } from '../../lib/db/playbooks';
import { listVersions } from '../../lib/db/playbookVersions';
import { getDb, closeDb } from '../../lib/db/open';
import { STORES } from '../../lib/db/schema';
import type { AuthoringDraft, DraftClause } from '../../lib/authoringDraft';

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.playbooks);
  await db.clear(STORES.playbookVersions);
});

afterEach(() => closeDb());

const clause = (id: string, over: Partial<DraftClause> = {}): DraftClause => ({
  id,
  title: `Clause ${id}`,
  extractPrompt: `Extract ${id}.`,
  disposition: 'unreviewed',
  edited: false,
  suggestions: [],
  ...over,
});

const draft = (clauses: DraftClause[]): AuthoringDraft => ({
  contractType: 'Commercial Lease',
  learnedFrom: [],
  modelId: 'test/model',
  clauses,
});

describe('saveDraftAsV1', () => {
  it('publishes a v1 whose clauses are the kept ones only', async () => {
    const d = draft([clause('a', { disposition: 'kept' }), clause('b', { disposition: 'cut' })]);
    const { playbook } = await saveDraftAsV1(d, 'Commercial Lease', 'u1');
    const versions = await listVersions(playbook.id);
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].clauses.map((c) => c.id)).toEqual(['a']);
  });

  it('points the playbook at the version it just published', async () => {
    const d = draft([clause('a', { disposition: 'kept' })]);
    const { playbook } = await saveDraftAsV1(d, 'p', 'u1');
    const stored = await getPlaybook(playbook.id);
    const [version] = await listVersions(playbook.id);
    expect(stored!.currentVersionId).toBe(version.id);
  });

  it('refuses to save a draft the gate has not cleared', async () => {
    // Defence in depth: the review screen's Save button is disabled while
    // any clause is unreviewed, but the handler must not depend on the
    // button being the only way in.
    const d = draft([clause('a', { disposition: 'kept' }), clause('b')]);
    await expect(saveDraftAsV1(d, 'p', 'u1')).rejects.toThrow(/review/i);
    // And nothing was written on the way to that rejection.
    expect(await listPlaybooks()).toEqual([]);
  });

  it('refuses to save a draft with no kept clauses at all', async () => {
    const d = draft([clause('a', { disposition: 'cut' })]);
    await expect(saveDraftAsV1(d, 'p', 'u1')).rejects.toThrow(/review/i);
  });

  // R-E3, superseded: the identity and the version used to be two writes,
  // and a failure between them left an orphan. `publishAndPoint` makes them
  // one transaction, so there is no window left to clean up — this test
  // pins the property that closes it (the same shape `playbooks.test.ts`
  // uses for `importPlaybook`'s equivalent claim) rather than asserting an
  // orphan's absence directly, which `playbooks.test.ts` explains cannot be
  // done honestly once the writes are atomic.
  it('goes through publishAndPoint alone — exactly one transaction, no separate identity write first', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    const d = draft([clause('a', { disposition: 'kept' })]);
    await saveDraftAsV1(d, 'p', 'u1');
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    txSpy.mockRestore();
  });

  it('leaves nothing behind when the publish transaction itself fails', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const d = draft([clause('a', { disposition: 'kept' })]);
    try {
      await expect(saveDraftAsV1(d, 'p', 'u1')).rejects.toThrow(/storage is full/i);
    } finally {
      txSpy.mockRestore();
    }
    expect(await listPlaybooks()).toEqual([]);
  });

  it('marks a kept AI-drafted standard position reviewed by a human, end to end', async () => {
    const withPos = clause('a', {
      disposition: 'kept',
      standardPosition: { text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    const { version } = await saveDraftAsV1(draft([withPos]), 'p', 'u1');
    expect(version.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: true,
    });
  });

  it('keeps an edited AI-drafted position as ai-drafted, not authored, end to end', async () => {
    // The model proposed it; a person changed it. Calling that `authored`
    // would erase where it came from.
    const withPos = clause('a', {
      disposition: 'kept',
      edited: true,
      standardPosition: { text: 'We ask for nine months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    const { version } = await saveDraftAsV1(draft([withPos]), 'p', 'u1');
    expect(version.clauses[0].standardPosition!.origin).toBe('ai-drafted');
  });
});
