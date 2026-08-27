import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listPlaybooks, getPlaybook, savePlaybook, deletePlaybook,
  newPlaybook, newPlaybookDraft, draftFromVersion, getPlaybookContent, saveDraft, discardDraft,
  exportPlaybook, importPlaybook, publishAndPoint,
} from './playbooks';
import { publishVersion, listVersions } from './playbookVersions';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import { UnconvertedPlaybookError } from './playbookMigration';
import { SCHEMA_VERSION, type PlaybookDraft } from '../../types';

beforeEach(async () => {
  const db = await getDb();
  await db.clear(STORES.playbooks);
  await db.clear(STORES.playbookVersions);
});

afterEach(() => closeDb());

/** A playbook with one published version, which is what every playbook the
 *  user actually owns looks like after the startup conversion. */
async function published(name: string, overrides: Partial<PlaybookDraft> = {}) {
  const identity = newPlaybook(name);
  const draft = { ...newPlaybookDraft(name), ...overrides };
  const version = await publishVersion(identity.id, draft, 'u1');
  const playbook = await savePlaybook({ ...identity, currentVersionId: version.id });
  return { playbook, version };
}

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
    expect(found.schemaVersion).toBe(SCHEMA_VERSION);
    expect(found.createdAt).toBeGreaterThan(0);
    // The record is repaired FOR DISPLAY only — the pre-D content is still
    // sitting in the store, untouched, for the startup conversion to publish.
    expect((await db.get('playbooks', 'partial') as { clauses?: unknown }).clauses).toBeTruthy();
  });

  it('reading a pre-D record publishes nothing (R-D7)', async () => {
    const db = await getDb();
    await db.put('playbooks', {
      id: 'pre-d', name: 'Pre-D', clauses: [{ id: 'c1', title: 'T', prompt: 'p' }],
    } as never);
    await getPlaybook('pre-d');
    await listPlaybooks();
    expect(await db.getAll(STORES.playbookVersions)).toEqual([]);
  });

  it('savePlaybook rejects with a clear message when storage is full', async () => {
    // savePlaybook does its read-then-write inside one explicit
    // db.transaction() (see the atomicity comment in playbooks.ts), so the
    // fault needs to be injected at that level rather than on db.put.
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction').mockReturnValue({
      store: {
        getAll: () => Promise.resolve([]),
        put: () => {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        },
      },
      done: Promise.resolve(),
    } as never);
    try {
      await expect(savePlaybook(newPlaybook('Too Big'))).rejects.toThrow(/storage is full/i);
    } finally {
      txSpy.mockRestore();
    }
  });

  it('savePlaybook allocates seq and put in one transaction, not two', async () => {
    // Guards the fix for the non-atomicity review finding: if getAll and
    // put ever moved back to separate implicit transactions, this would
    // observe db.transaction() called zero times (or the two ops split
    // across independently-opened transactions) instead of exactly once.
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await savePlaybook(newPlaybook('Atomic'));
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith(STORES.playbooks, 'readwrite');
    txSpy.mockRestore();
  });

  // Minor 6 (fix round 1). Deleting a playbook used to leave every one of
  // its `PlaybookVersion` records behind: unreachable (nothing enumerates
  // versions except by a playbook that no longer exists) and unbounded. The
  // shape here is `deleteMatter`'s — one transaction, the record plus what
  // only it owns. A review that ran against a deleted playbook is unharmed:
  // it carries its own `playbookSnapshot`, which is what spec 5 means by
  // "a review whose playbook was deleted still opens on its snapshot".
  it('deletePlaybook takes every version of that playbook with it', async () => {
    const db = await getDb();
    const { playbook } = await published('Doomed', {
      clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }],
    });
    await publishAndPoint(playbook, {
      ...newPlaybookDraft('Doomed'), changeSummary: 'a second version',
    }, 'u1');
    const { playbook: survivor } = await published('Survivor');
    expect((await listVersions(playbook.id)).length).toBe(2);

    await deletePlaybook(playbook.id);

    expect(await listVersions(playbook.id)).toEqual([]);
    // And nothing else was swept up with it.
    expect((await listVersions(survivor.id)).length).toBe(1);
    expect((await db.getAll(STORES.playbookVersions)).length).toBe(1);
  });

  it('deletePlaybook removes the record and its versions in ONE transaction', async () => {
    const { playbook } = await published('Doomed');
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await deletePlaybook(playbook.id);
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    txSpy.mockRestore();
  });

  it('deletePlaybook rejects with a clear message when storage is full', async () => {
    const p = newPlaybook('Doomed');
    await savePlaybook(p);
    const db = await getDb();
    // The failure is injected at the transaction now that the delete and
    // its cascade share one, rather than at `db.delete` — which the cascade
    // no longer goes through.
    const txSpy = vi.spyOn(db, 'transaction').mockImplementation((() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    }) as typeof db.transaction);
    try {
      await expect(deletePlaybook(p.id)).rejects.toThrow(/storage is full/i);
    } finally {
      txSpy.mockRestore();
    }
    // And the playbook is still there — a failed delete deletes nothing.
    expect((await listPlaybooks()).map(x => x.id)).toContain(p.id);
  });
});

