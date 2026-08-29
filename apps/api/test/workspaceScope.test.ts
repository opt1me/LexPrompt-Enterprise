import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ROOT, walk, rel, codeOf } from './sourceScan.ts';

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
 */
function statementsIn(code: string): string[] {
  const literals = code.match(/`[^`]*`|'[^']*'|"[^"]*"/g) ?? [];
  return literals
    .map(l => l.slice(1, -1))
    .flatMap(l => l.split(';'))
    .map(s => s.trim())
    .filter(Boolean);
}

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
});

describe('every SQL statement in a route module names workspace_id', () => {
  it('has no statement against a scoped table without a workspace predicate', () => {
    const offenders: string[] = [];
    for (const file of walk(ROUTES_DIR)) {
      for (const statement of statementsIn(codeOf(file))) {
        const table = namesScopedTable(statement);
        if (table === undefined) continue;
        if (!/workspace_id/.test(statement)) {
          offenders.push(`${rel(file)} (${table}): ${statement.slice(0, 80)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
