import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

/**
 * STAGE 3'S DEFINITION OF DONE — §18 item 4, searched rather than assumed.
 *
 * *"a run survives a worker restart mid-run and completes; cancelling leaves
 * no cell in `pending`; re-running a clause clears its disposition and its
 * net position in one transaction AND records the clearing in
 * `finding_disposition_event`, attributed to whoever asked for the re-run;
 * the run worker's role provably cannot write either disposition table;
 * `carryHumanState` is deleted and nothing regressed."*
 *
 * ## What this file is, and what it deliberately is not
 *
 * Four of those five clauses can only be made against a real database or a
 * real stack, and each already has a suite that makes it. Restating a claim
 * a `.pg.test.ts` proves would be two suites making one claim — this
 * project's most repeated failure, where the weaker copy is always the one
 * that stays green when the property breaks. So what is here is:
 *
 *  1. **The structural facts those suites depend on and cannot check about
 *     themselves** — that the suite exists, that it is wired into a config
 *     something runs, and that the code it exercises still has the shape its
 *     assertions assume.
 *  2. **The fifth clause in full**, because it is a DELETION and an absence
 *     has no suite of its own by definition.
 *  3. **What Stage 3 promised NOT to build** (P28, §13): every attribution
 *     and history surface is Stage 4's, and half of one shipped here would
 *     be worse than none.
 *
 * `stage3DoD.pg.test.ts` carries the database claims that have no home.
 *
 * Every scanner here is paired with a check that it finds what it claims to
 * scan. This stage has now caught SEVEN guards that were not guarding,
 * including one whose pattern was correct and pointed at a directory the
 * statements had left.
 */

const at = (p: string): string => path.join(ROOT, p);
const there = (p: string): boolean => existsSync(at(p));

const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...CORE_SOURCES];

/** Source files, comments stripped, whose CODE names `needle`. Comments are
 *  removed first because this repository is full of prose about the things
 *  it forbids — a text search cannot tell a violation from a note saying it
 *  must not happen. */
function grepRepo(needle: string | RegExp): string[] {
  const re = typeof needle === 'string'
    ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : needle;
  return ALL_SOURCES.filter(f => re.test(codeOf(f))).map(rel).sort();
}