describe('content and drafts', () => {
  it('reads back the published version as the playbook content', async () => {
    const { playbook } = await published('Lease', {
      clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'What is the term?' }],
    });
    const content = await getPlaybookContent(playbook.id);
    expect(content!.version).toBe(1);
    expect(content!.clauses[0].title).toBe('Term');
  });

  it('returns null — not an empty version — for a playbook that has never been published', async () => {
    // "No published content" and "content with no clauses" are different
    // facts, and a run started on the second would look like a review that
    // found nothing.
    const p = await savePlaybook(newPlaybook('Unpublished'));
    expect(await getPlaybookContent(p.id)).toBeNull();
  });

  // M3 (fix round 1). The startup conversion is atomic and loud, and
  // `migrateIfNeeded` failing blocks the app, so a record left carrying
  // pre-D content keys with no version pointer is not reachable today. It
  // is one mis-ordered statement away, though, and the consequence is not
  // an error — it is silent content loss: `getPlaybookContent` returning
  // `null` sends the editor to `newPlaybookDraft`, which presents a BLANK
  // editor over a playbook that still has clauses, and the next Save
  // publishes an empty v1 and `put`s the clauses away. The editor cannot
  // tell "never published" from "has content that was never converted", so
  // the store has to.
  it('refuses to report an unconverted pre-D record as having no content', async () => {
    const db = await getDb();
    await db.put(STORES.playbooks, {
      id: 'pre-d', name: 'Lease', mode: 'risk', systemPrompt: 'sys', formatPrompt: 'fmt',
      clauses: [{ id: 'c1', title: 'Rent', prompt: 'What is the rent?' }],
      createdAt: 1, updatedAt: 2, schemaVersion: 2,
    } as never);
    await expect(getPlaybookContent('pre-d')).rejects.toBeInstanceOf(UnconvertedPlaybookError);
  });

  it('still reports a genuinely never-published playbook as having no content', async () => {
    // The guard must not fire on a playbook that simply has not been saved
    // yet — "no published content" is a real, honest state and the only
    // thing that distinguishes it is the absence of pre-D content keys.
    const p = await savePlaybook(newPlaybook('Never published'));
    expect(await getPlaybookContent(p.id)).toBeNull();
  });

  it('does not fire the guard on a converted playbook that has an unpublished draft', async () => {
    const { playbook } = await published('Lease', {
      clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'What is the term?' }],
    });
    await saveDraft(playbook, { ...newPlaybookDraft('Lease'), changeSummary: 'wip' });
    expect((await getPlaybookContent(playbook.id))!.version).toBe(1);
  });

  it('returns null when the version pointer names a version that is gone', async () => {
    const p = await savePlaybook({ ...newPlaybook('Dangling'), currentVersionId: 'missing' });
    expect(await getPlaybookContent(p.id)).toBeNull();
  });

  it('repairs a malformed stored version on read', async () => {
    const db = await getDb();
    const identity = await savePlaybook({ ...newPlaybook('Broken'), currentVersionId: 'v-broken' });
    await db.put(STORES.playbookVersions, {
      id: 'v-broken', playbookId: identity.id, version: 1, name: 'Broken',
      clauses: [{ title: 'Rent', prompt: 'What is the rent?' }],
    } as never);
    const content = await getPlaybookContent(identity.id);
    expect(content!.clauses[0].extractPrompt).toBe('What is the rent?');
    expect(content!.clauses[0].id).toBeTruthy();
    // And the repair does NOT invent a change summary for a v1 that has none.
    expect(content!.changeSummary).toBe('');
  });

  it('a draft is stored against the identity and read back', async () => {
    const { playbook } = await published('Lease');
    await saveDraft(playbook, { ...newPlaybookDraft('Lease'), changeSummary: 'added a clause' });
    expect((await getPlaybook(playbook.id))!.draft!.changeSummary).toBe('added a clause');
    // A draft never changes what the published version says.
    expect((await getPlaybookContent(playbook.id))!.changeSummary).toBe('');
  });

  // DELETED (Task 9A): "saveDraft fails loudly for a playbook that no longer
  // exists". `saveDraft` now takes the identity record as a value, the way
  // `publishAndPoint` does, because a playbook created in this session has
  // no store record yet and Save draft is its first write — so there is no
  // longer a "no such playbook" case for it to be loud about. The guard's
  // stated worry ("a draft nothing can publish") does not survive that
  // change either: `publishAndPoint` also takes the identity as a value, so
  // a record written back by Save draft publishes normally. The replacement
  // behaviour is asserted by "saves the draft of a playbook that has never
  // been written to the store", below.

  it('draftFromVersion does not carry the previous version\'s change summary', async () => {
    const { version } = await published('Lease');
    const republished = await publishVersion(version.playbookId, {
      ...draftFromVersion(version), changeSummary: 'added a break clause',
    }, 'u1');
    // v3's draft must start blank rather than claiming v2's reason.
    expect(draftFromVersion(republished).changeSummary).toBe('');
  });

  it('draftFromVersion deep-copies the clauses', async () => {
    const { version } = await published('Lease', {
      clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'p' }],
    });
    const draft = draftFromVersion(version);
    draft.clauses[0].title = 'Edited';
    expect(version.clauses[0].title).toBe('Term');
  });
});

