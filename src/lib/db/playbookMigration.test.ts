import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  migratePlaybookRecord,
  migrateDraft,
  migrateClause,
  migrateVersionRecord,
  IMPORTED_SUMMARY,
} from './playbookMigration';
import { migrateIfNeeded } from './migrate';
import { listPlaybooks, getPlaybook } from './playbooks';
import { listVersions } from './playbookVersions';
import { getDb, closeDb } from './open';
import { STORES } from './schema';
import type { UserProfile } from '../../types';

/** Deliberately the PRE-D shape, `mode` and all — this is the record the
 *  conversion has to read, so it must not be updated to the new one. */
const preD = {
  id: 'pb1', name: 'Commercial Lease', contractType: 'Lease',
  mode: 'risk', systemPrompt: 'sys', formatPrompt: 'fmt',
  riskTolerance: 'We are risk-averse on uncapped liability.',
  clauses: [{ id: 'c1', title: 'Break', prompt: 'Find the break clause', riskCriteria: 'Must be unconditional' }],
  createdAt: 1000, updatedAt: 2000, schemaVersion: 2,
};

/** Puts a pre-D shaped record straight into the `playbooks` store. It must
 *  bypass `savePlaybook`, which would migrate the record on the way in and
 *  leave the test proving nothing about the startup conversion. */
async function savePlaybookRaw(record: unknown): Promise<void> {
  const db = await getDb();
  await db.put(STORES.playbooks, record as never);
}

/** Sets sub-project A's `'migration:v1-templates'` flag, for the test that a
 *  user already migrated by A still runs D's conversion. `migrate.ts`'s own
 *  `writeFlag` is module-private and stays that way; this writes the same
 *  record shape directly rather than widening that module's surface for a
 *  test. */
async function writeV1Flag(count: number): Promise<void> {
  const db = await getDb();
  await db.put(
    STORES.profile,
    { done: true, count, migratedAt: Date.now() } as unknown as UserProfile,
    'migration:v1-templates',
  );
}

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  indexedDB.deleteDatabase('lexprompt');
  const db = await getDb();
  await db.clear(STORES.playbooks);
  await db.clear(STORES.playbookVersions);
  await db.clear(STORES.profile);
});

afterEach(() => closeDb());

describe('migratePlaybookRecord', () => {
  it('turns a pre-D playbook into an identity plus one published v1', () => {
    const { playbook, version } = migratePlaybookRecord(preD);
    expect(playbook.id).toBe('pb1');
    expect(playbook.name).toBe('Commercial Lease');
    expect(version!.changeSummary).toBe('Imported from before versioning.');
    expect(version!.clauses[0].extractPrompt).toBe('Find the break clause');
  });

  it('retains riskTolerance for a risk-mode playbook so it reviews identically', () => {
    const { version } = migratePlaybookRecord(preD);
    expect(version!.riskTolerance).toBe('We are risk-averse on uncapped liability.');
    expect(version!.clauses[0].riskCriteria).toBe('Must be unconditional');
  });

  it('clears a stale riskTolerance on an extraction-mode playbook (R-D1)', () => {
    const { version } = migratePlaybookRecord({ ...preD, mode: 'extraction' });
    // The editor hides the field outside risk mode but never clears it, so a
    // leftover string would silently start emitting risk criteria that this
    // playbook's reviews never had.
    expect(version!.riskTolerance).toBeUndefined();
    // And absent, not present-and-undefined: structuredClone preserves an
    // `undefined`-valued key all the way into the published version.
    expect('riskTolerance' in version!).toBe(false);
  });

  it('keeps a riskTolerance on a record that never had a mode at all', () => {
    // Post-D records carry no `mode`. Treating "no mode" as extraction would
    // strip the tolerance off an already-migrated playbook on every read.
    const { version } = migratePlaybookRecord({
      id: 'pb2', name: 'Post-D', riskTolerance: 'Averse', clauses: [],
    });
    expect(version!.riskTolerance).toBe('Averse');
  });

  it('invents no standard position from a risk tolerance', () => {
    const { version } = migratePlaybookRecord(preD);
    expect('standardPosition' in version!.clauses[0]).toBe(false);
  });

  it('drops the mode flag entirely', () => {
    const { playbook, version } = migratePlaybookRecord(preD);
    expect('mode' in playbook).toBe(false);
    expect('mode' in version!).toBe(false);
  });

  it('is idempotent — a migrated playbook migrates to itself with no new version', () => {
    const alreadyMigrated = {
      id: 'pb1', name: 'X', createdAt: 1, updatedAt: 2,
      currentVersionId: 'v-abc', schemaVersion: 6,
    };
    const { playbook, version } = migratePlaybookRecord(alreadyMigrated);
    expect(version).toBeNull();
    expect(playbook.currentVersionId).toBe('v-abc');
  });

  it('repairs a malformed record rather than dropping it', () => {
    const { playbook, version } = migratePlaybookRecord({ clauses: 'not an array' });
    expect(playbook.id).toBeTruthy();
    expect(playbook.name).toBe('Untitled playbook');
    expect(version!.clauses).toEqual([]);
  });

  it('repairs null without throwing', () => {
    expect(() => migratePlaybookRecord(null)).not.toThrow();
  });

  it('leaves no currentVersionId key at all when there is none', () => {
    const { playbook } = migratePlaybookRecord(preD);
    expect('currentVersionId' in playbook).toBe(false);
  });
});

