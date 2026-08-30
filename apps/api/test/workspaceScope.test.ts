import { describe, it, expect } from 'vitest';
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
 * `app_user` is deliberately NOT here even though it carries the column: a
 * request never looks a user up by anything but the identity the
 * authentication hook already resolved — `(issuer, subject)`, which is
 * unique across the whole table — so the row is reached through the actor
 * rather than searched for within a workspace. `workspace` and
 * `role_mapping` are absent for the same kind of reason (`role_mapping`'s
 * own docstring in `roles.ts` says why a workspace filter there could only
 * ever remove a row the lookup should have seen).
 */
const SCOPED_TABLES = [
  'matter', 'document', 'collection', 'playbook', 'playbook_version', 'review', 'changeset',
  'precedent_set', 'position_basis',
  // 008's three (Stage 3 Task 8). `run` and `run_cell` carry a workspace and
  // are reached by id from a URL, which is exactly the shape this guard is
  // about: `GET /v1/runs/<someone else's run>` finds the row, renders the
  // page and tells a reader how another firm's review is going. `event` is
  // the same one layer down — its payloads name findings by key.
  'run', 'run_cell', 'event',
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

const ROUTES_DIR = path.join(ROOT, 'apps/api/src/routes');

describe('the scanner finds something (a guard that matches nothing passes vacuously)', () => {
  it('walks the route modules and finds statements against scoped tables', () => {
    const files = walk(ROUTES_DIR);
    expect(files.length).toBeGreaterThan(0);
    const scoped = files
      .flatMap(f => statementsIn(codeOf(f)))
      .filter(s => namesScopedTable(s) !== undefined);
    expect(scoped.length).toBeGreaterThanOrEqual(4);
  });

  it('recognises a statement that names a scoped table, and one that does not', () => {
    expect(namesScopedTable('select * from matter where id = $1')).toBe('matter');
    expect(namesScopedTable('insert into review (id) values ($1)')).toBe('review');
    expect(namesScopedTable('delete from document where id = $1')).toBe('document');
    expect(namesScopedTable('select * from playbook_version where id = $1'))
      .toBe('playbook_version');
    expect(namesScopedTable('update app_user set display_name = $2')).toBeUndefined();
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
     */
    const clause = () => new RegExp(
      `\\b(?:from|into|update|join)\\s+(?:only\\s+)?"?(?:${SCOPED_TABLES.join('|')})"?\\b`, 'gi');
    const occurrences = (text: string): string[] => {
      const out: string[] = [];
      for (const m of text.matchAll(clause())) {
        // The clause plus what follows it, so two reads of the same table in
        // one file are distinguishable.
        out.push(text.slice(m.index, m.index + m[0].length + 24).replace(/\s+/g, ' '));
      }
      return out;
    };
    const invisible: string[] = [];
    for (const file of walk(ROUTES_DIR)) {
      const code = codeOf(file);
      const seen = new Set(occurrences(statementsIn(code).join('\n')));
      for (const found of occurrences(code)) {
        if (!seen.has(found)) invisible.push(`${rel(file)}: ${found}`);
      }
    }
    expect(invisible).toEqual([]);
    // …and the comparison is not vacuous: the source really does contain
    // clauses against scoped tables.
    const all = walk(ROUTES_DIR).flatMap(f => occurrences(codeOf(f)));
    expect(all.length).toBeGreaterThan(40);
  });
});

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
    for (const file of walk(ROUTES_DIR)) {
      for (const statement of statementsIn(codeOf(file))) {
        const table = namesScopedTable(statement);
        if (table === undefined) continue;
        if (!/workspace_id/.test(predicateRegion(statement))) {
          offenders.push(`${rel(file)} (${table}): ${statement.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