describe('publishAndPoint', () => {
  it('publishes the version and points the identity at it in one transaction', async () => {
    const db = await getDb();
    const identity = newPlaybook('Atomic');
    const txSpy = vi.spyOn(db, 'transaction');
    const { playbook, version } = await publishAndPoint(identity, {
      ...newPlaybookDraft('Atomic'),
      clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }],
    }, 'u1');
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    txSpy.mockRestore();
    expect(playbook.currentVersionId).toBe(version.id);
    expect((await getPlaybookContent(playbook.id))!.version).toBe(1);
  });

  it('numbers versions monotonically across successive publishes', async () => {
    const identity = newPlaybook('Versioned');
    const first = await publishAndPoint(identity, newPlaybookDraft('Versioned'), 'u1');
    const second = await publishAndPoint(first.playbook, {
      ...newPlaybookDraft('Versioned'), changeSummary: 'added a clause',
    }, 'u1');
    expect(second.version.version).toBe(2);
    expect(second.playbook.currentVersionId).toBe(second.version.id);
  });

  it('surfaces the change-summary rule as itself, not as "storage is full"', async () => {
    const identity = newPlaybook('Versioned');
    const first = await publishAndPoint(identity, newPlaybookDraft('Versioned'), 'u1');
    await expect(publishAndPoint(first.playbook, newPlaybookDraft('Versioned'), 'u1'))
      .rejects.toThrow(/change summary/i);
  });

  // Minor 2 (fix round 1). Dormant until Task 9 wires `saveDraft` into the
  // editor, and live the moment it does: a draft that survives its own
  // publish makes the library read "Unpublished changes" forever, and
  // `loadPlaybookForEdit` prefers `t.draft` over the version just
  // published — so the editor would keep reopening the stale copy.
  it('consumes the draft: publishing clears it from the identity record', async () => {
    const identity = newPlaybook('Drafted');
    const { playbook } = await publishAndPoint(identity, newPlaybookDraft('Drafted'), 'u1');
    await saveDraft(playbook, { ...newPlaybookDraft('Drafted'), changeSummary: 'wip' });
    expect((await getPlaybook(playbook.id))!.draft).toBeTruthy();

    const withDraft = (await getPlaybook(playbook.id))!;
    await publishAndPoint(withDraft, {
      ...newPlaybookDraft('Drafted'), changeSummary: 'published the draft',
    }, 'u1');

    const after = (await getPlaybook(playbook.id))!;
    expect(after.draft).toBeUndefined();
    // Absent, not present-and-undefined: structuredClone preserves the key,
    // and `'draft' in playbook` is how "has unpublished changes" is asked.
    expect('draft' in after).toBe(false);
  });
});

