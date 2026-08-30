import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, walk, rel, codeOf, statementsIn } from './sourceScan.ts';

/**
 * Every SQL statement in a route module names `workspace_id`.
 *
 * CREATED BY TASK 9 AND EXTENDED BY EVERY LATER ROUTE TASK. §19's warning is
 * about a query that forgets the `kind` predicate, "because such a query
 * fails by showing too much rather than too little, and nothing on screen
 * would look wrong" — and every word of that is true of `workspace_id`, one
 * level more serious, because what it shows is another firm's matters. A
 * missing `and workspace_id = $2` breaks nothing a test of the feature would
 * notice: the record is found, the page renders, the reader is told a fact
 * about a contract they were never entitled to see.
 *
 * So the guard is structural rather than per-route. A route task that adds a
 * statement gets this check for free, which is the only way a rule survives
 * six more tasks.
 */

/**
 * The tables `002_records.sql` gives a `workspace_id`, and therefore the
 * tables a statement must scope.
 *
 * `workspace` and `role_mapping` are absent, and for a reason rather than an
 * omission: `role_mapping`'s own docstring in `roles.ts` says why a
 * workspace filter there could only ever remove a row the lookup should have
 * seen.
 *
 * ## `app_user` JOINED THIS LIST IN STAGE 4, AND THE REASON IT WAS OUT OF IT
 * ## STOPPED BEING TRUE
 *
 * It used to say: *"a request never looks a user up by anything but the
 * identity the authentication hook already resolved — `(issuer, subject)`,
 * which is unique across the whole table — so the row is reached through the
 * actor rather than searched for within a workspace."* Every word of that
 * was true until `GET /v1/workspace/users` (§6.3, P32), which is the first
 * query in this codebase that SEARCHES `app_user` within a workspace: it
 * answers "who are the people here" for a card that has to turn a
 * `byUserId` into a name. A missing predicate there does not fail — it
 * answers, with every other firm's people in it, and nothing on screen would
 * look wrong. That is exactly the shape this guard exists for, so the table
 * is now scanned like any other and the two statements that legitimately do
 * not carry the predicate are exempted BY TEXT below.
 *
 * A stale docstring is the more dangerous half of this change: a rule that
 * explains why something is safe, kept beside code that no longer makes it
 * safe, is read as a decision rather than as a fossil.
 */
const SCOPED_TABLES = [
  // §6.3/P32's directory reads it within a workspace — see the paragraph
  // above. The two statements that identify a row by the ACTOR's own
  // identity are in `SCOPED_BY_KEY`.
  'app_user',
  'matter', 'document', 'collection', 'playbook', 'playbook_version', 'review', 'changeset',
  'precedent_set', 'position_basis',
  // 008's three (Stage 3 Task 8). `run` and `run_cell` carry a workspace and
  // are reached by id from a URL, which is exactly the shape this guard is
  // about: `GET /v1/runs/<someone else's run>` finds the row, renders the
  // page and tells a reader how another firm's review is going. `event` is
  // the same one layer down — its payloads name findings by key.
  'run', 'run_cell', 'event',
  // 005 and 006's four (Stage 3 Task 25). These are the tables a finding, a
  // lawyer's judgement, its history and a person's remark actually live in
  // since the flip, and they were outside this guard for the whole of Part
  // 3A because the guard only read `routes/`. A query over
  // `finding_disposition` with no workspace predicate fails by showing
  // another firm's judgements, and nothing on screen would look wrong.
  'finding_disposition_event', 'finding_disposition', 'finding', 'note',
];

/** `from x` / `into x` / `update x` / `join x`, where x is a scoped table.
 *  Word-bounded, so `playbook_version` is not matched by `playbook`. */
const namesScopedTable = (statement: string): string | undefined =>
  SCOPED_TABLES.find(table => new RegExp(
    `\\b(?:from|into|update|join)\\s+(?:only\\s+)?"?${table}"?\\b`, 'i',
  ).test(statement));

