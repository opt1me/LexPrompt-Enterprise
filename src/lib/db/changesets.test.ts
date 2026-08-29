import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveChangeset, getChangeset, listChangesets, recordDecision, publishChangeset, ChangesetStaleBaseError } from './changesets';
import { memoryPlaybooks } from '../../test/memoryPlaybooks';

// Stage 2 Task 13 made the playbook repositories HTTP clients, and
// `publishChangeset` publishes THROUGH them. What this file is about is the
// changeset half — which items reach the version, whose words they carry,
// and the stale-base refusal — so the playbook store is a FIXTURE here, in
// memory, and the publish transaction it stands in for is proved against a
// real Postgres in `apps/api/test/playbooks.pg.test.ts`.
vi.mock('./playbooks',
  async () => (await import('../../test/memoryPlaybooks')).memoryPlaybooksModule());
vi.mock('./playbookVersions',
  async () => (await import('../../test/memoryPlaybooks')).memoryVersionsModule());

const { newPlaybook, publishAndPoint, getPlaybook } = await import('./playbooks');
const { listVersions } = await import('./playbookVersions');
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { Changeset, ChangesetItem, Playbook, PlaybookClause, PlaybookDraft, PlaybookVersion } from '../../types';

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

/** A `new_clause`-kind item — no `clauseId`, title carried only on its
 *  `basis[].clauseRef` (`buildChangeset.ts`'s own contract; see
 *  `buildChangeset.test.ts`'s "carries the basis as RedlineEdit objects
 *  tagged with the matched clause"). */
function newClauseItem(
  title: string,
  decision: ChangesetItem['decision'],
  rewordedText?: string,
): ChangesetItem {
  const item: ChangesetItem = {
    id: `i-${title}`,
    kind: 'new_clause',
    proposedText: `${title} — proposed text nobody should see published unless accepted or reworded.`,
    rationale: `Raised in this deal (${title}).`,
    basis: [{
      documentId: 'doc-a',
      kind: 'insertion',
      text: 'edit text',
      context: 'edit text',
      clauseRef: title,
      source: 'tracked',
    }],
    decision,
  };
  if (rewordedText !== undefined) item.rewordedText = rewordedText;
  return item;
}

/** A `drift`-kind item against an existing clause. */
function driftItem(
  clauseId: string,
  currentText: string,
  proposedText: string,
  decision: ChangesetItem['decision'],
): ChangesetItem {
  return {
    id: `i-${clauseId}`,
    kind: 'drift',
    clauseId,
    currentText,
    proposedText,
    rationale: 'The deal proposed something different.',
    basis: [],
    decision,
  };
}

async function seedPlaybook(clauses: PlaybookClause[] = []): Promise<{ playbook: Playbook; version: PlaybookVersion }> {
  const identity = newPlaybook('Commercial Lease');
  const draft: PlaybookDraft = {
    name: 'Commercial Lease',
    contractType: 'Lease',
    systemPrompt: 'sys',
    formatPrompt: 'fmt',
    clauses,
    changeSummary: '',
  };
  return publishAndPoint(identity, draft, 'u1');
}

beforeEach(() => memoryPlaybooks.reset());

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.changesets);
  await db.clear(STORES.playbooks);
  await db.clear(STORES.playbookVersions);
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

describe('recordDecision', () => {
  it('records a decision and persists it', async () => {
    const cs = changeset({ items: [newClauseItem('New topic', 'open')] });
    await saveChangeset(cs);
    const updated = await recordDecision(cs, 'i-New topic', 'accepted');
    expect(updated.items[0].decision).toBe('accepted');
    expect((await getChangeset('cs1'))!.items[0].decision).toBe('accepted');
  });

  it('stores rewordedText only on a reworded decision, and clears it if the decision changes again', async () => {
    const cs = changeset({ items: [newClauseItem('New topic', 'open')] });
    const reworded = await recordDecision(cs, 'i-New topic', 'reworded', 'Human text.');
    expect(reworded.items[0].rewordedText).toBe('Human text.');

    const declined = await recordDecision(reworded, 'i-New topic', 'declined');
    expect('rewordedText' in declined.items[0]).toBe(false);
  });

  it('leaves every other item untouched', async () => {
    const cs = changeset({ items: [newClauseItem('A', 'open'), newClauseItem('B', 'open')] });
    const updated = await recordDecision(cs, 'i-A', 'accepted');
    expect(updated.items[1].decision).toBe('open');
  });
});