// Task 9A / R-D16. Before this, `saveDraft` had no caller anywhere in the
// app and `Playbook.draft` could never be set: the library's "Unpublished
// changes" badge, `loadPlaybookForEdit`'s draft preference and
// `publishAndPoint`'s draft consumption were all mechanisms with no writer.
describe('drafts are persisted on explicit intent, and discardable', () => {
  // A playbook created in this session has no store record yet — Save draft
  // is its FIRST write, exactly as Publish used to be. Taking the identity
  // as a value (as `publishAndPoint` does) is what makes that work; an
  // id-only form would reject the most valuable draft in the app, the one
  // that just cost a ~30s paid AI generation.
  it('saves the draft of a playbook that has never been written to the store', async () => {
    const identity = newPlaybook('Brand new');
    await saveDraft(identity, { ...newPlaybookDraft('Brand new'), name: 'Half typed' });
    expect((await getPlaybook(identity.id))!.draft?.name).toBe('Half typed');
  });

  // Otherwise "discard" leaves the rejected edits durable and the next open
  // resurrects them — the defect Task 3's M2 fixed in memory, one layer down.
  it('discarding clears the STORED draft, not just the in-memory one', async () => {
    const { playbook } = await published('Lease');
    await saveDraft(playbook, { ...newPlaybookDraft('Lease'), name: 'Rejected' });
    await discardDraft(playbook.id);
    expect((await getPlaybook(playbook.id))!.draft).toBeUndefined();

    // Asserted on the RAW STORED RECORD, not on `getPlaybook`'s output.
    // `migratePlaybookRecord` omits an `undefined` draft on the way out, so
    // reading through it cannot tell `delete` from `= undefined` — checked
    // by mutation, and the read-path assertion above stayed green under it.
    // The stored record is what another tab, a future migration and every
    // raw-record guard actually see, and `structuredClone` (how IndexedDB
    // writes every record) PRESERVES an `undefined`-valued key.
    const db = await getDb();
    const raw = (await db.get(STORES.playbooks, playbook.id))!;
    expect('draft' in raw).toBe(false);
  });

  it('leaves the published version alone when a draft is discarded', async () => {
    const { playbook, version } = await published('Lease', {
      clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'p' }],
    });
    await saveDraft(playbook, { ...draftFromVersion(version), clauses: [] });
    await discardDraft(playbook.id);
    expect((await getPlaybookContent(playbook.id))!.clauses.map(c => c.id)).toEqual(['c1']);
  });

  // R-D7: repair-on-read stays OFF write paths. `discardDraft` used to read
  // through `getPlaybook`, which returns `migratePlaybookRecord`'s output —
  // a whitelist that drops every pre-D content key — and wrote that object
  // back. A record carrying both a draft and unconverted content would have
  // had the content silently deleted by an operation the user asked to
  // discard something else entirely, which is "never delete what you cannot
  // read" broken by a repair nobody requested. The app cannot reach this
  // shape today; the invariant is what the test is for, not the shape.
  it('does not persist a repair-on-read, or drop content it did not come for', async () => {
    const db = await getDb();
    await db.put(STORES.playbooks, {
      id: 'half-converted',
      name: 'Half converted',
      createdAt: 1,
      updatedAt: 1,
      clauses: [{ title: 'Rent' }],
      draft: { ...newPlaybookDraft('Half converted'), name: 'Rejected' },
    } as never);

    await discardDraft('half-converted');

    const raw = (await db.get(STORES.playbooks, 'half-converted'))! as unknown as Record<string, unknown>;
    expect('draft' in raw).toBe(false);
    expect(raw.clauses).toEqual([{ title: 'Rent' }]);
  });

  it('discarding a draft that is not there is a no-op, not a failure', async () => {
    const { playbook } = await published('Lease');
    await expect(discardDraft(playbook.id)).resolves.toBeUndefined();
    await expect(discardDraft('no-such-playbook')).resolves.toBeUndefined();
  });
});