/**
 * Every string literal in `code`, split on `;` so a literal carrying two
 * statements is checked as two.
 *
 * Read out of the COMMENT-STRIPPED source (`codeOf`), because this file is
 * full of prose about SQL — including the paragraph above — and a scanner
 * that cannot tell a statement from a sentence describing one ends up being
 * relaxed until it stops biting.
 *
 * MOVED TO `sourceScan.ts` BY STAGE 3 TASK 13, and fixed in the move. The
 * copy that lived here was not escape-aware, so one apostrophe in one error
 * message (`routes/ingest.ts`'s `'document\'s contents with another\'s.'`)
 * desynchronised every literal after it in that file and made three
 * `select … from document …` statements invisible to this guard, plus three
 * more in `routes/documents.ts`. See the note on `statementsIn` itself; the
 * count below is what proves the fix, and it is asserted rather than
 * described.
 */

/**
 * EVERY SOURCE FILE IN THE API, not only `routes/`.
 *
 * This read `apps/api/src/routes` alone, and for Stages 1 and 2 that was
 * where every statement was. Stage 3 moved most of them: the queue
 * (`run/queue.ts`), the worker (`run/worker.ts`), the reaper, the parse
 * worker, the findings reader, the disposition service and the import all
 * issue SQL against tenant-scoped tables, and none of them was scanned.
 *
 * That is the failure mode this file's own sanity checks exist for, arriving
 * from the other direction: not a pattern that matched nothing, but a
 * pattern pointed at the wrong half of the codebase. The counts below are
 * asserted so a later move cannot quietly take the statements out of view
 * again.
 */
const SCANNED = path.join(ROOT, 'apps/api/src');
const ROUTES_DIR = path.join(ROOT, 'apps/api/src/routes');

/**
 * WHICH MODULES THIS GUARD IS ABOUT, and it is not all of them.
 *
 * The rule exists because a REQUEST carries an id out of a URL: `GET
 * /v1/runs/<someone else's run>` finds the row, renders the page and tells a
 * reader how another firm's review is going. Everything on that path must
 * name `workspace_id`.
 *
 * Two kinds of module are NOT on it, and saying so precisely is the
 * difference between a ruling and an excuse:
 *
 *  - **The engine.** `run/worker.ts`, `run/reaper.ts`, `run/events.ts` and
 *    `parse/parseWorker.ts` act on the whole database on nobody's behalf.
 *    There is no requesting workspace to scope to: the worker leases the
 *    next claimable cell, whoever owns it, and the reaper sweeps every run
 *    whose heartbeat has stopped. A `workspace_id = $1` there would need a
 *    workspace to put in `$1`, and the honest answer is that there isn't
 *    one. What DOES have to hold is that the engine writes a finding by its
 *    full key including the workspace, and that is asserted directly below
 *    rather than left to this scanner.
 *  - **The migration and the reconciliation.** `findings/backfill.ts` shreds
 *    every review in the database (007) and `findings/reconcile.ts` compares
 *    the frozen blob against the rows for a review named by an operator.
 *    Both are corpus-wide by design; scoping them would make them answer
 *    about one tenant and call it the corpus.
 *
 * Asserted as an exact list, so a NEW module cannot join it by accident: a
 * file under `apps/api/src` that is neither here nor scanned fails the
 * "every file is accounted for" test below.
 */
const UNSCOPED_BY_DESIGN = [
  'apps/api/src/run/worker.ts',
  'apps/api/src/run/reaper.ts',
  'apps/api/src/run/events.ts',
  'apps/api/src/parse/parseWorker.ts',
  'apps/api/src/findings/backfill.ts',
  'apps/api/src/findings/reconcile.ts',
];

/**
 * The statements that identify a row by a key which is ITSELF proven to be
 * in this workspace, one query earlier.
 *
 * Both are `dispositions/service.ts`'s, and the proof is `requireFinding`:
 * every route that reaches this service calls it first, and it selects the
 * finding with `workspace_id = $4` and throws when there is none. The key
 * `(review_id, findings_key, clause_id)` is a finding's primary key, so a
 * key that survived that check names a row in this workspace. The write is
 * then an optimistic-concurrency update by key AND `version`, whose whole
 * point is that it applies to the row that was read or to nothing.
 *
 * That gate is asserted below rather than trusted — it is what makes these
 * two exemptions true, and if a route ever reached the service without it,
 * this list would be a hole rather than a ruling.
 *
 * LISTED AS EXACT STATEMENT TEXT, not as a file exemption. A file-level
 * exemption hides everything in that file, not the part it was meant to
 * protect — `PdfCanvas.tsx` shipped three unrestyled states behind one, and
 * `SCAN_EXEMPT` is empty in the palette guard for that reason. A THIRD
 * unscoped statement in `dispositions/service.ts` fails this guard, which is
 * the property a file exemption would have destroyed.
 */