describe('publishChangeset', () => {
  it('publishes ONLY accepted and reworded items — a declined item never reaches the version', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [
      newClauseItem('Accepted clause', 'accepted'),
      newClauseItem('Reworded clause', 'reworded', 'The words a person wrote.'),
      newClauseItem('Declined clause', 'declined'),
    ];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    await publishChangeset(cs, 'u1');

    const [v2] = await listVersions(playbook.id);
    // The declined proposal's own title must never appear at all — this is
    // the mutation-tested line: a filter that publishes every item
    // regardless of decision would leak "Declined clause" in here.
    expect(v2.clauses.map((c) => c.title)).toEqual(['Accepted clause', 'Reworded clause']);
  });

  it('a reworded item publishes the human\'s text, not the model\'s proposal', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [newClauseItem('Reworded clause', 'reworded', 'The words a person wrote.')];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    await publishChangeset(cs, 'u1');

    const [v2] = await listVersions(playbook.id);
    const clause = v2.clauses.find((c) => c.title === 'Reworded clause');
    expect(clause!.standardPosition!.text).toBe('The words a person wrote.');
  });

  it('a declined item on an EXISTING clause leaves its standing position untouched', async () => {
    const { playbook, version } = await seedPlaybook([{
      id: 'c1',
      title: 'Assignment',
      extractPrompt: 'x',
      standardPosition: { text: 'Original text nobody proposed changing.', origin: 'authored', reviewedByHuman: true },
    }]);
    const items = [driftItem('c1', 'Original text nobody proposed changing.', 'A change nobody agreed to.', 'declined')];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    await publishChangeset(cs, 'u1');

    const [v2] = await listVersions(playbook.id);
    expect(v2.clauses[0].standardPosition!.text).toBe('Original text nobody proposed changing.');
  });

  it('publishes through D\'s path — an immutable version, monotonically numbered, with a change summary', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [newClauseItem('Accepted clause', 'accepted')];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    const published = await publishChangeset(cs, 'u1');

    expect(published.version).toBe(2);
    expect(published.changeSummary.trim()).not.toBe('');
    const versions = await listVersions(playbook.id);
    expect(versions).toHaveLength(2);
    // v1 is untouched — publishing never overwrites a prior version.
    expect(versions.find((v) => v.version === 1)!.clauses).toEqual([]);
  });

  it('marks the changeset as published, pointing at the version it produced', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [newClauseItem('Accepted clause', 'accepted')];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    const published = await publishChangeset(cs, 'u1');

    const reloaded = await getChangeset(cs.id);
    expect(reloaded!.publishedVersionId).toBe(published.id);
  });

  it('refuses to publish a changeset with any open item — "not yet decided" is not "declined"', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [newClauseItem('Accepted clause', 'accepted'), newClauseItem('Still open', 'open')];
    const cs = changeset({ playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    await expect(publishChangeset(cs, 'u1')).rejects.toThrow(/undecided|open/i);
    expect(await listVersions(playbook.id)).toHaveLength(1);
  });

  it('refuses to publish when the playbook has moved on since the changeset was built, and reverts nothing', async () => {
    const { playbook, version: v1 } = await seedPlaybook([]);
    const cs = changeset({
      playbookId: playbook.id,
      fromVersionId: v1.id,
      items: [newClauseItem('Accepted clause', 'accepted')],
    });
    await saveChangeset(cs);

    // Someone else publishes v2 in the meantime — independently of this
    // changeset, which was built against v1 and knows nothing about it.
    const identity = (await getPlaybook(playbook.id))!;
    const draftV2: PlaybookDraft = {
      name: v1.name,
      contractType: v1.contractType,
      systemPrompt: v1.systemPrompt,
      formatPrompt: v1.formatPrompt,
      clauses: [{ id: 'c-fm', title: 'Force Majeure', extractPrompt: 'x' }],
      changeSummary: 'Added Force Majeure independently of this changeset.',
    };
    const { version: v2 } = await publishAndPoint(identity, draftV2, 'someone-else');

    await expect(publishChangeset(cs, 'u1')).rejects.toThrow(ChangesetStaleBaseError);

    // (a) the error is the specific, distinguishable one, not a generic
    // failure — asserted via the class above and its message here.
    await expect(publishChangeset(cs, 'u1')).rejects.toThrow(/moved on|rebuilt/i);

    // (b) no new version was created.
    const versions = await listVersions(playbook.id);
    expect(versions).toHaveLength(2);

    // The mutation-tested assertion: this is about the CONTENTS of the
    // playbook's actual current version, not merely that publishing threw.
    // If the `currentVersionId` comparison guard were removed, this call
    // would have built a v3 from v1's clause list (the changeset's own
    // `fromVersionId`), pointed the playbook at it, and silently dropped
    // "Force Majeure" — the exact clause v2 added and this changeset never
    // saw. With the guard in place, v2 is still the playbook's live
    // version and still carries it.
    const current = (await getPlaybook(playbook.id))!;
    expect(current.currentVersionId).toBe(v2.id);
    const currentVersion = versions.find((v) => v.id === current.currentVersionId)!;
    expect(currentVersion.clauses.map((c) => c.title)).toContain('Force Majeure');

    // (c) the changeset's own decisions are unchanged — the review work is
    // still there, exactly as recorded, and it was never marked published.
    const reloaded = await getChangeset(cs.id);
    expect(reloaded!.items.map((i) => i.decision)).toEqual(['accepted']);
    expect('publishedVersionId' in reloaded!).toBe(false);
  });

  it('a failed publish preserves every decision already recorded on the changeset', async () => {
    const { playbook, version } = await seedPlaybook([]);
    const items = [
      newClauseItem('Accepted clause', 'accepted'),
      newClauseItem('Declined clause', 'declined'),
    ];
    const cs = changeset({ id: 'cs-fail', playbookId: playbook.id, fromVersionId: version.id, items });
    await saveChangeset(cs);

    // The publish FAILS. What made it fail used to be an IndexedDB quota
    // error; since Stage 2 Task 13 the publish is one server transaction, so
    // it is a rejected request instead. Neither cause is this test's
    // subject: what matters is that `publishChangeset` loses no decision and
    // marks nothing published when the publish did not happen.
    memoryPlaybooks.failPublish = new Error('The publish was refused.');
    try {
      await expect(publishChangeset(cs, 'u1')).rejects.toThrow();
    } finally {
      memoryPlaybooks.failPublish = null;
    }

    const reloaded = await getChangeset('cs-fail');
    expect(reloaded!.items.map((i) => i.decision)).toEqual(['accepted', 'declined']);
    expect('publishedVersionId' in reloaded!).toBe(false);
    expect(await listVersions(playbook.id)).toHaveLength(1);
  });
});
