import { beforeAll } from 'vitest';
import { Pool } from 'pg';

/**
 * THESE SUITES REQUIRE THE APPLICATION TABLES TO BE EMPTY, AND UNTIL NOW
 * NOTHING SAID SO.
 *
 * `withPg` rolls every test's own writes back, which is what lets 49 files
 * share one database with no truncate between them. What it never addressed
 * is data that was ALREADY COMMITTED when the suite started, and a large part
 * of the suite is sensitive to it in two different ways:
 *
 *  - assertions that read a table with no predicate — "no event was written"
 *    expressed as `select 1 from finding_disposition_event` — which is really
 *    a claim about the whole deployment. Those have been scoped to the
 *    review each test creates, which is both correct and stronger.
 *  - `backfillFindings` and the census/reconciliation over it, whose SUBJECT
 *    is every review in the database. Those cannot be scoped: the function
 *    under test is global, so the test genuinely needs to be the only thing
 *    in there.
 *
 * The second class is why this file exists. The precondition is real and
 * load-bearing, so it is CHECKED — loudly, once, with the remedy — instead of
 * being left to hold by luck.
 *
 * ## How it was found
 *
 * By following this repo's own README: bring the stack up, use the app, run
 * the tests. One review created in a browser turned 52 tests red with
 * assertion failures that pointed at the code under test and said nothing
 * about the real cause. A developer's first day should not begin with that.
 *
 * It is also the shape §14 warns about from the other side. A suite that
 * passes only because nobody has used the application is green for a reason
 * unconnected to the code — the same "a green suite is not evidence" this
 * project keeps relearning.
 */

/** The tables the suite's global assertions and the backfill's own scope
 *  depend on. Deliberately NOT every table: `app_user`, `audit_event` and
 *  `event` accumulate across runs and nothing here reads them globally, so
 *  demanding they be empty would fail for a reason that is not a problem. */
const MUST_BE_EMPTY = [
  'review', 'document', 'matter',
  'finding', 'finding_disposition', 'finding_disposition_event', 'note',
] as const;

let checked = false;

beforeAll(async () => {
  if (checked) return;
  checked = true;
  const url = process.env.LEXPROMPT_TEST_DATABASE_URL;
  // Absent is `pgHarness`'s failure to report, with its own remedy. Saying it
  // twice, differently, would send a reader to the wrong fix.
  if (!url) return;
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const counts: string[] = [];
    for (const table of MUST_BE_EMPTY) {
      const { rows } = await pool.query<{ n: string }>(`select count(*)::text n from ${table}`);
      const n = Number(rows[0].n);
      if (n > 0) counts.push(`${table}: ${n}`);
    }
    if (counts.length > 0) {
      throw new Error(
        'These suites need the application tables EMPTY, and this database has rows in:\n'
        + `  ${counts.join('\n  ')}\n\n`
        + 'That is almost certainly real data from using the app against the same stack — '
        + 'which the README tells you to do, so this is not your mistake. It is checked here '
        + 'because the alternative is dozens of assertion failures that point at the code '
        + 'under test and say nothing about the cause.\n\n'
        + 'Why it matters: `backfillFindings` and its census migrate EVERY review in the '
        + 'database, so a review that is not the test\'s own changes what the function does. '
        + 'That one cannot be scoped away.\n\n'
        + 'To fix: `npm run compose:down && npm run compose:up` resets the volumes '
        + '(you will sign in again), or delete the matters you created from the app first.',
      );
    }
  } finally {
    await pool.end();
  }
}, 30_000);