const SCOPED_BY_KEY = [
  'select review_id, findings_key, clause_id, workspace_id, state, reason',
  'set state = $4, reason = $5, by_user_id = $6, at = $7',
  // `PUT /v1/me`, the one thing §7 lets a person change about themselves.
  // It identifies the row by `app_user.id` — the actor's OWN id, which the
  // authentication hook resolved from a validated token and which nothing a
  // caller sends can name (`authz.route.test.ts`: `req.actor` is written in
  // exactly one place). A `workspace_id` predicate here would add nothing:
  // the id already names one row, and it is the caller's.
  'update app_user set display_name = $2, initials = $3 where id = $1',
  // Just-in-time provisioning (`resolveActor`). The conflict target is
  // `(issuer, subject)` — UNIQUE across the whole table, and exactly the
  // identity `jwtVerify` just proved — so the row this reaches is the one
  // the caller's own token names, not one found by searching a workspace.
  // `workspace_id` is in the INSERT and NOT in the DO UPDATE list, so this
  // statement cannot move a person between workspaces however it is
  // reached; a `where` here could only ever refuse the row the sign-in is
  // about. Exempt only because `app_user` joined SCOPED_TABLES in Stage 4 —
  // it was never a violation, it was previously invisible.
  'on conflict (issuer, subject) do update set',
];

/**
 * The statements this scanner CANNOT read, and it is not allowed to pretend
 * otherwise.
 *
 * `statementsIn` is a regex over source text, and its own docstring says
 * what it cannot do: *"a nested template expression containing a backtick
 * would still confuse it"*. Two statements are built that way — the
 * finding upsert in `findings/import.ts` and the finding update in
 * `run/worker.ts`, both of which interpolate `FINDING_COLUMNS` through a
 * `.map()` whose callback contains its own template literal. The scanner
 * sees them TRUNCATED, before their `where` clause, so it reports them
 * unscoped.
 *
 * They are not exempted on that basis. The `where` clause each one really
 * has is asserted against the raw source in the test below, which is the
 * only honest way to cover a statement a scanner cannot parse: not a
 * silence, a different assertion.
 */
const TRUNCATED_BY_INTERPOLATION: Array<{ file: string; contains: string }> = [
  { file: 'apps/api/src/findings/import.ts', contains: 'insert into finding (${FINDING_COLUMNS' },
  { file: 'apps/api/src/run/worker.ts', contains: 'update finding set ${FINDING_COLUMNS' },
];

