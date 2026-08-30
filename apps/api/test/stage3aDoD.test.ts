import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf, statementsIn } from './sourceScan.ts';

/**
 * Part 3A's definition of done, as a suite that fails when any of it stops
 * being true.
 *
 * Part 3A's whole claim is TWO things at once, and a gate that checks only
 * the first is the one most likely to be written:
 *
 *  1. **The new machinery exists and is sound.** Rows are shadow-written
 *     beside the blob, the queue and its three loops run, and the engine's
 *     role has no path to a human judgement.
 *  2. **Nothing a user can see has changed yet.** The browser still
 *     orchestrates every run, still owns `review.findings`, and nothing
 *     anywhere reads a finding out of a row. The reader flip is Task 14, the
 *     writer flip is Tasks 18-20, `carryHumanState` goes in Task 21 and the
 *     blob is frozen in Task 22 — **in that order**, and each of them is
 *     guarded here from arriving early.
 *
 * The second half is the one this file is really for, because it is made of
 * ABSENCES: a route nobody calls, a module nobody wrote yet, a deletion that
 * has not happened. An absence has no suite of its own by definition, which
 * is the same reasoning `stage2DoD.test.ts` gives for its own shape, and
 * this file follows it — including its rule about NOT restating a claim that
 * a suite running against a real Postgres already makes. Where a Part 3A
 * clause is carried by `.pg.test.ts`, this file asserts the structural fact
 * that suite depends on and cannot check about itself, and
 * `stage3aDoD.pg.test.ts` carries the two database claims that have no home.
 *
 * Every scanner here is paired with a sanity check that it finds what it
 * claims to scan. This stage alone has now caught SIX guards that were not
 * guarding: a case-sensitive regex that never matched `renderPageImages`; a
 * walker covering only `src/`; an author query that matched nothing because
 * the notes are a jsonb array; a page-image guard blind to its own target;
 * `workspaceScope.test.ts`'s literal extractor, which lost six statements to
 * one apostrophe (fixed in `sourceScan.ts` by this task); and this task's own
 * brief, whose `toContain('carryHumanState')` passes with every call site
 * deleted, because the import line survives. A guard that matches nothing
 * passes vacuously and reads as coverage.
 */

const WEB_SOURCES = walk(path.join(ROOT, 'src'));
const API_SOURCES = walk(path.join(ROOT, 'apps/api/src'));
const GATEWAY_SOURCES = walk(path.join(ROOT, 'apps/gateway/src'));
const CORE_SOURCES = walk(path.join(ROOT, 'packages/core/src'));
const ALL_SOURCES = [...WEB_SOURCES, ...API_SOURCES, ...GATEWAY_SOURCES, ...CORE_SOURCES];
const ROUTE_SOURCES = walk(path.join(ROOT, 'apps/api/src/routes'));
const MIGRATIONS = path.join(ROOT, 'apps/api/migrations');

const at = (file: string): string => path.join(ROOT, file);
const there = (file: string): boolean => existsSync(at(file));

/** Every migration's SQL with `--` comments removed, joined. The strip is
 *  not tidiness: every migration in this project explains its grants at
 *  length in prose, so a scan over the raw text finds the SENTENCE saying
 *  the worker holds no grant and reports it as a grant. */
function migrationSql(): string {
  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  return files.map(f => readFileSync(path.join(MIGRATIONS, f), 'utf8').replace(/--[^\n]*/g, ''))
    .join('\n');
}

/** Of every statement in a file, the ones that WRITE. A column named in a
 *  `select` list, or in a row-mapping object literal, is not a write.
 *  `statementsIn` is `sourceScan.ts`'s — shared with
 *  `workspaceScope.test.ts` rather than copied, and escape-aware for the
 *  reason its own note gives. */
function statementsWriting(code: string): string[] {
  return statementsIn(code).filter(s => /^\s*(insert\s+into|update)\s+/i.test(s));
}

