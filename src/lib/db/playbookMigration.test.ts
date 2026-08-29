import { describe, it, expect } from 'vitest';
import {
  migratePlaybookRecord,
  migrateDraft,
  migrateClause,
  migrateVersionRecord,
  snapshotPlaybookId,
  IMPORTED_SUMMARY,
} from './playbookMigration';
import { riskCriteriaBlock } from '../riskBlock';

/**
 * Repair-on-read for playbooks, which from Task 23 is the UPLOADER's reader
 * and no longer anybody's writer. `migratePlaybookRecord` is what turns a
 * pre-D record — a v1 template with its clauses on the identity, or a
 * playbook with no `currentVersionId` — into an identity plus a publishable
 * v1, at the moment it moves to the server. Everything here is pure.
 */

/** Deliberately the PRE-D shape, `mode` and all — this is the record the
 *  conversion has to read, so it must not be updated to the new one. */
const preD = {
  id: 'pb1', name: 'Commercial Lease', contractType: 'Lease',
  mode: 'risk', systemPrompt: 'sys', formatPrompt: 'fmt',
  riskTolerance: 'We are risk-averse on uncapped liability.',
  clauses: [{ id: 'c1', title: 'Break', prompt: 'Find the break clause', riskCriteria: 'Must be unconditional' }],
  createdAt: 1000, updatedAt: 2000, schemaVersion: 2,
};

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

  it('clears a stale per-clause riskCriteria on an extraction-mode playbook (R-D1, one level down)', () => {
    // The same defect as the tolerance above, one level down. The pre-D
    // editor hid the per-clause "Risk Scorer" field inside the SAME
    // `{isRiskMode && …}` guard that hid the tolerance, and never cleared it
    // either. A playbook created with Create Template -> AI (which wrote
    // `mode: 'risk'` and a populated `riskCriteria` on every clause) and then
    // switched to Standard sends no risk block today; leaving the criteria
    // behind would make `riskCriteriaBlock` start emitting
    // `RISK CRITERIA: …` on every clause, silently changing the risk levels
    // in the user's next review of a playbook they already own.
    const { version } = migratePlaybookRecord({ ...preD, mode: 'extraction' });
    expect(version!.clauses[0].riskCriteria).toBeUndefined();
    // Absent, not present-and-undefined: structuredClone preserves an
    // `undefined`-valued key all the way into the stored version.
    expect('riskCriteria' in version!.clauses[0]).toBe(false);
  });

  it('keeps a riskTolerance on a record that never had a mode at all', () => {
    // Post-D records carry no `mode`. Treating "no mode" as extraction would
    // strip the tolerance off an already-migrated playbook on every read.
    const { version } = migratePlaybookRecord({
      id: 'pb2', name: 'Post-D', riskTolerance: 'Averse', clauses: [],
    });
    expect(version!.riskTolerance).toBe('Averse');
  });

  it('keeps a per-clause riskCriteria on a record that never had a mode at all', () => {
    // Modeless means POST-D (see `migrateDraft`). Clearing here would be the
    // cumulative silent loss the corrected R-D1 exists to prevent, applied
    // to the clause field instead of the playbook one.
    const { version } = migratePlaybookRecord({
      id: 'pb3', name: 'Post-D', clauses: [{ id: 'c1', title: 'Cap', extractPrompt: 'x', riskCriteria: 'Must be capped' }],
    });
    expect(version!.clauses[0].riskCriteria).toBe('Must be capped');
  });

  it('keeps the riskTolerance on a post-D PUBLISHED VERSION repaired on read (R-D1, fourth case)', () => {
    // R-D1's gate has four inputs: a pre-D risk record, a pre-D extraction
    // record, a post-D draft, and a post-D published version repaired on
    // read. The last was covered only transitively, through `migrateDraft`'s
    // modeless test. It is the one where getting it wrong compounds — the
    // repair runs on EVERY read, so a wrong gate would strip the tolerance
    // and then keep stripping it.
    const v = migrateVersionRecord({
      id: 'v2', playbookId: 'pb1', version: 2, name: 'Lease', contractType: 'Lease',
      systemPrompt: 's', formatPrompt: 'f', riskTolerance: 'Averse to uncapped liability',
      clauses: [{ id: 'c1', title: 'Cap', extractPrompt: 'x', riskCriteria: 'Must be capped' }],
      changeSummary: 'tightened the cap', publishedAt: 9, publishedByUserId: 'u1', schemaVersion: 6,
    });
    expect(v.riskTolerance).toBe('Averse to uncapped liability');
    expect(v.clauses[0].riskCriteria).toBe('Must be capped');
  });

  it('keeps the riskTolerance on a post-D DRAFT stored against the identity (R-D1, third case)', () => {
    const { playbook } = migratePlaybookRecord({
      id: 'pb1', name: 'Lease', currentVersionId: 'v1', schemaVersion: 6,
      draft: {
        name: 'Lease', contractType: 'Lease', systemPrompt: 's', formatPrompt: 'f',
        riskTolerance: 'Averse', changeSummary: 'wip',
        clauses: [{ id: 'c1', title: 'Cap', extractPrompt: 'x', riskCriteria: 'Must be capped' }],
      },
    });
    expect(playbook.draft!.riskTolerance).toBe('Averse');
    expect(playbook.draft!.clauses[0].riskCriteria).toBe('Must be capped');
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
      text: 'We ask for 6 months', origin: 'authored', reviewedByHuman: false,
    });
    // `toEqual` treats an absent key and an `undefined`-valued one as equal,
    // so the assertion above cannot see the difference — and structuredClone
    // (how IndexedDB writes every record) PRESERVES the key. Asserted
    // explicitly, per this file's own comments about omitting rather than
    // assigning `undefined`.
    expect('provenance' in c.standardPosition!).toBe(false);
  });

  it('keeps a readable provenance string', () => {
    const c = migrateClause({
      id: 'c1', title: 'T', extractPrompt: 'x',
      standardPosition: { text: 'We ask for 6 months', origin: 'learned', reviewedByHuman: true, provenance: 'Lease v4' },
    });
    expect(c.standardPosition!.provenance).toBe('Lease v4');
  });
});