describe('the scanners find something', () => {
  it('reads every workspace, and enough of each to mean anything', () => {
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(30);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(ALL_SOURCES.length).toBeGreaterThan(180);
  });

  it('grepRepo finds a name that IS there, and misses one that is only in prose', () => {
    // Both directions. A `grepRepo` that always returned `[]` would satisfy
    // every `toEqual([])` below, which is the whole failure mode this stage
    // has caught seven times.
    expect(grepRepo('findingsKeyFor').length).toBeGreaterThan(3);
    expect(grepRepo('reconcileFindings')).toContain('apps/api/src/findings/reconcile.ts');
    expect(grepRepo('a-name-no-source-file-contains')).toEqual([]);
  });

  it('finds every file this suite makes a claim about', () => {
    for (const file of [
      'src/App.tsx', 'src/lib/db/reviews.ts',
      'apps/api/src/routes/reviews.ts', 'apps/api/src/routes/runs.ts',
      'apps/api/src/findings/reconcile.ts', 'apps/api/src/findings/import.ts',
      'apps/api/src/dispositions/service.ts', 'apps/api/src/run/worker.ts',
      'apps/api/src/run/queue.ts', 'apps/api/src/run/reaper.ts',
      'apps/api/migrations/010_freeze_findings.sql',
      'apps/api/test/runWorker.compose.test.ts', 'apps/api/test/runLifecycle.pg.test.ts',
      'apps/api/test/rerunReset.pg.test.ts', 'apps/api/test/workerGrants.pg.test.ts',
      'apps/api/test/humanStateSurvives.pg.test.ts', 'apps/api/test/frozenBlob.pg.test.ts',
      'apps/api/test/stage3DoD.pg.test.ts',
    ]) {
      expect(there(file), file).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 *  §18 item 4, clause by clause                                       *
 * ------------------------------------------------------------------ */

describe('§18 item 4.1 — a run survives a worker restart mid-run and completes', () => {
  it('is proved against the REAL STACK, by a suite something runs', () => {
    /*
     * Not a claim a unit test can make, and not one this file restates.
     * `runWorker.compose.test.ts` seeds 150 cells, restarts the `api`
     * container while cells are leased, and waits for `succeeded`.
     *
     * What is asserted here is that it exists, that `test:compose` runs it,
     * and that it still checks the two things that make it worth running:
     * nothing left `pending`, and the two state machines agreeing.
     */
    const suite = readFileSync(at('apps/api/test/runWorker.compose.test.ts'), 'utf8');
    expect(suite).toContain("compose(['restart', 'api']");
    expect(suite).toMatch(/runState\(\) === 'succeeded'/);
    expect(suite).toMatch(/expect\(findingsIn\('pending'\)\)\.toBe\(0\)/);
    expect(suite).toMatch(/expect\(cellsIn\('leased'\)\)\.toBe\(0\)/);

    const config = readFileSync(at('vitest.compose.config.ts'), 'utf8');
    expect(config).toMatch(/compose\.test\.ts/);
    const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8')) as
      { scripts: Record<string, string> };
    expect(pkg.scripts['test:compose']).toContain('vitest.compose.config.ts');
  });

  it('and the lease it recovers is re-claimable, which is what makes the restart survivable', () => {
    // The mechanism, not the scenario: a process may expire a lease stamped
    // with its OWN identity, because if this process is starting, whatever
    // held that lease is gone. `workerId` is the container's hostname rather
    // than its pid for exactly this reason.
    const worker = codeOf(at('apps/api/src/run/worker.ts'));
    expect(worker).toContain('export async function releaseOwnOrphanedLeases');
    expect(worker).toMatch(/leased_by like \$1/);
    expect(worker).toMatch(/lease_expires_at = now\(\) - interval '1 second'/);
  });
});

describe('§18 item 4.2 — cancelling leaves no cell in pending', () => {
  it('is proved over a real database, and the two sweeps stay two', () => {
    /*
     * `runLifecycle.pg.test.ts` carries it ("cancels what has not started
     * and keeps what has", "stops the queue"). The structural fact it
     * depends on is that `cancelled` and `error` are two different
     * transitions in one module — a cell left by a CANCELLED run becomes
     * `cancelled`, the identical cell left by a REAPED run becomes `error`,
     * because nobody cancelled it and calling it cancelled would tell a
     * reviewer a decision was made that was not.
     */
    expect(readFileSync(at('apps/api/test/runLifecycle.pg.test.ts'), 'utf8'))
      .toContain('cancels what has not started and keeps what has');
    const lifecycle = codeOf(at('apps/api/src/run/lifecycle.ts'));
    expect(lifecycle).toContain('export async function cancelPendingCells');
    expect(lifecycle).toContain('export async function failRunCells');
    // Both name the states they may touch: a cancelled run is real, partial
    // work, and a sweep that reset its findings would destroy answers a
    // person may already have read and verified.
    expect(lifecycle).toMatch(/const OPEN_FINDING_STATES = \['pending', 'running'\]/);
    expect((lifecycle.match(/status = any\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('§18 item 4.3 — the re-run reset is one transaction, recorded and attributed', () => {
  it('goes through the ONE writer of both tables, in the caller s transaction', () => {
    /*
     * `rerunReset.pg.test.ts` proves the behaviour ("records the clearing as
     * well as performing it", "attributes the clearing to whoever asked for
     * the re-run", "rolls back the disposition, the event and the finding
     * together"). What is structural, and what that suite cannot check about
     * itself, is that there is no SECOND way to clear a disposition: the
     * retry route holds no `update finding_disposition` of its own, and the
     * reset is `createRun`'s, over one cell or over all of them.
     */
    const runs = codeOf(at('apps/api/src/routes/runs.ts'));
    expect(runs).toMatch(/\/retry/);
    expect(runs).not.toMatch(/update\s+finding_disposition/i);
    const queue = codeOf(at('apps/api/src/run/queue.ts'));
    expect(queue).toMatch(/only\?: CellKey\[\]/);
    expect(queue).toContain("'rerun_reset'");
    expect(queue).toContain('setDisposition');
    // The rule that makes `rerun_reset` safe: the one write the system
    // performs on its own behalf can only ever REMOVE a claim that a human
    // checked something. Refused in the service AND by a check constraint.
    expect(codeOf(at('apps/api/src/dispositions/service.ts')))
      .toMatch(/cause === 'rerun_reset' && change\.state !== 'unchecked'/);
    const migrations = readdirSync(at('apps/api/migrations'))
      .filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(at(`apps/api/migrations/${f}`), 'utf8')).join('\n');
    expect(migrations).toMatch(/rerun_reset_only_unchecks/);
  });

  it('clears the NET POSITION too, which is the half easiest to forget', () => {
    // A net position is synthesised text no document contains, and a
    // confirmation of it describes one specific synthesis. Re-running the
    // clause destroys that synthesis, so keeping the confirmation would let
    // an export present text a person never saw as accepted.
    expect(codeOf(at('apps/api/src/run/queue.ts'))).toMatch(/net_position\s*=\s*null/);
    expect(readFileSync(at('apps/api/test/rerunReset.pg.test.ts'), 'utf8'))
      .toContain('clears the net position too, in the same transaction');
  });
});

describe('§18 item 4.4 — the run worker cannot write either disposition table', () => {
  it('is proved by ATTEMPTING every verb as the role, in two suites', () => {
    /*
     * THE ONE CLAUSE THAT CANNOT BE PROVED BY BEHAVIOUR. "A mid-run
     * verification survives fifteen later cells" passes with the grant and
     * without it, because a worker that never attempts the write and one
     * that cannot are indistinguishable from outside. So the database is
     * asked, as `lexprompt_worker`, and every verb is tried.
     *
     * `caps.test.ts` scans MIGRATION TEXT and cannot see a grant applied
     * from `infra/postgres`, a deployment step or a DBA — which is why the
     * proof is a statement rather than a scan, and why this file asserts the
     * statements exist rather than re-reading 006.
     */
    const shared = readFileSync(at('apps/api/test/helpers/dispositionGrants.ts'), 'utf8');
    for (const verb of ['select state from finding_disposition', 'insert into finding_disposition',
      'update finding_disposition', 'delete from finding_disposition',
      'select to_state from finding_disposition_event', 'insert into finding_disposition_event',
      'delete from finding_disposition_event', "nextval('finding_disposition_event_id_seq')"]) {
      expect(shared, `the grant proof does not attempt: ${verb}`).toContain(verb);
    }
    for (const suite of ['apps/api/test/workerGrants.pg.test.ts',
      'apps/api/test/humanStateSurvives.pg.test.ts']) {
      const code = readFileSync(at(suite), 'utf8');
      expect(code, suite).toContain('refusesEveryDispositionStatement');
      expect(code, suite).toContain('refusesEveryDispositionEventStatement');
    }
    // …and each refusal is PAIRED with the same statement succeeding as
    // another role, so a table that did not exist could not produce
    // failures of roughly the right shape and prove nothing.
    expect(readFileSync(at('apps/api/test/humanStateSurvives.pg.test.ts'), 'utf8'))
      .toContain('the APP role can do all of it');
  });

  it('and 006 revokes rather than merely not granting, which is what a blanket grant would undo', () => {
    const sql = readdirSync(at('apps/api/migrations')).filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(at(`apps/api/migrations/${f}`), 'utf8')).join('\n');
    expect(sql).toMatch(/revoke\s+all\s+on\s+finding_disposition[\s\S]{0,120}lexprompt_worker/i);
    expect(sql).toContain('create table finding_disposition');   // the sanity check
  });
});

describe('§18 item 4.5 — carryHumanState is deleted and nothing regressed', () => {
  it('has deleted carryHumanState and findingMerge.ts', () => {
    expect(there('src/lib/findingMerge.ts')).toBe(false);
    expect(there('src/lib/findingMerge.test.ts')).toBe(false);
    expect(grepRepo('carryHumanState')).toEqual([]);
    expect(grepRepo('findingMerge')).toEqual([]);
    // NO TEST FILE IMPORTS IT EITHER, and that needs its own sweep: `walk`
    // excludes `.test.ts`, so `grepRepo` above cannot see one. An `import`
    // rather than the bare name, because THIS file names it in the line
    // above and a sweep for the name would find itself — which it did, on
    // the first run, and is the shape of a guard reporting its own text.
    const IMPORTS = /from '[^']*findingMerge'/;
    expect(IMPORTS.test("import { carryHumanState } from './lib/findingMerge';")).toBe(true);
    expect(IMPORTS.test("expect(grepRepo('findingMerge')).toEqual([]);")).toBe(false);
    const importers: string[] = [];
    let scanned = 0;
    for (const dir of ['src', 'apps/api/test', 'packages/core/src']) {
      for (const f of readdirSync(at(dir), { recursive: true }) as string[]) {
        if (!/\.tsx?$/.test(f)) continue;
        // THIS FILE, which carries the import line above as its own sanity
        // check and is therefore found by its own sweep. Excluded by name
        // rather than by relaxing the pattern — the pattern is right, and a
        // guard that reports its own text is a guard that gets loosened
        // until it stops biting.
        if (f.endsWith('stage3DoD.test.ts')) continue;
        scanned += 1;
        if (IMPORTS.test(readFileSync(at(`${dir}/${f}`), 'utf8'))) importers.push(`${dir}/${f}`);
      }
    }
    expect(scanned, 'the importer sweep read nothing').toBeGreaterThan(200);
    expect(importers, 'something still imports findingMerge').toEqual([]);
  });

  it('…and the property that replaced it is real, not merely the absence of a merge', () => {
    // The engine writes model-authored columns and nothing else, and a
    // findings read that spans a human write is DISCARDED AND REISSUED
    // rather than merged — the one window rows do not close by themselves.
    const app = codeOf(at('src/App.tsx'));
    expect(app).toContain('humanWritesRef');
    expect(app).toMatch(/state\.again = true;\s*\n\s*continue;/);
    // `verification` and `notes` are DESTRUCTURED OFF the worker's write by
    // type, so the engine cannot carry a human's judgement into it.
    expect(codeOf(at('apps/api/src/run/worker.ts')))
      .toMatch(/const \{ verification: _verification, notes: _notes, \.\.\.content \} = finding/);
  });

  it('and the browser no longer orchestrates a run or writes a whole review s findings', () => {
    // The condition the deletion was gated on, re-asserted where a reader of
    // this file will look for it.
    const app = codeOf(at('src/App.tsx'));
    expect(app).not.toMatch(/\brunReview\(/);
    expect(app).toContain('startRun(');
    expect(app).toContain('watchRun(');
    expect(grepRepo('createDebouncedReviewSaver')).toEqual([]);
    // `saveReview` sends no findings; `importReview` is the one write that
    // does, and its only caller is the uploader.
    const reviews = codeOf(at('src/lib/db/reviews.ts'));
    expect(reviews).toMatch(/const \{ findings: _findings, \.\.\.rest \} = r/);
    expect(reviews).toContain('export async function importReview');
    // The client, its one caller, and the fake server the upload suite drives
    // it against — which has to name it for the same reason the real route
    // does: `saveReview` and `importReview` are two different writes.
    expect(grepRepo('importReview')).toEqual([
      'src/lib/db/reviews.ts', 'src/lib/upload/run.ts', 'src/test/uploadServer.ts',
    ]);
  });
});

/* ------------------------------------------------------------------ *
 *  What Stage 3 promised NOT to build                                 *
 * ------------------------------------------------------------------ */

describe('the attribution surface Stage 3 promised NOT to build (P28, §13), now built', () => {
  it('has dispositionLabel, and it lives beside verificationLabel and nowhere else', () => {
    /*
     * STAGE 3 ASSERTED THIS WAS ABSENT, AND STAGE 4 INVERTS IT RATHER THAN
     * DELETING IT (P30).
     *
     * The original reason for the absence still stands and is kept on the
     * record: a LABEL with no mechanism behind it was half of Stage 4's most
     * important feature, and half an attribution surface is worse than none
     * — an "as at" stamp on a document whose dispositions nobody else can
     * change is a claim about a risk that does not exist yet.
     *
     * Stage 4 built the mechanism (two real accounts, a directory resolving
     * an id to a name, a read carrying the event that produced a
     * disposition), so the assertion INVERTS: the wording exists, and it
     * exists in exactly ONE place. A file that loses its guard the moment
     * the guarded thing happens has stopped guarding.
     */
    const declares = (re: RegExp): string[] =>
      ALL_SOURCES.filter(f => re.test(codeOf(f))).map(rel);
    expect(declares(/export function dispositionLabel/)).toEqual(['src/lib/findingOutcome.ts']);
    expect(declares(/export function dispositionHistoryLine/))
      .toEqual(['src/lib/findingOutcome.ts']);
    // The sanity check. Both assertions above are satisfied by a scanner
    // that read one file, and Stage 3 found nine guards in that state.
    expect(ALL_SOURCES.length).toBeGreaterThan(180);
    // …and `grepRepo` really can return more than one file, so a
    // single-element answer above is a fact about the codebase rather than
    // about the scanner. `dispositionLabel`'s own callers arrive in Task 5;
    // `verificationLabel`, the function this one sits beside, already has
    // four, and the case below asserts that list exactly.
    expect(grepRepo('verificationLabel').length).toBeGreaterThan(1);
    expect(grepRepo('dispositionLabel')).toContain('src/lib/findingOutcome.ts');
  });

  it('states a previous state in ONE module, so no second surface composes its own', () => {
    // The "was X" absence, inverted the same way. `STATE_WORD` and the two
    // templates that read it are what compose that clause, and all of them
    // live in `findingOutcome.ts`. A component building "was Rejected" out
    // of its own state name is exactly the drift `verificationLabel` was
    // extracted to end — the DOCX and the CSV disagreed once already.
    expect(grepRepo('STATE_WORD')).toEqual(['src/lib/findingOutcome.ts']);
    // …and nothing anywhere hard-codes one, which is what a component
    // written in a hurry would do.
    const HARD_CODED = /['"`]was (?:Rejected|Verified|Flagged|Unverified)/;
    expect(grepRepo(HARD_CODED)).toEqual([]);
    // The sanity check for that `toEqual([])`: the pattern bites on the
    // thing it forbids and not on the interpolation that replaces it.
    expect(HARD_CODED.test("const s = 'was Rejected';")).toBe(true);
    expect(HARD_CODED.test('const s = `, was ${STATE_WORD[previous]}`;')).toBe(false);
  });

  it('has exactly one home for the export s point-in-time wording (P30, inverted)', () => {
    // Stage 3 asserted that "dispositions as at" appeared NOWHERE, and gave
    // its reason: an "as at" stamp on a document whose dispositions nobody
    // else could change would have been a claim about a mechanism that did
    // not exist.
    //
    // It exists now. Stage 4 made a disposition mutable by anyone in the
    // workspace at any time, so every export became a point-in-time claim
    // and section 6.3.1 requires it to say so. The absence is INVERTED
    // rather than deleted (P30), so the record of what was deferred and
    // when it landed stays readable.
    const declares = (re: RegExp): string[] =>
      ALL_SOURCES.filter(f => re.test(codeOf(f))).map(rel);
    expect(declares(/export function dispositionsAsAtLine/))
      .toEqual(['src/lib/findingOutcome.ts']);
    expect(declares(/export function dispositionsMayChangeLine/))
      .toEqual(['src/lib/findingOutcome.ts']);
    // The STRING itself lives in exactly one file. Both exporters call the
    // function; neither spells the sentence.
    expect(grepRepo(/Dispositions as at/)).toEqual(['src/lib/findingOutcome.ts']);
    expect(grepRepo(/history is authoritative over any printed copy/))
      .toEqual(['src/lib/findingOutcome.ts']);
    // …and both exporters DO carry it, which is the half a scanner reading
    // one file would miss. A stamp defined once and called nowhere is the
    // silent failure section 19 names.
    expect(grepRepo('dispositionsAsAtLine')).toEqual([
      'src/features/review/exportDocx.ts',
      'src/features/tabular/csv.ts',
      'src/lib/findingOutcome.ts',
    ]);
    expect(grepRepo('dispositionsMayChangeLine')).toEqual([
      'src/features/review/exportDocx.ts',
      'src/features/tabular/csv.ts',
      'src/lib/findingOutcome.ts',
    ]);
    expect(ALL_SOURCES.length).toBeGreaterThan(180);
  });

  it('and the export wording still lives in exactly one module', () => {
    // The sanity check for the five absences above, and the rule they exist
    // to protect: the CSV and the DOCX drifted apart on this once before,
    // and both call these rather than composing their own strings.
    const outcome = codeOf(at('src/lib/findingOutcome.ts'));
    expect(outcome).toContain('export function verificationLabel');
    expect(outcome).toContain('export function exportSummaryLine');
    // Four readers and one definition. `draftEmail.ts` is the fourth and
    // belongs: an email drafted about a review states what a human concluded
    // about each finding, and a fifth hand-written phrasing of "Verified by
    // …" is exactly the drift this module exists to prevent.
    expect(grepRepo('verificationLabel')).toEqual([
      'src/features/assistant/draftEmail.ts',
      'src/features/review/exportDocx.ts',
      'src/features/tabular/csv.ts',
      'src/lib/findingOutcome.ts',
    ]);
  });

  it('ships no assignee field, and no second person anywhere (R-G1, P24)', () => {
    // `Verification.assigneeId` retired in Task 22. The one module left
    // naming it walks an uploaded record's raw JSON, where the key still
    // exists in data exported before the change.
    // TWO, and the second is the record that makes the removal honest:
    // `findings/backfill.ts` NAMES every finding that carried a non-empty
    // `assigneeId` in the migration report rather than dropping it silently
    // (P24). A removal with a record is not a discard.
    expect(grepRepo(/\bassigneeId\b/)).toEqual([
      'apps/api/src/findings/backfill.ts', 'src/lib/upload/attribution.ts',
    ]);
    // …and neither of them is a type declaring the field or a component
    // rendering it, which is what R-G1 is actually about.
    expect(codeOf(at('packages/core/src/domain/types.ts'))).not.toMatch(/\bassigneeId\b/);
    expect(codeOf(at('packages/core/src/domain/verification.ts'))).not.toMatch(/\bassigneeId\b/);
    expect(grepRepo(/\bassigneeId\b/).filter(f => f.endsWith('.tsx'))).toEqual([]);
    expect(grepRepo(/assign(ed)?[- ]?to[- ]?me/i)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 *  The blob, and the tool that can still read it                      *
 * ------------------------------------------------------------------ */

describe('review.findings is frozen and KEPT (P18)', () => {
  it('no migration drops it, and the freeze is the form that actually freezes', () => {
    const sql = readdirSync(at('apps/api/migrations')).filter(f => f.endsWith('.sql'))
      .map(f => readFileSync(at(`apps/api/migrations/${f}`), 'utf8')).join('\n');
    const DROPS = /drop\s+column[^;]*\bfindings\b|alter\s+table\s+review[^;]*drop[^;]*\bfindings\b/i;
    expect(DROPS.test('alter table review drop column findings;')).toBe(true);   // it bites
    expect(DROPS.test(sql), 'a migration DROPS the frozen blob').toBe(false);
    // A column-level revoke against a TABLE-level grant is a no-op in
    // Postgres — no error, no warning. The table grant is revoked and the
    // columns are granted back by name.
    expect(sql).toMatch(/revoke\s+update\s+on\s+review\s+from\s+lexprompt_app/i);
    const grant = /grant\s+update\s*\(([^)]*)\)\s*on\s+review\s+to\s+lexprompt_app/i.exec(sql);
    expect(grant).not.toBeNull();
    expect(grant![1]).not.toMatch(/\bfindings\b/);
    expect(grant![1]).toMatch(/\bplaybook_snapshot\b/);
  });

  it('nothing writes the blob, and the reconciler that reads it survives', () => {
    expect(grepRepo(/findings\s*=\s*excluded\.findings/)).toEqual([]);
    expect(grepRepo('writeFindingRows')).toEqual([]);
    expect(there('apps/api/src/findings/write.ts')).toBe(false);
    // …and the tool for any future doubt about the migration is still here,
    // with the blob reader it needs.
    const reconcile = codeOf(at('apps/api/src/findings/reconcile.ts'));
    expect(reconcile).toContain('export async function reconcileFindings');
    expect(reconcile).toContain('export function readFindingsBlob');
    expect(reconcile).toContain('select target, findings, workspace_id from review');
  });
});
