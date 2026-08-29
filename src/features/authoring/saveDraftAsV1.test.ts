import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveDraftAsV1 } from './saveDraftAsV1';
import { memoryPlaybooks } from '../../test/memoryPlaybooks';
import type { AuthoringDraft, DraftClause } from '../../lib/authoringDraft';

// Stage 2 Task 13 made publishing one server transaction, so the store here
// is an in-memory FIXTURE. What this file is about — which clauses reach v1,
// what provenance a kept AI-drafted position carries, and that the save gate
// is re-checked inside `saveDraftAsV1` rather than trusted from a disabled
// button — is unchanged by that, and none of it is a claim about storage.
vi.mock('../../lib/db/playbooks',
  async () => (await import('../../test/memoryPlaybooks')).memoryPlaybooksModule());
vi.mock('../../lib/db/playbookVersions',
  async () => (await import('../../test/memoryPlaybooks')).memoryVersionsModule());

const { getPlaybook, listPlaybooks } = await import('../../lib/db/playbooks');
const { listVersions } = await import('../../lib/db/playbookVersions');

beforeEach(() => memoryPlaybooks.reset());

afterEach(() => memoryPlaybooks.reset());

const clause = (id: string, over: Partial<DraftClause> = {}): DraftClause => ({
  id,
  title: `Clause ${id}`,
  extractPrompt: `Extract ${id}.`,
  disposition: 'unreviewed',
  edited: false,
  positionEdited: false,
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
  it('goes through publishAndPoint alone — one publish, no separate identity write first', async () => {
    // The IndexedDB form of this counted `db.transaction` calls. The claim
    // is the same one and it survived the move intact: the identity and the
    // version are written by ONE operation, so there is no window between
    // them for a failure to leave an orphan in. That the operation is now
    // one Postgres transaction is proved in `apps/api/test/playbooks.pg.test.ts`
    // ("does both, or neither"); what is provable here is that this caller
    // reaches it once and writes nothing first.
    const d = draft([clause('a', { disposition: 'kept' })]);
    await saveDraftAsV1(d, 'p', 'u1');
    expect(memoryPlaybooks.calls).toEqual(['publishAndPoint']);
  });

  it('leaves nothing behind when the publish itself fails', async () => {
    // The message is no longer "storage is full": that was a browser quota,
    // and a refused server publish is not one. The failure PROPAGATES rather
    // than being rewritten into a cause the reader could act on wrongly.
    memoryPlaybooks.failPublish = new Error('The publish was refused.');
    const d = draft([clause('a', { disposition: 'kept' })]);
    try {
      await expect(saveDraftAsV1(d, 'p', 'u1')).rejects.toThrow(/refused/i);
    } finally {
      memoryPlaybooks.failPublish = null;
    }
    expect(await listPlaybooks()).toEqual([]);
  });

  it('marks a kept AI-drafted standard position reviewed by a human, end to end', async () => {
    const withPos = clause('a', {
      disposition: 'kept',
      standardPosition: { text: 'We ask for six months.', origin: 'ai-drafted', reviewedByHuman: false },
    });
    const { version } = await saveDraftAsV1(draft([withPos]), 'p', 'u1');
    // Provenance travels into the immutable version with it (Major 3): the
    // draft that knew the model and the sources dies with the session, so
    // this write is the only chance to record how the position got here.
    expect(version.clauses[0].standardPosition).toEqual({
      text: 'We ask for six months.',
      origin: 'ai-drafted',
      reviewedByHuman: true,
      provenance: 'Drafted by test/model; accepted unchanged by a person in the draft review.',
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