// Spec 11: "A risk-mode template must produce the same review it does today
// after migration — that is a test, not an assumption." These assert on the
// PROMPT TEXT the migrated playbook actually emits, through the same
// `riskCriteriaBlock` the extractors call, rather than on the intermediate
// fields — the pre-D expression was
// `mode === 'risk' ? clause.riskCriteria || template.riskTolerance || 'General commercial reasonableness.' : ''`,
// and that string is what has to survive.
describe('the risk block a migrated playbook emits (spec 11)', () => {
  const blockFor = (record: unknown, clauseIndex = 0) => {
    const version = migrateVersionRecord(record);
    return riskCriteriaBlock(version.clauses[clauseIndex], version);
  };

  it('a risk-mode playbook with a tolerance and clause criteria emits exactly what it did before', () => {
    expect(blockFor(preD)).toBe('\nRISK CRITERIA: Must be unconditional');
    expect(blockFor({ ...preD, clauses: [{ id: 'c1', title: 'Cap', prompt: 'p' }] }))
      .toBe('\nRISK CRITERIA: We are risk-averse on uncapped liability.');
  });

  it('a risk-mode playbook with NO tolerance and NO clause criteria still emits the generic block', () => {
    // Pre-D this fell through to `'General commercial reasonableness.'`.
    // R-D1's wording never addressed the empty case, so dropping it was an
    // unintended consequence: a risk playbook that used to send a generic
    // block and now sends none has had its review behaviour silently
    // changed on data the user owns — the exact thing R-D1 exists to stop.
    expect(blockFor({
      id: 'pb9', name: 'Bare risk', mode: 'risk',
      clauses: [{ id: 'c1', title: 'Cap', prompt: 'p' }],
    })).toBe('\nRISK CRITERIA: General commercial reasonableness.');
  });

  it('the mirror: an extraction-mode playbook with nothing emits no block at all', () => {
    expect(blockFor({
      id: 'pb9', name: 'Bare standard', mode: 'extraction',
      clauses: [{ id: 'c1', title: 'Cap', prompt: 'p' }],
    })).toBe('');
  });

  it('the mirror: an extraction-mode playbook carrying stale risk strings still emits no block', () => {
    // Both halves of R-D1 read end to end: the tolerance AND the clause
    // criteria the pre-D editor hid without clearing.
    expect(blockFor({ ...preD, mode: 'extraction' })).toBe('');
  });

  it('a post-D (modeless) playbook with no risk strings gains no generic block', () => {
    // The generic fallback is a PRE-D compatibility fact, materialised once
    // at migration. Applying it to a modeless record would switch the risk
    // block on for every playbook authored after `mode` retired.
    expect(blockFor({
      id: 'pb9', name: 'Post-D', clauses: [{ id: 'c1', title: 'Cap', extractPrompt: 'p' }],
    })).toBe('');
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

// `reviews.ts`'s `buildVersionIndex` needs this identical fact for the
// identical reason `migrateVersionRecord` does, and used to re-derive it with
// a second copy of this same fallback chain. Tested directly here so the two
// callers can never drift again without this failing first.
describe('snapshotPlaybookId', () => {
  it('prefers playbookId when the snapshot is already a real PlaybookVersion', () => {
    expect(snapshotPlaybookId({ id: 'v1', playbookId: 'pb1' })).toBe('pb1');
  });

  it('falls back to id for a pre-D snapshot, whose id IS the playbook id', () => {
    expect(snapshotPlaybookId(preD)).toBe('pb1');
  });

  it('returns empty when neither field is a usable string', () => {
    expect(snapshotPlaybookId({})).toBe('');
    expect(snapshotPlaybookId(null)).toBe('');
    expect(snapshotPlaybookId({ playbookId: '', id: 7 })).toBe('');
  });
});

describe('migrateDraft', () => {
  it('falls back to the playbook name when the content has none', () => {
    expect(migrateDraft({}, 'Fallback').name).toBe('Fallback');
  });

  // Integrity review (D/E), Major 1. ABSENT is a pre-versioning record and
  // gets the label; an explicit `''` is a post-D draft or export that
  // genuinely has no summary, and inventing one for it made every
  // round-tripped draft differ from its own published version.
  it('labels a summary that is ABSENT, and preserves one that is explicitly empty', () => {
    expect(migrateDraft({ name: 'X' }, 'X').changeSummary).toBe(IMPORTED_SUMMARY);
    expect(migrateDraft({ name: 'X', changeSummary: '' }, 'X').changeSummary).toBe('');
    expect(migrateDraft({ name: 'X', changeSummary: 'Tightened the cap.' }, 'X').changeSummary)
      .toBe('Tightened the cap.');
  });
});

/**
 * The startup conversion's own tests are GONE, with the conversion (Task 23).
 *
 * Nine cases lived here — converted exactly once, two concurrent calls
 * publish one v1, a user already migrated by sub-project A still converts,
 * the read path publishes nothing, content and timestamps survive, an
 * orphaned version is adopted, a failure is loud and resumable. Every one of
 * them was about `migrateIfNeeded` writing into the IndexedDB `playbooks`
 * and `playbookVersions` stores — stores the app stopped reading in Part 2A,
 * and which `open.ts` now refuses to write to at all.
 *
 * What they were protecting has not been dropped, it has MOVED, and the
 * tests moved with it:
 *
 *  - a pre-D playbook is converted by `migratePlaybookRecord` on its way to
 *    the SERVER (`src/lib/upload/run.ts`), and the content it carries into
 *    the published v1 is what the cases above this line still assert;
 *  - "exactly one v1" is now `publishVersion`'s server-side allocation, and
 *    `apps/api/test/playbooks.pg.test.ts` proves it against a real database
 *    with a real row lock, which is stronger than an IndexedDB transaction
 *    ever was;
 *  - "the read path publishes nothing" is no longer a property anyone has to
 *    test: `open.test.ts`'s read-only guard makes a write from the browser
 *    impossible rather than merely absent.
 */
