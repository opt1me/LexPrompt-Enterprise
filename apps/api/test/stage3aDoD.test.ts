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
      'apps/api/src/findings/backfill.ts', 'apps/api/src/dispositions/service.ts',
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

  it('nothing reads a finding out of a row — that flip is Task 14', () => {
    /*
     * The blob is still authoritative. `GET /v1/reviews/:id` returns
     * `review.findings` and no route touches the `finding` table for a read.
     * The three writers below are exactly the three that Part 3A puts there:
     * the shadow write, the backfill and the engine.
     */
    const READS = /\bfrom\s+finding\b/i;
    expect(READS.test('select * from finding where review_id = $1')).toBe(true);
    expect(READS.test('select * from finding_disposition where review_id = $1')).toBe(false);
    expect(ROUTE_SOURCES.filter(f => READS.test(codeOf(f))).map(rel)).toEqual([]);
    expect(ROUTE_SOURCES.length).toBeGreaterThan(10);       // the sanity check

    // Task 14's own module has not landed early.
    expect(there('apps/api/src/findings/read.ts'), 'Task 14 arrived early').toBe(false);
    // …and the review the API returns still carries the blob.
    const route = codeOf(at('apps/api/src/routes/reviews.ts'));
    expect(route).toMatch(/findings:\s*(row|b)\.findings/);
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
    expect(there('apps/api/migrations/009_freeze_findings.sql'), 'Task 22 arrived early')
      .toBe(false);
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
     *    re-run"* — the server-side retry is Task 16. Today a re-run happens
     *    in the browser, `resetVerification`/`resetPosition` clear the blob,
     *    and the shadow writer translates that into a disposition change
     *    attributed to the person saving. Same outcome, different mechanism,
     *    and not the one transaction the clause names.
     *  - *"`carryHumanState` is deleted and nothing regressed"* — Task 21,
     *    and the test above exists to keep it from arriving early.
     *
     * This test is here so that a reader of a green Part 3A gate cannot
     * mistake it for a green Stage 3 gate. It fails when either task lands
     * without this list being revisited, which is the point: the list is
     * only honest while it is maintained.
     */
    expect(there('src/lib/findingMerge.ts'), 'Task 21 landed; revisit §18 item 4 here').toBe(true);
    const app = codeOf(at('src/App.tsx'));
    // The browser's own reset, still the only one there is.
    expect(app).toMatch(/resetVerification|resetPosition/);
    // Task 16's route has not landed.
    const runs = codeOf(at('apps/api/src/routes/runs.ts'));
    expect(runs, 'Task 16 landed; revisit §18 item 4 here').not.toMatch(/\/retry/);
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

  it('every engine module but the reaper names a workspace in its scoped statements', () => {
    // The reaper is the ONE exemption, and it is named as a file here
    // because the whole file is the sweep — not as a directory, and not as
    // a pattern that would quietly cover the next module too.
    const ACROSS_WORKSPACES = 'apps/api/src/run/reaper.ts';
    const silent: string[] = [];
    for (const file of ENGINE) {
      if (rel(file) === ACROSS_WORKSPACES) continue;
      const code = codeOf(file);
      const scoped = statementsIn(code).filter(s => namesScoped(s));
      if (scoped.length === 0) continue;
      if (!/workspace_id/.test(code)) silent.push(rel(file));
    }
    expect(silent).toEqual([]);
    // …and the exemption is still a file that exists and still sweeps.
    expect(there(ACROSS_WORKSPACES)).toBe(true);
    expect(codeOf(at(ACROSS_WORKSPACES))).toMatch(/heartbeat_at/);
  });
});