describe('migrateClause (moved here from playbooks.ts)', () => {
  it('reads a pre-D clause `prompt` into `extractPrompt`', () => {
    const c = migrateClause({ id: 'c1', title: 'Break', prompt: 'Find the break clause' });
    expect(c.extractPrompt).toBe('Find the break clause');
    expect('prompt' in c).toBe(false);
  });

  it('drops an empty-text standard position rather than repairing it to empty', () => {
    const c = migrateClause({
      id: 'c1', title: 'T', extractPrompt: 'x',
      standardPosition: { text: '   ', origin: 'authored', reviewedByHuman: true },
    });
    expect('standardPosition' in c).toBe(false);
  });

  it('defaults an unreadable reviewedByHuman to false, never true', () => {
    const c = migrateClause({
      id: 'c1', title: 'T', extractPrompt: 'x',
      standardPosition: { text: 'We ask for 6 months', origin: 'nonsense', reviewedByHuman: 'yes' },
    });
    expect(c.standardPosition).toEqual({
      text: 'We ask for 6 months', origin: 'authored', reviewedByHuman: false, provenance: undefined,
    });
  });
});

describe('migrateVersionRecord', () => {
  it('never rewrites a stored change summary, including an empty v1 one', () => {
    const v = migrateVersionRecord({
      id: 'v1', playbookId: 'pb1', version: 1, name: 'X', contractType: 'Lease',
      systemPrompt: '', formatPrompt: '', clauses: [], changeSummary: '',
      publishedAt: 5, publishedByUserId: 'u1', schemaVersion: 6,
    });
    // `migrateDraft` substitutes IMPORTED_SUMMARY for a blank summary, which
    // is right for a conversion and wrong for a read: v1 legitimately has none.
    expect(v.changeSummary).toBe('');
    expect(v.changeSummary).not.toBe(IMPORTED_SUMMARY);
  });

  it('gives a pre-D snapshot no version id, and takes its playbook id from `id`', () => {
    const v = migrateVersionRecord(preD);
    expect(v.id).toBe('');
    expect(v.playbookId).toBe('pb1');
    expect(v.version).toBe(1);
    expect(v.clauses[0].extractPrompt).toBe('Find the break clause');
  });

  it('repairs an unreadable record instead of throwing', () => {
    const v = migrateVersionRecord(null);
    expect(v.name).toBe('Untitled playbook');
    expect(v.clauses).toEqual([]);
  });
});

describe('migrateDraft', () => {
  it('falls back to the playbook name when the content has none', () => {
    expect(migrateDraft({}, 'Fallback').name).toBe('Fallback');
  });
});