describe('import / export', () => {
  it('round-trips through export and import', async () => {
    const draft = {
      ...newPlaybookDraft('Round Trip'),
      clauses: [{ id: 'c1', title: 'Term', extractPrompt: 'What is the term?' }],
    };
    const text = await exportPlaybook(draft).text();
    const { playbook, version } = await importPlaybook(text);
    expect(playbook.name).toBe('Round Trip');
    expect(version.clauses[0].title).toBe('Term');
  });

  it('assigns a fresh id on import so it cannot clobber the original', async () => {
    const { playbook, version } = await published('Original');
    const imported = await importPlaybook(await exportPlaybook(draftFromVersion(version)).text());
    expect(imported.playbook.id).not.toBe(playbook.id);
    expect((await listPlaybooks()).length).toBe(2);
  });

  it('an imported playbook is immediately runnable — it gets a published v1', async () => {
    const { playbook } = await importPlaybook(JSON.stringify({
      name: 'Importable', clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }],
    }));
    expect(playbook.currentVersionId).toBeTruthy();
    expect((await getPlaybookContent(playbook.id))!.clauses[0].title).toBe('T');
  });

  // Minor 1 (fix round 1). The one-time migration went to considerable
  // trouble to be atomic (R-D9) and the two everyday paths that do the same
  // pair of writes did not follow it: `publishVersion` then `savePlaybook`,
  // two transactions, with a window between them. For `importPlaybook` the
  // orphan is the worse half — a version with NO identity record at all,
  // permanently unreachable, since nothing but the migration adopts orphans
  // and the migration only looks at playbooks that exist.
  it('importPlaybook publishes and points in ONE transaction over both stores', async () => {
    const db = await getDb();
    const txSpy = vi.spyOn(db, 'transaction');
    await importPlaybook(JSON.stringify({
      name: 'Atomic import', clauses: [{ id: 'c1', title: 'T', extractPrompt: 'p' }],
    }));
    expect(txSpy).toHaveBeenCalledTimes(1);
    expect(txSpy).toHaveBeenCalledWith([STORES.playbooks, STORES.playbookVersions], 'readwrite');
    txSpy.mockRestore();
  });

  // DELIBERATELY NOT TESTED: "a failure between the version write and the
  // identity write leaves no orphaned version behind."
  //
  // The test that used to sit here threw at `db.transaction`, which fails
  // before EITHER write and therefore passed under a two-transaction
  // implementation too — it could not see the window it named. Task 3's
  // re-reviewer proved that by reverting `importPlaybook` to the
  // two-transaction form and watching it stay green.
  //
  // It cannot be honestly rewritten, because under one transaction the
  // window does not exist: there is no moment at which the version is
  // durable and the identity is not. Injecting a failure at the identity
  // `put` is also not available — `idb` wraps the transaction in a Proxy, so
  // replacing `tx.objectStore` silently does not stick and the real write
  // runs (confirmed by trying it).
  //
  // The invariant is pinned instead by the test above, which asserts exactly
  // ONE transaction spanning BOTH stores. That is the property that closes
  // the orphan window; a test asserting the absence of an orphan adds no
  // information and, left in place, would tell a future reader the window is
  // covered when nothing covers it.

  it('rejects malformed JSON', async () => {
    await expect(importPlaybook('{not json')).rejects.toThrow(/not valid/i);
  });

  it('rejects JSON that is not a playbook', async () => {
    await expect(importPlaybook('{"hello":"world"}')).rejects.toThrow(/not a template/i);
  });

  it('never leaks the internal _seq write-counter into an export', async () => {
    const { version } = await published('No Leak');
    // Read back through the path that touches the raw (_seq-bearing) stored
    // record, to pin that the identity is reconstructed field-by-field
    // rather than spread — a future refactor that spread the raw record
    // instead would fail this immediately.
    const [viaList] = await listPlaybooks();
    expect('_seq' in viaList).toBe(false);
    expect('_seq' in JSON.parse(await exportPlaybook(draftFromVersion(version)).text())).toBe(false);
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
      riskTolerance: 'Conservative.',
      clauses: [{ title: 'Rent', prompt: 'What is the rent?' }],
    });
    const { playbook, version } = await importPlaybook(legacy);
    expect(version.schemaVersion).toBe(SCHEMA_VERSION);
    expect(version.clauses[0].id).toBeTruthy();
    expect(version.clauses[0].extractPrompt).toBe('What is the rent?');
    expect(version.riskTolerance).toBe('Conservative.');
    expect(playbook.createdAt).toBeGreaterThan(0);
    expect('mode' in version).toBe(false);
  });
});