describe('the scanner finds something (a guard that matches nothing passes vacuously)', () => {
  it('walks EVERY api source file and finds statements against scoped tables', () => {
    const files = walk(SCANNED);
    expect(files.length).toBeGreaterThan(0);
    const scoped = files
      .flatMap(f => statementsIn(codeOf(f)))
      .filter(s => namesScopedTable(s) !== undefined);
    expect(scoped.length).toBeGreaterThanOrEqual(4);
    // …and it reaches PAST `routes/`, which is the whole of Task 25 Step 1.
    // Named files rather than a count, so a move shows up as a failure here
    // rather than as a number that happens to still be met.
    const reached = files.map(rel);
    for (const file of [
      'apps/api/src/run/queue.ts', 'apps/api/src/run/worker.ts',
      'apps/api/src/dispositions/service.ts', 'apps/api/src/findings/read.ts',
      'apps/api/src/findings/import.ts', 'apps/api/src/parse/parseWorker.ts',
    ]) {
      expect(reached, file).toContain(file);
    }
  });

  it('finds a query over each of the six new tables with no workspace predicate', () => {
    // THE SANITY CHECK Task 25 Step 1 asks for by name. A scanner that
    // matched nothing reported zero violations repo-wide for a whole
    // sub-project once (the `PdfCanvas` exemption), and this one had the
    // same shape for a different reason: the pattern was right and it was
    // pointed at a directory the statements had left.
    const unscoped = (statement: string): boolean =>
      namesScopedTable(statement) !== undefined
      && !/workspace_id/.test(predicateRegion(statement));
    expect(unscoped('select * from finding where review_id = $1')).toBe(true);
    expect(unscoped('select * from note where review_id = $1')).toBe(true);
    expect(unscoped('update finding_disposition set state = $1 where review_id = $2')).toBe(true);
    expect(unscoped('select * from finding_disposition_event where review_id = $1')).toBe(true);
    expect(unscoped('select * from run_cell where run_id = $1')).toBe(true);
    expect(unscoped('select * from event where run_id = $1')).toBe(true);
    // …and the same six WITH the predicate are not violations, so the check
    // above is about the predicate rather than about the table name.
    expect(unscoped('select * from finding where review_id = $1 and workspace_id = $2'))
      .toBe(false);
    expect(unscoped('select * from note where review_id = $1 and workspace_id = $2')).toBe(false);
  });

  it('exempts statements BY TEXT, and every exemption still matches something', () => {
    // A stale exemption is an exemption nobody re-reads. Each entry must
    // still be found in the source, and must still be a statement this
    // guard would otherwise flag — an exemption that has stopped applying
    // is one that silently covers whatever moves under it next.
    const all = walk(SCANNED).flatMap(f => statementsIn(codeOf(f)));
    for (const allowed of SCOPED_BY_KEY) {
      const hits = all.filter(s => s.includes(allowed));
      expect(hits, `no statement matches the exemption ${JSON.stringify(allowed)}`)
        .toHaveLength(1);
      expect(namesScopedTable(hits[0])).toBeDefined();
      expect(/workspace_id/.test(predicateRegion(hits[0]))).toBe(false);
    }
  });

  it('recognises a statement that names a scoped table, and one that does not', () => {
    expect(namesScopedTable('select * from matter where id = $1')).toBe('matter');
    expect(namesScopedTable('insert into review (id) values ($1)')).toBe('review');
    expect(namesScopedTable('delete from document where id = $1')).toBe('document');
    expect(namesScopedTable('select * from playbook_version where id = $1'))
      .toBe('playbook_version');
    // `app_user` IS scoped as of Stage 4 (see SCOPED_TABLES) — the negative
    // example moved to a table that genuinely is not, rather than being
    // deleted. A guard whose only negative case disappears when the answer
    // changes has stopped being able to tell the two apart.
    expect(namesScopedTable('update app_user set display_name = $2')).toBe('app_user');
    expect(namesScopedTable('select role from role_mapping where issuer = $1')).toBeUndefined();
    expect(namesScopedTable('select id from workspace where id = $1')).toBeUndefined();
    expect(namesScopedTable('SAVEPOINT sp1')).toBeUndefined();
  });

  it('reads string literals out of code and not out of comments', () => {
    const sample = codeOf(path.join(ROUTES_DIR, 'matters.ts'));
    expect(statementsIn(sample).some(s => /insert into matter/.test(s))).toBe(true);
    // The module's own prose quotes `where matter.version = $8`; if comments
    // survived, that sentence would be scanned as a statement.
    expect(sample).not.toContain('most likely to be read wrongly');
  });

  it('sees EVERY scoped clause in the source, not only the ones before the first apostrophe', () => {
    /*
     * ADDED BY STAGE 3 TASK 13, and it failed when it was written.
     *
     * The old extractor was not escape-aware, so `routes/ingest.ts`'s
     * `'document\'s contents with another\'s.'` terminated its own literal
     * early and desynchronised every literal after it in that file. The
     * result: THREE `select id from document where id = $1 and workspace_id
     * = $2` statements in `ingest.ts` and three more in `documents.ts` were
     * never scanned by the guard above — six statements against
     * tenant-scoped tables, invisible to the check whose only purpose is to
     * notice a missing `workspace_id`. All six carried the predicate, so
     * nothing in the app was wrong; the guard simply was not looking, and it
     * reported green because its `>= 4` bound was met by the files that
     * still parsed.
     *
     * This test is the one that could have caught it: it compares what the
     * extractor sees against the same clauses found in the RAW
     * comment-stripped source, which needs no quote pairing at all. A
     * scanner that loses a statement is now a failure rather than a smaller
     * number nobody was counting.
     *
     * WIDENED BY THE STAGE 3 FINAL REVIEW (m1). It walked `ROUTES_DIR` while
     * the guard it protects had been widened to all of `apps/api/src` in
     * Task 25 — the desync check covering one half of the codebase and the
     * check it exists to defend covering the other. `run/queue.ts`,
     * `findings/read.ts`, `findings/import.ts` and `dispositions/service.ts`
     * were all scoped-checked and none of them was covered here, so one
     * apostrophe in any of them would have taken its statements out of view
     * with nothing failing anywhere. That is the exact defect this check was
     * added to catch, one directory over.
     *
     * It walks the SCANNED set minus `UNSCOPED_BY_DESIGN`, which is exactly
     * the set of files the main guard enforces on. The excluded six are not
     * a convenience: five clauses in them (`findings/backfill.ts` ×2,
     * `findings/reconcile.ts`, `run/events.ts`, `run/worker.ts`) are
     * genuinely invisible to `statementsIn` because their SQL is built by
     * template interpolation, and the two that matter are covered instead by
     * `TRUNCATED_BY_INTERPOLATION`'s raw-source assertion — a different
     * assertion, not a silence. Requiring a desync check over a file whose
     * statements nothing checks would be asking this test to defend a guard
     * that is not looking.
     */
    const covered = walk(SCANNED).filter(f => !UNSCOPED_BY_DESIGN.includes(rel(f)));
    const invisible = covered.flatMap(file =>
      lostClauses(codeOf(file), statementsIn).map(found => `${rel(file)}: ${found}`));
    expect(invisible).toEqual([]);
    // …and the comparison is not vacuous: the source really does contain
    // clauses against scoped tables.
    const all = covered.flatMap(f => clausesIn(codeOf(f)));
    expect(all.length).toBeGreaterThan(40);
    // …and it really did reach past `routes/`, which is the whole of m1.
    // Named files rather than a count: a count is met by whatever happens to
    // be there, and this check has already been pointed at the wrong half of
    // the codebase once.
    const reached = covered.map(rel);
    for (const file of [
      'apps/api/src/run/queue.ts', 'apps/api/src/findings/read.ts',
      'apps/api/src/findings/import.ts', 'apps/api/src/dispositions/service.ts',
    ]) {
      expect(reached, file).toContain(file);
    }
  });

  it('REPORTS a lost statement in a file outside routes/, so the widening is not decorative', () => {
    /*
     * THE SANITY CHECK FOR THE WIDENING ABOVE. A check that has just been
     * pointed at more files is worth exactly what it can report in the newly
     * covered ones, and this stage has found eight guards that were not
     * scanning what they claimed to.
     *
     * It runs the same comparison over the REAL `findings/read.ts` — one of
     * the four files m1 named as scoped-checked but not desync-checked —
     * with an extractor deliberately made to lose exactly the statements
     * that matter. If the comparison cannot say so, it would not say so for
     * a real extractor bug either.
     *
     * WHY NOT THE MUTATION THE FINAL REVIEW SUGGESTED. It proposed adding
     * `'a document\'s clause'` to a string in `findings/read.ts` and
     * expected the literals after it to desynchronise. That was the Task 13
     * defect, and Task 13 FIXED it: `statementsIn` is escape-aware now
     * (`sourceScan.ts`), and splicing that line in leaves every statement
     * still visible — verified before this test was written. The blind spot
     * that genuinely remains is the one its own docstring names, a nested
     * template expression containing a backtick, and the pairing re-syncs
     * on the very next backtick, so a targeted fixture for it would be
     * asserting about an accident of that particular string. Losing the
     * statements outright is the honest stand-in: it asks the only question
     * this check exists to answer.
     */
    const code = codeOf(path.join(SCANNED, 'findings/read.ts'));
    const lossy = (text: string): string[] =>
      statementsIn(text).filter(st => !/\bfrom\s+finding\b/i.test(st));
    expect(lostClauses(code, statementsIn),
      'findings/read.ts already has statements the extractor cannot see').toEqual([]);
    expect(lostClauses(code, lossy).length,
      'the desync check cannot report a statement lost outside routes/').toBeGreaterThan(0);
  });
});