describe('the startup conversion (R-D7)', () => {
  it('converts a pre-D playbook exactly once, even if the migration runs twice', async () => {
    await savePlaybookRaw(preD);
    await migrateIfNeeded();
    await migrateIfNeeded();
    expect((await listVersions('pb1')).map(v => v.version)).toEqual([1]);
  });

  it('two concurrent migrations still publish exactly one v1', async () => {
    // Found in a browser, not here: React StrictMode double-invokes App's
    // mount effect, so `migrateIfNeeded()` ran twice on the same tick. Both
    // calls read no flag, both saw no `currentVersionId`, and one playbook
    // came out holding v1 AND v2 with byte-identical content — the exact
    // corruption R-D7 exists to prevent, reached through the startup path
    // rather than a read path. The durable flag does not defend this; the
    // per-playbook transaction does.
    await savePlaybookRaw(preD);
    await savePlaybookRaw({ ...preD, id: 'pb2', name: 'Second' });
    await Promise.all([migrateIfNeeded(), migrateIfNeeded()]);
    expect((await listVersions('pb1')).map(v => v.version)).toEqual([1]);
    expect((await listVersions('pb2')).map(v => v.version)).toEqual([1]);
  });

  it('does not skip D\'s conversion for a user already migrated by sub-project A', async () => {
    // Sub-project A's flag is set; D's is not. The playbook must still convert.
    await writeV1Flag(0);
    await savePlaybookRaw(preD);
    await migrateIfNeeded();
    expect((await getPlaybook('pb1'))!.currentVersionId).toBeTruthy();
  });

  it('two concurrent listPlaybooks calls publish nothing', async () => {
    // The read path must not write at all — this is the race the lazy design
    // would have lost.
    await savePlaybookRaw(preD);
    await Promise.all([listPlaybooks(), listPlaybooks()]);
    expect(await listVersions('pb1')).toEqual([]);
  });

  it('carries the pre-D content into the published v1 verbatim', async () => {
    await savePlaybookRaw(preD);
    await migrateIfNeeded();
    const [v1] = await listVersions('pb1');
    expect(v1.name).toBe('Commercial Lease');
    expect(v1.riskTolerance).toBe('We are risk-averse on uncapped liability.');
    expect(v1.clauses[0].extractPrompt).toBe('Find the break clause');
    expect(v1.changeSummary).toBe(IMPORTED_SUMMARY);
  });

  it('does not reorder the library — createdAt and updatedAt survive the conversion', async () => {
    await savePlaybookRaw(preD);
    await migrateIfNeeded();
    const pb = (await getPlaybook('pb1'))!;
    expect(pb.createdAt).toBe(1000);
    expect(pb.updatedAt).toBe(2000);
  });

  it('adopts an orphaned version rather than publishing a duplicate v1', async () => {
    // A conversion interrupted between `publishVersion` and the identity
    // write back: the version exists, the pointer does not. Publishing again
    // would leave v1 and v2 holding identical content.
    const db = await getDb();
    await savePlaybookRaw(preD);
    await db.put(STORES.playbookVersions, {
      id: 'orphan-v1', playbookId: 'pb1', version: 1, name: 'Commercial Lease',
      contractType: 'Lease', systemPrompt: 'sys', formatPrompt: 'fmt', clauses: [],
      changeSummary: IMPORTED_SUMMARY, publishedAt: 1, publishedByUserId: '', schemaVersion: 6,
    });
    await migrateIfNeeded();
    expect((await listVersions('pb1')).map(v => v.version)).toEqual([1]);
    expect((await getPlaybook('pb1'))!.currentVersionId).toBe('orphan-v1');
  });

  it('reports a conversion failure loudly, leaves no half-converted playbook, and resumes', async () => {
    await savePlaybookRaw(preD);
    const db = await getDb();
    const realTx = db.transaction.bind(db);
    const spy = vi.spyOn(db, 'transaction').mockImplementation(((stores: unknown, ...rest: unknown[]) => {
      if (Array.isArray(stores) && stores.includes(STORES.playbookVersions)) {
        throw new Error('conversion quota exceeded');
      }
      return (realTx as (...a: unknown[]) => unknown)(stores, ...rest);
    }) as typeof db.transaction);
    const result = await migrateIfNeeded();
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/quota/i);
    // Atomic: the conversion is one transaction over both stores, so a
    // failure leaves neither a published version nor a pointer to one.
    expect(await listVersions('pb1')).toEqual([]);
    expect((await getPlaybook('pb1'))!.currentVersionId).toBeUndefined();
    spy.mockRestore();

    // And no flag was written, so a later attempt still gets to convert.
    await migrateIfNeeded();
    expect((await getPlaybook('pb1'))!.currentVersionId).toBeTruthy();
    expect((await listVersions('pb1')).map(v => v.version)).toEqual([1]);
  });
});