describe('the scanners find something (a guard that matches nothing passes vacuously)', () => {
  it('walks every workspace, and a realistic number of files in each', () => {
    // Sanity bounds on the SCANNERS, not budgets on the workspaces. Each is
    // set low enough that only a walk which silently returned almost nothing
    // can fail it — which is the one failure they exist to catch.
    expect(WEB_SOURCES.length).toBeGreaterThan(120);
    expect(API_SOURCES.length).toBeGreaterThan(30);
    expect(GATEWAY_SOURCES.length).toBeGreaterThan(10);
    expect(CORE_SOURCES.length).toBeGreaterThan(15);
    expect(ALL_SOURCES.length).toBeGreaterThan(200);
    expect(ROUTE_SOURCES.length).toBeGreaterThan(10);
  });

  it('reads the migrations, and finds the statements this part depends on', () => {
    const sql = migrationSql();
    expect(readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).length).toBeGreaterThanOrEqual(9);
    // The strip keeps statements and drops prose — asserted in both
    // directions, because a strip that removed everything would make every
    // `not.toContain` below pass.
    expect(sql).toContain('create table finding_disposition');
    expect(sql).toContain('grant select, insert, update on finding to lexprompt_worker');
    expect(sql).not.toContain('the grant is the guarantee');
  });

  it('finds every file this suite makes a claim about', () => {
    for (const file of [
      'src/App.tsx', 'src/lib/findingMerge.ts', 'src/lib/db/reviews.ts',
      'src/features/review/runReview.ts', 'src/lib/api/client.ts',
      'apps/api/src/routes/reviews.ts', 'apps/api/src/routes/runs.ts',
      'apps/api/src/findings/write.ts', 'apps/api/src/findings/reconcile.ts',
      'apps/api/src/findings/backfill.ts', 'apps/api/src/findings/read.ts',
      'apps/api/src/dispositions/service.ts', 'apps/api/src/routes/findings.ts',
      'src/lib/api/findings.ts',
      'apps/api/src/run/worker.ts', 'apps/api/src/run/queue.ts', 'apps/api/src/run/reaper.ts',
      'apps/api/src/main.ts',
      'apps/api/test/dispositions.pg.test.ts', 'apps/api/test/shadowWrite.pg.test.ts',
      'apps/api/test/workerGrants.pg.test.ts', 'apps/api/test/runWorker.compose.test.ts',
      'apps/api/test/stage3aDoD.pg.test.ts',
    ]) {
      expect(there(file), file).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 *  1. The new machinery exists                                        *
 * ------------------------------------------------------------------ */

describe('Part 3A: the new machinery exists and is sound', () => {
  it('has exactly two writers of finding_disposition in the source, and names why each is one', () => {
    /*
     * The plan's own sentence (Task 5) is *"the only writers of either table
     * in the codebase"* about `dispositions/service.ts`, and the brief for
     * this task asserts exactly that one file. **The shipped source has two**,
     * and the second is legitimate: `findings/backfill.ts` is Task 6's
     * one-time migration of the existing blobs into rows, which necessarily
     * writes the tables it is creating and cannot go through a service whose
     * job is one deliberate change at a time. Where a brief and the shipped
     * source disagree, the shipped source wins — so the list names both, with
     * the reason, rather than being relaxed to "at most a few".
     *
     * A third name appearing here is the finding. It would mean a disposition
     * — a lawyer's judgement — written from somewhere that is neither a
     * person's request nor the one-time migration.
     */
    const WRITES = /insert\s+into\s+finding_disposition|update\s+finding_disposition/i;
    // The scan bites on what it looks for, in both spellings and both cases.
    expect(WRITES.test('await t.query(`insert into finding_disposition (review_id) …`)')).toBe(true);
    expect(WRITES.test('UPDATE FINDING_DISPOSITION SET state = $1')).toBe(true);
    expect(WRITES.test("select state from finding_disposition where review_id = $1")).toBe(false);

    const writers = ALL_SOURCES.filter(f => WRITES.test(codeOf(f))).map(rel).sort();
    expect(writers).toEqual([
      // The one deliberate writer: `setDisposition` and `ensureDisposition`.
      'apps/api/src/dispositions/service.ts',
      // Task 6's one-time backfill. Writes both tables once, from the blob's
      // own census, and refuses rather than guessing.
      'apps/api/src/findings/backfill.ts',
    ]);
    expect(ALL_SOURCES.length).toBeGreaterThan(200);        // the sanity check
  });

  it('has the same two writers of the HISTORY table, which is the one that is evidence', () => {
    const WRITES =
      /insert\s+into\s+finding_disposition_event|update\s+finding_disposition_event/i;
    expect(WRITES.test('insert into finding_disposition_event (review_id)')).toBe(true);
    const writers = ALL_SOURCES.filter(f => WRITES.test(codeOf(f))).map(rel).sort();
    expect(writers).toEqual([
      'apps/api/src/dispositions/service.ts',
      'apps/api/src/findings/backfill.ts',
    ]);
  });

  it('shadow-writes the rows inside the SAME transaction as the blob (P17)', () => {
    /*
     * P17's whole content: *"there is never only one copy of a judgement
     * inside the change that alters it"*. Two transactions — write the blob,
     * then write the rows — leaves a crash between them with a blob and rows
     * that disagree, and nothing that would notice.
     *
     * Checked structurally rather than by text proximity: the ONE call site
     * is inside `routes/reviews.ts`, it is handed a `Tx` named `t`, and the
     * review upsert that writes the blob is issued on that same `t`. The
     * type system carries the rest — `writeFindingRows` takes a `Tx`, and a
     * `Db` will not type-check in its place.
     */
    const callers = ALL_SOURCES.filter(f => /await\s+writeFindingRows\s*\(/.test(codeOf(f)))
      .map(rel).sort();
    expect(callers).toEqual(['apps/api/src/routes/reviews.ts']);
    // `await` rather than the bare name, because the bare name also matches
    // the `export async function` that declares it — a scan that counted its
    // own definition as a caller would report two and be relaxed to `.length
    // <= 2`, which would then admit a real second caller silently.
    expect(codeOf(at('apps/api/src/findings/write.ts'))).toContain('export async function writeFindingRows');
    const route = codeOf(at('apps/api/src/routes/reviews.ts'));
    expect(route).toMatch(/await\s+writeFindingRows\(\s*t\s*,/);
    expect(route).toMatch(/await\s+t\.query<ReviewRow>\(\s*`?\s*insert into review/);
    // …and the blob write is inside a transaction at all.
    expect(route).toContain('return db.tx(async t => {');
  });

  it('runs the engine as its own role, and starts all three loops', () => {
    // The grant is the guarantee: an engine that connected as the app role
    // would be able to overwrite a verification with every test still green.
    const main = codeOf(at('apps/api/src/main.ts'));
    expect(main).toMatch(/makePool\(\s*config\.databaseWorkerUrl/);
    for (const loop of ['startWorkerPool', 'startParseWorkers', 'startReaper']) {
      expect(main, loop).toContain(loop);
    }
    // …and all three are stopped on the way down, which is what turns a
    // SIGTERM into a lease the next process can reclaim rather than one it
    // has to wait out.
    expect(main).toMatch(/parseWorkers\.stop\(\)[\s\S]{0,80}runWorkers\.stop\(\)[\s\S]{0,80}reaper\.stop\(\)/);
  });
});

/* ------------------------------------------------------------------ *
 *  2. Nothing a user can see has changed                              *
 * ------------------------------------------------------------------ */

describe('Part 3A: nothing a user can see has changed yet', () => {
  it('still calls carryHumanState — it is deleted in Task 21, not before', () => {
    /*
     * Not a joke, and the cheapest possible proof that the browser still
     * orchestrates. `runReview` owns its own copy of a run and overwrites
     * human-authored state roughly twice per cell; `carryHumanState` is the
     * only thing that puts a verification back onto each snapshot. While a
     * browser still drives a run, deleting it discards a lawyer's judgement
     * silently — which is this stage's one irreversible risk.
     *
     * Its deletion is Task 21 and is gated on the browser having stopped
     * orchestrating (Task 18) and stopped writing (Task 19).
     */
    const app = codeOf(at('src/App.tsx'));
    expect(app).toContain("import { carryHumanState } from './lib/findingMerge'");
    // Called, not merely imported — and more than once, because the three
    // call sites are three different paths a snapshot arrives by.
    const calls = app.match(/carryHumanState\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(there('src/lib/findingMerge.ts')).toBe(true);
  });

  it('still orchestrates the run in the browser — runReview and retryCell, not a server run', () => {
    const app = codeOf(at('src/App.tsx'));
    expect(app).toMatch(/import\s*\{[^}]*runReview[^}]*\}\s*from\s*'\.\/features\/review\/runReview'/);
    expect(app).toMatch(/\brunReview\(/);
    expect(app).toMatch(/\bretryCell\(/);
    // …and the debounced whole-review saver is still what persists a run.
    // It goes in Task 18, with the orchestration it exists to keep up with.
    expect(codeOf(at('src/lib/db/reviews.ts'))).toContain('scheduleSave');
  });

  it('the browser calls no run, disposition or note route — the engine is unreachable from it', () => {
    /*
     * The strongest single statement of "no user-visible change": the whole
     * queue landed in Part 3A, every one of its routes is registered and
     * authenticated, and the shipped browser does not know they exist. Task
     * 17 writes the client and Task 18 is the first call.
     *
     * Scanned over `src/` — the browser — rather than over the API, because
     * the routes SHOULD exist server-side. What must not exist is a caller.
     */
    const CALLS = /['"`]\/v1\/runs|\/runs['"`]|\/v1\/dispositions|\/v1\/notes|\/verification['"`]/;
    // The scan bites on each shape a caller could take, including a template
    // literal, which is how every other id-bearing path in this client is
    // written.
    expect(CALLS.test("apiGet('/v1/runs/' + id)")).toBe(true);
    expect(CALLS.test('apiSend(`/v1/reviews/${enc}/runs`, body)')).toBe(true);
    expect(CALLS.test("apiSend('POST', '/v1/dispositions', body)")).toBe(true);
    expect(CALLS.test("apiGet('/v1/reviews/' + id)")).toBe(false);

    const callers = WEB_SOURCES.filter(f => CALLS.test(codeOf(f))).map(rel);
    expect(callers).toEqual([]);
    expect(WEB_SOURCES.length).toBeGreaterThan(120);        // the sanity check
    // …and Task 17's client has not landed early.
    expect(there('src/lib/api/runs.ts'), 'Task 17 arrived early').toBe(false);
  });

  it('READS a finding out of a row, and the blob reaches no reader — Task 14 has landed', () => {
    /*
     * TASK 14 FLIPPED THIS, and the assertion flipped with it rather than
     * being deleted: what it now guards is that the flip is COMPLETE, which
     * is the half a half-done flip would leave true.
     *
     * `findings/read.ts` is the one assembler; the two review-reading
     * routes go through it; and `GET /v1/reviews/:id` no longer hands a
     * caller `review.findings` at all. The blob is still WRITTEN (Task 22
     * freezes it, and "never delete what you cannot read" keeps the column)
     * — it is reading it that has stopped.
     */
    expect(there('apps/api/src/findings/read.ts')).toBe(true);
    const read = codeOf(at('apps/api/src/findings/read.ts'));
    expect(read).toMatch(/\bfrom\s+finding\b/i);
    expect(read).toMatch(/left join finding_disposition/i);
    expect(read).toMatch(/from note/i);

    // NO ROUTE ASSEMBLES ITS OWN FINDINGS. Every read a caller is SERVED
    // comes through the one assembler, so a second query cannot drift from
    // it.
    //
    // Two routes do touch `finding` directly, and both are named as
    // STATEMENTS rather than exempted as files. A file-level exemption hides
    // everything in that file rather than the part it meant to protect
    // (`PdfCanvas.tsx`'s lesson), and both these files will grow.
    const READS = /\bfrom\s+finding\b/i;
    expect(READS.test('select * from finding where review_id = $1')).toBe(true);
    expect(READS.test('select * from finding_disposition where review_id = $1')).toBe(false);
    const readers = ROUTE_SOURCES.filter(f => READS.test(codeOf(f))).map(rel);
    expect(readers).toEqual([
      'apps/api/src/routes/findings.ts',       // an EXISTENCE check
      'apps/api/src/routes/runs.ts',           // "what did this retry clear?"
    ]);
    expect(ROUTE_SOURCES.length).toBeGreaterThan(10);       // the sanity check

    const statementsOver = (file: string): string[] =>
      codeOf(at(file)).match(/\bselect\b[^`]*?\bfrom\s+finding\b[^`]*/gi) ?? [];

    // `routes/findings.ts`: one identifying column and NO content. A
    // disposition or a note about a finding that does not exist is a
    // judgement about nothing, and that has to be answerable before a write.
    const existence = statementsOver('apps/api/src/routes/findings.ts');
    expect(existence).toHaveLength(1);
    expect(existence[0]).toMatch(/select clause_id\s*\n?\s*from finding\b/i);

    // `routes/runs.ts`: ONE column, `net_position`, read INSIDE the retry's
    // own write transaction to answer what that transaction is about to
    // clear — the sentence the browser shows the person who clicked. It is
    // never served as findings, and it reads nothing else.
    const retryProbe = statementsOver('apps/api/src/routes/runs.ts');
    expect(retryProbe).toHaveLength(1);
    expect(retryProbe[0]).toMatch(/select net_position\s*\n?\s*from finding\b/i);

    // Neither selects what a card renders. That is the property this guard
    // is actually about, and it is checked over both.
    for (const statement of [...existence, ...retryProbe]) {
      for (const content of ['summary', 'citations', 'risk_analysis', 'position_rationale']) {
        expect(statement, `a route selects a finding's ${content}`).not.toContain(content);
      }
    }

    // …and no route hands the blob back to a reader. The single-review GET
    // drops the key; the listing replaces it with the assembled rows.
    //
    // NOT `expect(route).not.toMatch(/findings:\s*(row|b)\.findings/)`, which
    // is what this assertion said in its previous form. That pattern was
    // meant to find the RESPONSE carrying the blob, and what it actually
    // matched was `parseReview`'s `findings: b.findings` — the line that
    // reads the blob out of a PUT BODY, which is still there and should be.
    // It would have gone on passing after the flip for a reason that had
    // nothing to do with the flip: one more guard that was not guarding
    // what it claimed.
    const route = codeOf(at('apps/api/src/routes/reviews.ts'));
    expect(route).toContain('readFindingsForReviews');
    expect(route).toMatch(/const \{ findings: _blob, \.\.\.review \} = fromReviewRow\(rows\[0\]\)/);
    expect(route).toMatch(/return review;/);
  });

  it('and a whole-review save can no longer DELETE a finding row (Task 14 s ruling)', () => {
    /*
     * The other half of the flip, and the one that would be silent: while
     * the blob was authoritative, `writeFindingRows` deleted the rows for
     * keys a re-saved body no longer carried, and 005 granted the DELETE
     * for it — both marked "revisit when Task 14 flips the reader". A body
     * that omits a key is now a body that is BEHIND, and the delete would
     * let a stale save destroy an authoritative finding and cascade to a
     * lawyer's verification. `findingsRead.pg.test.ts` proves the
     * behaviour; this proves the statement is not there to be re-enabled by
     * a later edit that "restores" it.
     */
    const write = codeOf(at('apps/api/src/findings/write.ts'));
    const DELETES_FINDING = /delete\s+from\s+finding\b/i;
    // The scan bites on the statement it is looking for.
    expect(DELETES_FINDING.test('await t.query(`delete from finding f where f.review_id = $1`)'))
      .toBe(true);
    expect(DELETES_FINDING.test('delete from note where review_id = $1')).toBe(false);
    expect(DELETES_FINDING.test(write), 'the Task 14 delete is back').toBe(false);
    // The file still writes findings, so the check above is not passing
    // because the file emptied.
    expect(write).toMatch(/insert into finding\b/i);
  });

  it('review.findings is untouched by every migration in this part — P18 is Task 22', () => {
    /*
     * "The blob is unmodified." Two halves, and the second is the one that
     * could be quietly false: no migration in Part 3A alters, drops or
     * revokes anything on that column, and the freeze itself has not arrived
     * early either. P18 is deliberate and it belongs with the writer flip —
     * revoking UPDATE while a browser is still the writer would break every
     * save in the app.
     */
    const sql = migrationSql();
    // The scan bites on each shape the change would take.
    const TOUCHES = /alter\s+table\s+review[^;]*\bfindings\b|drop\s+column[^;]*\bfindings\b|revoke[^;]*\(\s*findings\s*\)[^;]*review/i;
    expect(TOUCHES.test('alter table review drop column findings;')).toBe(true);
    expect(TOUCHES.test('revoke update (findings) on review from lexprompt_app;')).toBe(true);
    expect(TOUCHES.test('create table finding (review_id text not null);')).toBe(false);
    expect(TOUCHES.test(sql), 'a migration in Part 3A changes review.findings').toBe(false);
    // By CONTENT of the name, not by its number. This read
    // `there('apps/api/migrations/009_freeze_findings.sql')`, and 009 is now
    // taken (`009_evidence_and_indexes.sql`), so Task 22's file will be 010
    // and the old assertion would have gone vacuously true — a guard that
    // stops guarding the moment somebody adds an unrelated migration.
    const freezes = readdirSync(MIGRATIONS).filter(f => /freeze_findings/.test(f));
    expect(freezes, 'Task 22 arrived early').toEqual([]);
    // The column and the check that keeps it an object are still there.
    expect(sql).toMatch(/jsonb_typeof\(findings\)\s*=\s*'object'/);
  });
});

/* ------------------------------------------------------------------ *
 *  3. What is NOT true yet, said out loud                             *
 * ------------------------------------------------------------------ */

describe('Part 3A does not claim Stage 3 is done, and says which clauses are open', () => {
  it('§18 item 4 has two clauses this part does not meet, and they belong to named tasks', () => {
    /*
     * §18 item 4 is Stage 3's definition of done, not Part 3A's, and two of
     * its five clauses are Part 3B's by design:
     *
     *  - *"re-running a clause clears its disposition and its net position in
     *    ONE TRANSACTION and records the clearing in
     *    `finding_disposition_event`, attributed to whoever asked for the
     *    re-run"* — NOW MET FOR A WHOLE-REVIEW RE-RUN and still open for a
     *    per-clause retry. `createRun` resets every disposition its cells
     *    cover, through `setDisposition` with cause `rerun_reset`, in the
     *    same transaction that blanks the findings (Part 3A's adversarial
     *    review, M9: the route is registered, authenticated and shipped, so
     *    leaving the judgement behind re-attached a person's verification to
     *    text nobody had seen). What remains Task 16's is
     *    the PER-CLAUSE retry — **which TASK 16 has now landed**, as
     *    `POST /v1/reviews/:id/findings/:findingsKey/:clauseId/retry` in
     *    `routes/runs.ts`. So the first clause is MET, in both its forms,
     *    and the assertions below have flipped with it rather than being
     *    deleted.
     *  - *"`carryHumanState` is deleted and nothing regressed"* — Task 21,
     *    and the test above exists to keep it from arriving early.
     *
     * This test is here so that a reader of a green Part 3A gate cannot
     * mistake it for a green Stage 3 gate. It fails when the remaining task
     * lands without this list being revisited, which is the point: the list
     * is only honest while it is maintained.
     */
    expect(there('src/lib/findingMerge.ts'), 'Task 21 landed; revisit §18 item 4 here').toBe(true);

    // Task 16's route HAS landed, and the reset it performs goes through the
    // one writer of both disposition tables rather than a second UPDATE of
    // its own — which is what makes the history row impossible to forget.
    const runs = codeOf(at('apps/api/src/routes/runs.ts'));
    expect(runs).toMatch(/\/retry/);
    expect(runs).toContain("import { dispositionFor } from '../dispositions/service.ts'");
    expect(runs).not.toMatch(/update\s+finding_disposition/i);
    // …and the reset itself is `createRun`'s, over one cell — one
    // implementation of "re-running a clause clears its verification", not
    // two.
    const queue = codeOf(at('apps/api/src/run/queue.ts'));
    expect(queue).toMatch(/only\?: CellKey\[\]/);
    expect(queue).toMatch(/'rerun_reset'/);
  });

  it('markup_notice is still browser-derived, and the grant is what makes that safe', () => {
    /*
     * P12 is closed for `text`, `parse_state` and `parse_error` — the parse
     * worker writes all three — and OPEN for the tracked-changes disclosure,
     * because detecting tracked changes needs `src/lib/docxMarkup.ts`, which
     * needs `jszip`, which is not a `packages/core` dependency.
     *
     * RULED (Task 13): not a Part 3A gate failure. Part 3A's claim is that
     * nothing a user can see changed, and this is precisely a place where
     * nothing did — the browser still derives the notice and still sends it,
     * exactly as it did in Stage 2. What would make it a failure is the
     * server being ABLE to blank it, and the worker's `update` grant on
     * `document` names its three columns and does not name this one, so it
     * cannot. That is the guarantee; this test is what keeps it one.
     *
     * It becomes a gate item in Part 3B, when Task 18 moves orchestration
     * server-side and an upload could plausibly stop coming from a browser.
     */
    const sql = migrationSql();
    expect(sql).toMatch(
      /grant\s+update\s*\(\s*text\s*,\s*parse_state\s*,\s*parse_error\s*\)\s*on\s+document\s+to\s+lexprompt_worker/i);
    // The column exists, and the worker's grant does not name it.
    expect(sql).toMatch(/markup_notice/);
    const GRANTS_IT = /grant[^;]*\bon\b[^;]*\bdocument\b[^;]*lexprompt_worker/gi;
    for (const grant of sql.match(GRANTS_IT) ?? []) {
      expect(grant, 'the worker was granted markup_notice').not.toMatch(/markup_notice/);
    }
    expect((sql.match(GRANTS_IT) ?? []).length).toBeGreaterThan(0);   // the sanity check
    /*
     * …and the browser is still the only thing that DERIVES it. The server
     * writes the column only where an upload's body carries it; the parse
     * side never does.
     *
     * The distinction matters and it is easy to get backwards: `parse/
     * hydrate.ts` READS `record.markupNotice` and carries it onto the
     * `DocumentFile` handed to the extractor — which is the disclosure
     * reaching the model, and is exactly right. A scan that treated the name
     * appearing anywhere under `parse/` as a violation would have failed on
     * that, and the repair somebody reaches for is to stop carrying it,
     * which would drop the disclosure. So the guard names the SQL WRITE.
     */
    const WRITES_IT = /\bmarkup_notice\b/;
    const sqlWriters = API_SOURCES
      .filter(f => statementsWriting(codeOf(f)).some(s => WRITES_IT.test(s)))
      .map(rel).sort();
    expect(sqlWriters).toEqual([
      // The two upload routes, which take it from the body a browser sent.
      'apps/api/src/routes/documents.ts',
      'apps/api/src/routes/precedents.ts',
    ]);
    // The scan bites, and the derivation itself still lives in the browser.
    expect(statementsWriting("await t.query(`insert into document (markup_notice) values ($1)`)")
      .some(s => WRITES_IT.test(s))).toBe(true);
    expect(WEB_SOURCES.filter(f => /markupNotice/.test(codeOf(f))).length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 *  3b. Every table the engine touches is tried AS THE ENGINE'S ROLE   *
 * ------------------------------------------------------------------ */

/** Every table the schema actually declares, read from the migrations. A
 *  literal list here would agree with whatever it was written against. */
function schemaTables(): string[] {
  const names = [...migrationSql().matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(\w+)"?/gi)]
    .map(m => m[1].toLowerCase());
  return [...new Set(names)].sort();
}

/** Of those, the ones the ENGINE's own statements name. */
function tablesTheEngineTouches(): string[] {
  const code = [
    ...walk(path.join(ROOT, 'apps/api/src/run')),
    ...walk(path.join(ROOT, 'apps/api/src/parse')),
  ].flatMap(f => statementsIn(codeOf(f)));
  const touched = schemaTables().filter(table => code.some(s =>
    new RegExp(String.raw`\b(?:from|into|update|join)\s+(?:only\s+)?"?${table}"?\b`, 'i').test(s)));
  return touched.sort();
}

describe('every table the engine touches is attempted as the role the engine runs as', () => {
  /*
   * WHY THIS EXISTS. `run/worker.ts` reads `app_user` to attribute each
   * gateway call, and `lexprompt_worker` held no grant on it: every cell of
   * the first real run failed with "permission denied for table app_user".
   * The whole suite was green beforehand, because `runHarness.workerDeps`
   * builds the worker's `db` from the harness's pinned APP connection — a
   * real limitation of running a suite inside a rolled-back transaction, and
   * one that cannot be removed without giving up the rollback. The repair
   * was a new grant with NO test that would catch the next one.
   *
   * This is that test. It cannot ask the database (there is none here), so
   * it asks the only other question worth asking: is every table the engine
   * names actually ATTEMPTED, as the worker role, somewhere in
   * `workerGrants.pg.test.ts`? A new engine module reading a table nobody
   * granted now fails here, at `npm test`, naming the table.
   */
  const GRANTS = 'apps/api/test/workerGrants.pg.test.ts';

  it('finds the schema, and the engine s share of it (a scan of nothing passes vacuously)', () => {
    const all = schemaTables();
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(all).toContain('finding');
    expect(all).toContain('finding_disposition_event');
    const touched = tablesTheEngineTouches();
    // The engine reads a document and a review and writes a finding; if this
    // list ever came back short, the scan below would pass by finding
    // nothing to check.
    expect(touched).toEqual(expect.arrayContaining(
      ['collection', 'document', 'event', 'finding', 'review', 'run', 'run_cell']));
    // …and a SUBSET of the schema, not all of it: a scan that matched every
    // table would make the check below meaningless.
    expect(touched.length).toBeLessThan(all.length);
  }, 20_000);

  it('names every one of them in the grants suite, as the worker role', () => {
    const grants = readFileSync(at(GRANTS), 'utf8');
    const missing = tablesTheEngineTouches().filter(t =>
      !new RegExp(String.raw`\b${t}\b`).test(grants));
    expect(missing, `no statement in ${GRANTS} touches these as lexprompt_worker`).toEqual([]);
    // The two the engine must NOT touch are attempted there too, and they
    // are the ones the file was missing entirely: it opened with "the grant
    // is the guarantee" and contained no statement against either.
    expect(grants).toMatch(/finding_disposition\b/);
    expect(grants).toMatch(/finding_disposition_event\b/);
    expect(grants).toMatch(/permission denied/);
  }, 20_000);
});

/* ------------------------------------------------------------------ *
 *  4. The engine's own statements are scoped to a workspace           *
 * ------------------------------------------------------------------ */

describe('the engine s statements name a workspace, which workspaceScope.test.ts does not check', () => {
  /*
   * RULED (Task 13) on the second open item from Tasks 8-12.
   * `workspaceScope.test.ts` walks `apps/api/src/routes` only, and the new
   * `src/run/*` modules issue many statements against `run`, `run_cell`,
   * `event` and `finding`. Extending that file to cover them was rejected
   * for the reason its own author gave: the reaper legitimately sweeps
   * ACROSS workspaces, so it would need an exemption, and a file-level
   * exemption hides everything in the file — the `PdfCanvas` lesson this
   * repository has already paid for once.
   *
   * So the check lives here instead, and it is narrower and honest about
   * being narrower: it asserts that the ONE module which sweeps across
   * workspaces is the reaper, and that every other engine module's
   * statements against a scoped table name `workspace_id` somewhere. That is
   * weaker than `routes/`'s check — which insists the predicate appear in
   * the filtering clause — and deliberately so, because the engine's reads
   * are by ids it claimed itself rather than by an id from a URL, and
   * pretending otherwise would produce a guard nobody could keep green.
   *
   * What it actually catches: a new engine module arriving with no workspace
   * predicate anywhere in a statement against a tenant table, which is how
   * a cross-tenant read gets written by someone who has never seen this
   * rule. And it is not vacuous: it finds statements, and it names the one
   * exemption rather than a directory.
   */
  const ENGINE = walk(path.join(ROOT, 'apps/api/src/run'));
  const SCOPED = ['run', 'run_cell', 'event', 'finding', 'review', 'document', 'collection'];
  const namesScoped = (s: string): string | undefined => SCOPED.find(t =>
    new RegExp(`\\b(?:from|into|update|join)\\s+(?:only\\s+)?"?${t}"?\\b`, 'i').test(s));
  it('finds the engine s modules and their statements', () => {
    expect(ENGINE.map(rel).sort()).toEqual([
      'apps/api/src/run/events.ts', 'apps/api/src/run/lifecycle.ts',
      'apps/api/src/run/modelClient.ts', 'apps/api/src/run/queue.ts',
      'apps/api/src/run/reaper.ts', 'apps/api/src/run/worker.ts',
    ]);
    const scoped = ENGINE.flatMap(f => statementsIn(codeOf(f))).filter(s => namesScoped(s));
    expect(scoped.length).toBeGreaterThanOrEqual(10);       // the sanity check
    expect(namesScoped('select * from run_cell where run_id = $1')).toBe('run_cell');
    expect(namesScoped('SAVEPOINT sp1')).toBeUndefined();
  });

  /**
   * THE STATEMENTS THAT LEGITIMATELY CARRY NO WORKSPACE PREDICATE, one at a
   * time, each with the reason it is allowed to.
   *
   * This replaces a FILE-level rule, and the file-level rule was vacuous.
   * It read `if (!/workspace_id/.test(code))` — whether the string appears
   * anywhere in the module — and `queue.ts:45` declares
   * `workspace_id: string` on `RunRow`, so every engine file satisfied it by
   * its TYPE DECLARATIONS alone. The mutation that left it green: delete
   * `and workspace_id = $2` from every SQL literal in `queue.ts`, including
   * `readRun`'s, which serves `GET /v1/runs/:id` from an id in a URL. The
   * interface field survived, the test passed, and one firm could read
   * another's run.
   *
   * Matching is on the statement's own normalised text, so an exempt
   * statement that is EDITED stops matching and has to be re-justified here.
   * That friction is the point: it is the same reasoning `PdfCanvas`'s
   * file-level palette exemption taught this repository, one layer down —
   * an exemption should cover the line somebody argued for, not everything
   * that happens to sit beside it.
   */
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
  const UNSCOPED_BY_DESIGN = new Map<string, string>([
    // --- the reaper's sweep is across workspaces, and that is its job ---
    [norm(`select * from run where state in ('running','cancelling') and heartbeat_at is not null
           and heartbeat_at < now() - ($1 || ' milliseconds')::interval`),
      'the reaper sweeps every workspace: a dead run is dead in all of them'],
    [norm(`select * from run where id = $1 and state in ('running','cancelling')
           and heartbeat_at < now() - ($2 || ' milliseconds')::interval for update`),
      'the reaper re-reads a run it already selected, by primary key, under for update'],
    [norm(`update run set state = 'failed', finished_at = now(), error = $2, version = version + 1
           where id = $1 returning *`),
      'the reaper writes the run it just locked by primary key'],
    [norm(`select id, review_id from run where state = 'queued' and heartbeat_at is null
           and created_at < now() - ($1 || ' milliseconds')::interval
           order by created_at asc limit 20`),
      'the stalled-queue REPORT is across workspaces, like the sweep it runs beside'],
    // --- the outbox's own bookkeeping ---
    [norm('select min(id) as oldest from event'),
      'the resync watermark is the table minimum, deliberately: a per-run minimum would '
      + 'report a resync for every client that connected before its run wrote an event'],
    [norm("delete from event where at < now() - ($1 || ' days')::interval returning id"),
      'the pruner is a retention sweep across every workspace'],
    // --- writes keyed by a row this process already claimed ---
    [norm(`update run set state = 'running', started_at = coalesce(started_at, now()),
           heartbeat_at = now(),
           version = case when state = 'queued' then version + 1 else version end
           where id = $1 returning *`),
      'promotes the run whose cell CLAIM (workspace-checked) just returned, by primary key'],
    [norm(`update run set provider = coalesce(provider, $2), jurisdiction = coalesce(jurisdiction, $3::jsonb),
           model = coalesce(model, $4)
           where id = $1 and (provider is null or jurisdiction is null or model is null)`),
      'writes what the gateway said onto the run this worker holds a lease on'],
    [norm('select cancel_requested_at from run where id = $1'),
      'the cancel poll reads the run this worker holds a lease on'],
    [norm('update run set heartbeat_at = now() where id = any($1::text[])'),
      'the heartbeat writes the runs whose leases this process holds'],
    [norm(`update run_cell set state = 'cancelled', leased_by = null, lease_expires_at = null
           where run_id = $1 and findings_key = $2 and clause_id = $3`),
      'releases the cell this worker leased and re-read under for update'],
    [norm(`update run_cell set leased_by = null, last_error = $4,
           lease_expires_at = now() + ($5 || ' milliseconds')::interval
           where run_id = $1 and findings_key = $2 and clause_id = $3`),
      'parks the cell this worker leased and re-read under for update'],
    [norm(`update run_cell set state = 'error', last_error = $4, leased_by = null,
           lease_expires_at = null where run_id = $1 and findings_key = $2 and clause_id = $3`),
      'closes the cell this worker leased and re-read under for update'],
    [norm(`update run_cell set state = $4, last_error = $5, leased_by = null, lease_expires_at = null
           where run_id = $1 and findings_key = $2 and clause_id = $3`),
      'writes the result onto the cell this worker leased and re-read under for update'],
    [norm(`update run_cell set lease_expires_at = now() - interval '1 second', leased_by = null
           where state = 'leased' and leased_by like $1 and lease_expires_at > now()
           returning run_id`),
      'releases leases stamped with THIS PROCESS\'s own identity, in any workspace'],
    // Truncated where the source string is: the statement is built by
    // concatenation, and `statementsIn` sees one literal at a time.
    [norm("select distinct run_id from run_cell where state = 'leased' and leased_by like $1"),
      'the active-run set is this process\'s own leases, in any workspace'],
    // --- one template literal that is split by an interpolation ---
    [norm("update finding set ${FINDING_COLUMNS.slice(4).map((c, i) =>"
      + " (c === 'citations' || c === 'net_position' ?"),
      'a fragment: the interpolation ends the literal, and the WHERE half — which does name '
      + 'workspace_id — is a later chunk of the same template'],
  ]);

  it('every scoped statement names a workspace, or is exempt BY STATEMENT with a reason', () => {
    const silent: string[] = [];
    for (const file of ENGINE) {
      for (const statement of statementsIn(codeOf(file))) {
        if (!namesScoped(statement)) continue;
        if (/workspace_id/.test(statement)) continue;
        if (UNSCOPED_BY_DESIGN.has(norm(statement))) continue;
        silent.push(`${rel(file)}: ${norm(statement)}`);
      }
    }
    expect(silent, 'an engine statement against a tenant table names no workspace').toEqual([]);
  });

  it('the exemption list has no stale entries, and every reason is a real one', () => {
    // A list of exemptions that no longer match anything is a list nobody is
    // maintaining, and it hides the day one of them comes back scoped.
    const present = new Set(ENGINE.flatMap(f => statementsIn(codeOf(f))).map(norm));
    const stale = [...UNSCOPED_BY_DESIGN.keys()].filter(k => !present.has(k));
    expect(stale, 'exempted statements that no longer appear in the engine').toEqual([]);
    for (const reason of UNSCOPED_BY_DESIGN.values()) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('and the guard bites on the mutation that used to pass: readRun losing its predicate', () => {
    // `readRun` serves `GET /v1/runs/:id` with an id from a URL. Stripping
    // its `and workspace_id = $2` is a cross-tenant read, and the file-wide
    // predicate this replaced could not see it — `RunRow.workspace_id` on
    // line 45 satisfied it on its own.
    const scoped = 'select * from run where id = $1 and workspace_id = $2';
    expect(codeOf(at('apps/api/src/run/queue.ts'))).toContain(scoped);
    const mutated = 'select * from run where id = $1';
    expect(namesScoped(mutated)).toBe('run');
    expect(/workspace_id/.test(mutated)).toBe(false);
    expect(UNSCOPED_BY_DESIGN.has(norm(mutated))).toBe(false);
  });

  it('the reaper still exists and still sweeps, since its statements are what the list exempts', () => {
    expect(there('apps/api/src/run/reaper.ts')).toBe(true);
    expect(codeOf(at('apps/api/src/run/reaper.ts'))).toMatch(/heartbeat_at/);
  });
});
