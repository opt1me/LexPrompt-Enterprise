import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ROOT, walk, rel, codeOf, statementsIn } from './sourceScan.ts';

/**
 * WHO MAY WRITE A LAWYER'S JUDGEMENT, asserted over the source.
 *
 * The real defence is the grant: `lexprompt_worker` holds nothing at all on
 * `finding_disposition` or `finding_disposition_event`, proved by attempting
 * every verb as the role in `workerGrants.pg.test.ts` and
 * `humanStateSurvives.pg.test.ts`. This guard is the cheaper one that bites
 * EARLIER — at `npm test`, in a pull request, rather than as a permission
 * error in front of a reviewer — and it says something the grant cannot: that
 * within the role which IS allowed to write, there is one module doing it.
 *
 * ## Why one module matters when the grant already exists
 *
 * `finding_disposition` is a cache of `finding_disposition_event`, and the
 * two must move together or the history stops being evidence. A second
 * module writing the cache without the event, or the event without bumping
 * `changed_count`, would be a disposition with no record of having been
 * made — §6.3's whole point, and the exact shape `setDisposition`'s
 * mutation test covers. The grant cannot tell those apart; a reader of the
 * source can, once there is only one place to read.
 *
 * ## Two writers, not one, and the second is named rather than exempted
 *
 * The plan's sentence is *"the only writers of either table in the
 * codebase"* about `dispositions/service.ts`. The shipped source has two,
 * and the second is legitimate: `findings/backfill.ts` is 007's shred,
 * which seeds a disposition and its first event for every finding it lands
 * from the frozen blob. It runs once, as a migration, on the migrator's
 * connection, before any request exists — it cannot call the service
 * because the service refuses a disposition that does not exist yet, which
 * is precisely what a backfill is creating.
 *
 * `findings/import.ts` is deliberately NOT on this list, and that is the
 * property this file is really guarding: the uploader's import writes
 * judgements too, and it goes through `ensureDisposition`/`setDisposition`
 * rather than issuing its own SQL. A version of it that wrote the rows
 * directly would land dispositions with no history behind them, and this
 * test is what would say so.
 */

const SRC = path.join(ROOT, 'apps/api/src');

/** Modules issuing a statement that WRITES `table` — insert, update or
 *  delete. A `select` is not a write and is not what this is about. */
function writersOf(table: RegExp): string[] {
  const writes = new RegExp(
    `\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:only\\s+)?"?${table.source}"?`, 'i');
  const out = new Set<string>();
  for (const file of walk(SRC)) {
    for (const statement of statementsIn(codeOf(file))) {
      if (writes.test(statement)) out.add(rel(file));
    }
  }
  return [...out].sort();
}

describe('the disposition tables have exactly the writers this design names', () => {
  it('finds the files it is about to make a claim over', () => {
    // THE SANITY CHECK. A scanner that walked an empty directory would
    // report `[]` for every table below and pass — which is how a guard in
    // this stage came to report zero violations repo-wide.
    const files = walk(SRC).map(rel);
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain('apps/api/src/dispositions/service.ts');
    expect(files).toContain('apps/api/src/findings/backfill.ts');
    expect(files).toContain('apps/api/src/findings/import.ts');
  });

  it('recognises a write and does not mistake a read for one', () => {
    // The matcher, exercised on both answers. Without this the assertions
    // below could be passing because `writesOf` never matches anything.
    const write = (statement: string): boolean => {
      const re = /\b(?:insert\s+into|update|delete\s+from)\s+(?:only\s+)?"?finding_disposition"?/i;
      return re.test(statement);
    };
    expect(write("update finding_disposition set state = 'verified'")).toBe(true);
    expect(write('insert into finding_disposition (review_id) values ($1)')).toBe(true);
    expect(write('delete from finding_disposition where review_id = $1')).toBe(true);
    expect(write('select state from finding_disposition where review_id = $1')).toBe(false);
  });

  it('has one service and one migration writing finding_disposition, and nothing else', () => {
    expect(writersOf(/finding_disposition(?!_event)/)).toEqual([
      'apps/api/src/dispositions/service.ts',
      'apps/api/src/findings/backfill.ts',
    ]);
  });

  it('has the same two writing its history, and no third', () => {
    expect(writersOf(/finding_disposition_event/)).toEqual([
      'apps/api/src/dispositions/service.ts',
      'apps/api/src/findings/backfill.ts',
    ]);
  });

  it('has one module writing a note, plus the migration that created them', () => {
    // A note is a person's remark and is added or withdrawn, never edited:
    // the `note` table holds no UPDATE grant for anybody. The writers are
    // the route a person types into, the import that moves an exported
    // review's notes in, and the shred that created them from the blob.
    expect(writersOf(/note/)).toEqual([
      'apps/api/src/findings/backfill.ts',
      'apps/api/src/findings/import.ts',
      'apps/api/src/routes/findings.ts',
    ]);
  });

  it('the import writes its judgements THROUGH the service, not around it', () => {
    /*
     * The property the list above exists for. `findings/import.ts` lands a
     * whole exported review's findings — including verifications, rejection
     * reasons and notes — and it is the one place left that receives a
     * findings map. If it wrote `finding_disposition` itself it would
     * produce dispositions with no history behind them, which is a
     * judgement with no record of having been made.
     */
    const code = codeOf(path.join(SRC, 'findings/import.ts'));
    expect(code).toContain("from '../dispositions/service.ts'");
    expect(code).toContain('ensureDisposition');
    expect(code).toContain('setDisposition');
    expect(code).not.toMatch(/insert\s+into\s+finding_disposition/i);
    expect(code).not.toMatch(/update\s+finding_disposition/i);
    // …and it still writes findings, so the two absences above are about
    // the disposition rather than about a module that does nothing.
    expect(code).toMatch(/insert into finding \(/);
  });

  it('the engine writes neither, in the source as well as by grant', () => {
    // The belt to the grant's braces, and the one that says so at `npm
    // test` rather than as a permission error in front of a reviewer.
    for (const file of ['run/worker.ts', 'run/queue.ts', 'run/reaper.ts', 'run/lifecycle.ts']) {
      const code = codeOf(path.join(SRC, file));
      expect(code, `${file} writes a disposition`)
        .not.toMatch(/\b(?:insert\s+into|update|delete\s+from)\s+finding_disposition/i);
    }
    // `run/queue.ts` DOES clear a disposition on a re-run — through
    // `setDisposition` with cause `rerun_reset`, which is the one write the
    // system performs on its own behalf and the reason it can only ever
    // move a disposition to `unchecked`. Asserted, so the four absences
    // above cannot be read as "the engine never touches a judgement".
    const queue = codeOf(path.join(SRC, 'run/queue.ts'));
    expect(queue).toContain('setDisposition');
    expect(queue).toContain("'rerun_reset'");
  });
});