/**
 * Every scoped-table clause in `code` that `extract` does NOT see.
 *
 * The comparison the desync check is: clauses found in the RAW
 * comment-stripped source, which needs no quote pairing at all, against the
 * same clauses found in what the extractor returns. A statement the
 * extractor loses is a statement the scoping guard above is not looking at,
 * and its failure mode is silence — a smaller number nobody was counting.
 *
 * `extract` is a parameter so the sanity check can hand it an extractor that
 * loses on purpose. A comparison that has never been seen to report anything
 * is not evidence.
 */
function clausesIn(text: string): string[] {
  const clause = new RegExp(
    `\\b(?:from|into|update|join)\\s+(?:only\\s+)?"?(?:${SCOPED_TABLES.join('|')})"?\\b`, 'gi');
  const out: string[] = [];
  for (const m of text.matchAll(clause)) {
    // The clause plus what follows it, so two reads of the same table in one
    // file are distinguishable.
    out.push(text.slice(m.index, m.index + m[0].length + 24).replace(/\s+/g, ' '));
  }
  return out;
}

function lostClauses(code: string, extract: (text: string) => string[]): string[] {
  const seen = new Set(clausesIn(extract(code).join('\n')));
  return clausesIn(code).filter(found => !seen.has(found));
}

/**
 * The part of a statement where a workspace predicate has to APPEAR.
 *
 * Part 2A m5: this used to be "anywhere in the statement", which is a
 * substring test an upsert satisfies for free — every `insert … on conflict
 * … do update … where` in `routes/` names `workspace_id` in its INSERT
 * COLUMN LIST, so deleting `and review.workspace_id = $2` from the DO
 * UPDATE's `where` left the guard green. A guard that passes over the exact
 * mutation it exists to catch is decoration, and this one was: the
 * workspace predicate on a DO UPDATE is the load-bearing half, because that
 * is the clause deciding whether ANOTHER workspace's row gets overwritten.
 *
 * Three shapes, in the order they must be tested:
 *
 *  1. `… do update … where <pred>` — the predicate is what guards the
 *     UPDATE half of an upsert, and it is the only region that counts. The
 *     INSERT column list is not a filter.
 *  2. any other statement with a `where` — the predicate is the filter.
 *  3. a statement with NO `where` at all — an `insert … values` (or an
 *     `on conflict … do nothing`, which cannot touch a foreign row): here
 *     `workspace_id` in the column list IS the scoping, because the value
 *     being written is the actor's own, so the whole statement is the
 *     region.
 *
 * `returning` is trimmed off in every case: it names columns, not rows.
 */
function predicateRegion(statement: string): string {
  const trimmed = statement.replace(/\breturning\b[\s\S]*$/i, '');
  const upsert = /\bdo\s+update\b([\s\S]*)$/i.exec(trimmed);
  if (upsert) {
    const where = /\bwhere\b([\s\S]*)$/i.exec(upsert[1]);
    // A `do update` with NO `where` cannot be scoped at all — return the
    // empty string so it is reported rather than passed by its column list.
    return where ? where[1] : '';
  }
  const where = /\bwhere\b([\s\S]*)$/i.exec(trimmed);
  if (where) return where[1];
  return trimmed;
}

describe('every SQL statement in a route module names workspace_id', () => {
  it('has no statement against a scoped table without a workspace predicate', () => {
    const offenders: string[] = [];
    for (const file of walk(SCANNED)) {
      if (UNSCOPED_BY_DESIGN.includes(rel(file))) continue;
      for (const statement of statementsIn(codeOf(file))) {
        const table = namesScopedTable(statement);
        if (table === undefined) continue;
        if (SCOPED_BY_KEY.some(allowed => statement.includes(allowed))) continue;
        if (TRUNCATED_BY_INTERPOLATION.some(
          t => rel(file) === t.file && statement.includes(t.contains.split('${')[0]))) continue;
        if (!/workspace_id/.test(predicateRegion(statement))) {
          offenders.push(`${rel(file)} (${table}): ${statement.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every unscoped-by-design module still exists, and still issues SQL', () => {
    // A stale ruling is a ruling nobody re-reads. Each module named as
    // exempt has to still be there and still be a module this guard would
    // otherwise have something to say about — an entry that has stopped
    // applying is one that silently covers whatever moves under it next.
    for (const name of UNSCOPED_BY_DESIGN) {
      const full = path.join(ROOT, name);
      expect(existsSync(full), name).toBe(true);
      const statements = statementsIn(codeOf(full)).filter(s => namesScopedTable(s) !== undefined);
      expect(statements.length, `${name} issues no scoped-table SQL any more`)
        .toBeGreaterThan(0);
    }
  });

  it('every api source file is either scanned or named as unscoped by design', () => {
    // The list cannot be joined by accident. A new module under
    // `apps/api/src` is scanned unless somebody adds it above, and adding it
    // above is a decision with a reason beside it.
    const scanned = walk(SCANNED).map(rel);
    for (const name of UNSCOPED_BY_DESIGN) expect(scanned).toContain(name);
    expect(scanned.length).toBeGreaterThan(30);
  });

  it('the ENGINE writes a finding by its full key, workspace included', () => {
    /*
     * What the exemption above costs, paid back directly.
     *
     * The engine is not on a request path and has no requesting workspace to
     * scope to — but it still must not write one workspace's finding from
     * another's cell. It does not: `toFindingRow` builds the row from the
     * CELL's own `workspace_id`, and the update names all four key columns.
     *
     * Asserted against the raw source rather than through `statementsIn`,
     * because these two statements are exactly the ones that scanner cannot
     * read (see `TRUNCATED_BY_INTERPOLATION`). A statement a guard cannot
     * parse gets a different assertion, never a silence.
     */
    for (const { file, contains } of TRUNCATED_BY_INTERPOLATION) {
      const code = codeOf(path.join(ROOT, file));
      expect(code, `${file} no longer builds the statement this covers`).toContain(contains);
    }
    const worker = codeOf(path.join(ROOT, 'apps/api/src/run/worker.ts'));
    expect(worker).toMatch(
      /where review_id = \$1 and findings_key = \$2 and clause_id = \$3 and workspace_id = \$4/);
    // …and the row it writes is built from the CELL's workspace, not from
    // anything the model or the review body could influence.
    expect(worker).toMatch(/toFindingRow\(content, run\.review_id, cell\.findings_key, cell\.workspace_id\)/);
  });

  /**
   * Routes that reach the disposition service WITHOUT a per-finding check,
   * each with the predicate that scopes them instead.
   *
   * `GET /v1/reviews/:id/history` reads a whole review's events, so there is
   * no single finding key for `requireFinding` to prove ownership of. What
   * it does instead — refuse a review this workspace cannot see, and read
   * events through a function whose own WHERE clause names `workspace_id` —
   * is asserted here by text, so the exemption cannot cover anything else
   * the file does.
   */
  const SCOPES_ITSELF: Record<string, RegExp> = {
    'apps/api/src/routes/history.ts':
      /select playbook_snapshot from review where id = \$1 and workspace_id = \$2/,
  };

  it('every route reaching the disposition service checks the finding s workspace first', () => {
    /*
     * THE GATE THAT MAKES `SCOPED_BY_KEY` TRUE, asserted rather than
     * trusted. `dispositions/service.ts` identifies a row by
     * `(review_id, findings_key, clause_id)` with no workspace predicate,
     * which is safe only because every caller has already proved that key
     * belongs to this workspace.
     */
    const importers = walk(ROUTES_DIR)
      .filter(f => /from '\.\.\/dispositions\/service\.ts'/.test(codeOf(f)));
    expect(importers.length, 'no route imports the disposition service').toBeGreaterThan(0);
    for (const file of importers) {
      const code = codeOf(file);
      const scopesItself = SCOPES_ITSELF[rel(file)];
      if (scopesItself) {
        // NAMED, per file, with its OWN assertion — never a relaxed pattern
        // (CLAUDE.md: a file-level exemption hides everything in the file,
        // not just the part you meant to protect). This route reaches the
        // service through a function that carries `workspace_id` in its own
        // predicate rather than one keyed by `(review, findingsKey,
        // clauseId)`, so `requireFinding` has nothing to check — but the
        // scoping still has to be somewhere, and this says where.
        expect(code, `${rel(file)} no longer scopes its own read`).toMatch(scopesItself);
        // eslint-disable-next-line no-continue
        continue;
      }
      expect(code, `${rel(file)} reaches the disposition service unchecked`)
        .toMatch(/requireFinding\(|cellsFor\(/);
    }
    // …and the self-scoping function really does scope itself. Drop
    // `workspace_id = $2` from `readReviewDispositionEvents` and this goes
    // red, which is the half a per-file exemption would otherwise hide.
    expect(codeOf(path.join(ROOT, 'apps/api/src/dispositions/service.ts')))
      .toMatch(/where review_id = \$1 and workspace_id = \$2/);
    // …and the check itself names the workspace, which is the whole of it.
    expect(codeOf(path.join(ROUTES_DIR, 'findings.ts')))
      .toMatch(/where review_id = \$1 and findings_key = \$2 and clause_id = \$3 and workspace_id = \$4/);
  });

  it('reads the DO UPDATE s own where clause, not the INSERT column list', () => {
    // THE MUTATION THIS GUARD MISSED. Both statements below name
    // `workspace_id` in the column list; only one names it where it decides
    // whose row is overwritten.
    const guarded = 'insert into review (id, workspace_id, findings) values ($1, $2, $3)'
      + ' on conflict (id) do update set findings = excluded.findings'
      + ' where review.workspace_id = $2 and review.version = $4 returning *';
    const unguarded = 'insert into review (id, workspace_id, findings) values ($1, $2, $3)'
      + ' on conflict (id) do update set findings = excluded.findings'
      + ' where review.version = $4 returning *';
    expect(/workspace_id/.test(predicateRegion(guarded))).toBe(true);
    expect(/workspace_id/.test(predicateRegion(unguarded))).toBe(false);
    // …and the old test — `workspace_id` anywhere in the literal — cannot
    // tell them apart at all, which is why it was green over the defect.
    expect(/workspace_id/.test(unguarded)).toBe(true);
  });

  it('still accepts a plain insert, whose column list IS the scoping', () => {
    expect(/workspace_id/.test(predicateRegion(
      'insert into matter (id, workspace_id, name) values ($1, $2, $3)'))).toBe(true);
  });

  it('reads a plain where clause, and reports one that filters on id alone', () => {
    expect(/workspace_id/.test(predicateRegion(
      'select * from review where id = $1 and workspace_id = $2'))).toBe(true);
    expect(/workspace_id/.test(predicateRegion(
      'select * from review where id = $1'))).toBe(false);
    // `returning` names columns, not rows: a `workspace_id` there is not a
    // filter and must not satisfy the check.
    expect(/workspace_id/.test(predicateRegion(
      'delete from document where id = $1 returning workspace_id'))).toBe(false);
  });
});

/**
 * Every statement reading `document` in a MATTER context also names `kind`.
 *
 * §19 names this as the thing to watch when precedent documents arrive:
 * *"a query that forgets the kind predicate … fails by showing TOO MUCH
 * rather than too little, and nothing on screen would look wrong."* What it
 * shows is another client's papers inside a matter, which is the same shape
 * as the `workspace_id` guard above one step less serious.
 *
 * Scoped to statements that already name `matter_id`, deliberately. The
 * queries that must NOT carry a `kind` predicate are real and there are two
 * of them: `orphanKeys` (a precedent's bytes are claimed too, and filtering
 * them out would offer every precedent blob up for deletion) and the
 * id-collision checks on the upload path (`document.id` is a global primary
 * key, so an id held by a precedent is taken for a matter document as well).
 * Neither names `matter_id`, and neither should — so the predicate this
 * scanner requires is exactly the one a matter context needs.
 */
describe('every statement reading `document` in a matter context also names kind', () => {
  it('has no matter-context document statement without a kind predicate', () => {
    const offenders: string[] = [];
    for (const file of walk(ROUTES_DIR)) {
      for (const statement of statementsIn(codeOf(file))) {
        if (!/\bfrom document\b|\bjoin document\b|\bupdate document\b|\binto document\b/i.test(statement)) continue;
        if (!/matter_id/.test(statement)) continue;
        if (!/\bkind\b/.test(statement)) offenders.push(`${rel(file)}: ${statement.slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('finds matter-context document statements at all (or the check above is decoration)', () => {
    // A guard whose filter matches nothing passes vacuously — the failure
    // mode the `workspace_id` scanner's own sanity check exists for, and
    // this one narrows on two conditions rather than one, so it has twice
    // as many ways to match nothing.
    const matched = walk(ROUTES_DIR)
      .flatMap(f => statementsIn(codeOf(f)))
      .filter(s => /\bfrom document\b|\bjoin document\b|\bupdate document\b|\binto document\b/i.test(s))
      .filter(s => /matter_id/.test(s));
    expect(matched.length).toBeGreaterThan(3);
    expect(statementsIn(codeOf(path.join(ROUTES_DIR, 'documents.ts'))).length).toBeGreaterThan(3);
  });

  it('recognises a statement missing the predicate, and one carrying it', () => {
    // The mutation, spelled out: the same query with and without the clause.
    const guarded = "select * from document where matter_id = $1 and workspace_id = $2 and kind = 'matter'";
    const unguarded = 'select * from document where matter_id = $1 and workspace_id = $2';
    const names = (s: string) => /\bfrom document\b/i.test(s) && /matter_id/.test(s) && /\bkind\b/.test(s);
    expect(names(guarded)).toBe(true);
    expect(names(unguarded)).toBe(false);
  });
});
