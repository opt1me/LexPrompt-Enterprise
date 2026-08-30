import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, workerDb, withPg } from './helpers/pgHarness.ts';
import type { Db, Tx } from '../src/db/pool.ts';
import { seedFindingRows } from './helpers/seedFindings.ts';
import { describeDiscrepancies, reconcileFindings } from '../src/findings/reconcile.ts';

/**
 * The two Part 3A gate claims that can only be made against a real database,
 * and that no other suite makes.
 *
 * This file deliberately does NOT restate what `dispositions.pg.test.ts`,
 * `workerGrants.pg.test.ts` and `shadowWrite.pg.test.ts` already prove
 * against the same Postgres. Two suites making the same claim is this
 * project's most repeated failure, and the weaker copy is always the one
 * that stays green when the property breaks. What is here is what those
 * three cannot check about themselves:
 *
 *  1. **Their refusals are about the GRANT and not about a typo.** Every
 *     statement `dispositions.pg.test.ts` attempts as the worker role is
 *     `prepare`d as the schema owner first, so a misspelled column can no
 *     longer masquerade as a permission denial. This is not hypothetical:
 *     writing THIS gate produced exactly that failure — three statements
 *     spelling `finding_disposition_event.state` (the real columns are
 *     `from_state`/`to_state`) came back "refused" with a column error,
 *     read as proof, and would have passed identically against a worker
 *     holding every grant on the table.
 *
 *  2. **The rows and the blob agree for every review IN THE DATABASE.**
 *     `shadowWrite.pg.test.ts` reconciles the reviews it creates.
 *     §18/P17's actual claim is stronger and is about the corpus: *"the rows
 *     and the blob agree for every finding in the database, checked"*. The
 *     sweep below is that claim, and it asserts it saw something, because a
 *     sweep over an empty table passes vacuously — which is precisely what
 *     it did on the running stack the first time it was tried.
 */

const WS = '00000000-0000-0000-0000-000000000001';

/**
 * Every statement the run worker's role must be refused, spelled with the
 * REAL column names of `006_dispositions.sql`.
 *
 * A `$1`-style parameter would need values to `prepare`, so the literals are
 * inline. They are never executed as anything but a refusal.
 */
const DISPOSITION_STATEMENTS = [
  'select state, reason, by_user_id from finding_disposition',
  `insert into finding_disposition (review_id, findings_key, clause_id, workspace_id, state,
                                    by_user_id, at, changed_count)
   values ('x', 'd', 'c', '${WS}', 'verified', '00000000-0000-0000-0000-0000000000aa', now(), 1)`,
  "update finding_disposition set state = 'verified'",
  'delete from finding_disposition',
  'select from_state, to_state, cause, by_user_id from finding_disposition_event',
  `insert into finding_disposition_event (review_id, findings_key, clause_id, workspace_id,
                                          from_state, to_state, reason, cause, by_user_id, at)
   values ('x', 'd', 'c', '${WS}', 'unchecked', 'verified', null, 'human',
           '00000000-0000-0000-0000-0000000000aa', now())`,
  "update finding_disposition_event set to_state = 'verified'",
  'delete from finding_disposition_event',
];

describe('the worker role has no path to a disposition, and the refusals are about the grant', () => {
  it('is refused every one of them, as the role the engine really runs as', async () => {
    // Attempted, not read out of the migration. A grant is a fact about a
    // running database; a migration is a claim about one.
    const worker: Db = workerDb();
    for (const sql of DISPOSITION_STATEMENTS) {
      await expect(worker.query(sql), sql.split('\n')[0]).rejects.toThrow(/permission denied/i);
    }
    expect(DISPOSITION_STATEMENTS).toHaveLength(8);
  });

  it('…and every one of them is a WELL-FORMED statement, so none is refused for a typo', async () => {
    /*
     * The guard on the guard. `prepare` parses, resolves every name and
     * plans, without executing — so a misspelled column raises `42703` and a
     * misspelled table `42P01`, while a correct statement succeeds and
     * touches nothing. Run as the schema owner, inside a transaction that is
     * rolled back, so the prepared statements go with it.
     *
     * Without this, the test above passes against a database where the two
     * tables have been renamed out from under it, and against a worker role
     * holding every grant there is.
     */
    await withPg(async (t: Tx) => {
      let n = 0;
      for (const sql of DISPOSITION_STATEMENTS) {
        await expect(t.query(`prepare dod_gate_${n} as ${sql}`), sql.split('\n')[0])
          .resolves.toBeDefined();
        n += 1;
      }
      expect(n).toBe(8);
      // …and the check bites: a column that does not exist is not silently
      // planned. This is the exact mistake the file's own note describes.
      await expect(t.query("prepare dod_gate_bad as select state from finding_disposition_event"))
        .rejects.toThrow(/does not exist/i);
    }, migratorDb());
  });

  it('cannot reach the blob either — the worker may read a review and never write one', async () => {
    /*
     * `review.findings` is the browser's for the whole of Part 3A, and the
     * engine writes findings as ROWS. A worker that could update the review
     * row could overwrite the blob wholesale, which in Part 3A means
     * overwriting every verification in it — the one thing this stage's six
     * mechanisms exist to prevent.
     *
     * P18's `revoke update (findings)` is Task 22 and is about the APP role;
     * this is the worker, and it is already total.
     */
    const worker: Db = workerDb();
    await expect(worker.query("update review set findings = '{}'::jsonb where id = 'nope'"))
      .rejects.toThrow(/permission denied/i);
    await expect(worker.query("delete from review where id = 'nope'"))
      .rejects.toThrow(/permission denied/i);
    // Paired: it CAN read one, which is what makes the refusals about the
    // verb rather than about a table it cannot see at all.
    await expect(worker.query('select id, findings from review limit 1')).resolves.toBeDefined();
  });
});

/* ------------------------------------------------------------------ */

const REVIEW = 'dod3a-review';
const MATTER = 'dod3a-matter';

const TARGET = { kind: 'documents', documentIds: ['d1'] } as const;

function bodyFor(me: string, other: string): Record<string, unknown> {
  return {
    d1: {
      c1: {
        clauseId: 'c1', status: 'done', summary: 'The deposit is capped at five weeks.',
        citations: [],
        verification: { state: 'verified', byUserId: me, at: 1_780_000_000_000 },
        notes: [{ id: 'dod3a-n1', findingId: 'd1::c1', text: 'Checked against the schedule.',
          byUserId: me, at: 1_780_000_000_100 }],
      },
      c2: {
        clauseId: 'c2', status: 'done', summary: 'The break is mutual.', citations: [],
        verification: {
          state: 'rejected', reason: 'The model read the wrong schedule.',
          byUserId: other, at: 1_780_000_000_200,
        },
        notes: [],
      },
      c3: {
        clauseId: 'c3', status: 'done', summary: 'The agreement is silent on this point.',
        citations: [], verification: { state: 'unchecked' }, notes: [],
      },
    },
  };
}

/** Seeds a review with human state ON THE MIGRATOR CONNECTION and COMMITS
 *  it, because the sweep below reads every review the database has and a
 *  row inside an open transaction is not one of them. Always removed. */
async function withACommittedReview(
  body: (ids: { me: string; other: string }) => Promise<void>,
): Promise<void> {
  const mig = migratorDb();
  const cleanup = async (): Promise<void> => {
    await mig.query('delete from review where id = $1', [REVIEW]);
    await mig.query('delete from matter where id = $1', [MATTER]);
    await mig.query("delete from app_user where display_name in ('DoD Gate A', 'DoD Gate B')");
  };
  await cleanup();
  const users = await mig.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'DoD Gate A', 'GA',
             'reviewer', 'active'),
            (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'DoD Gate B', 'GB',
             'partner', 'active')
     returning id::text as id`, [WS]);
  const [me, other] = users.map(u => u.id);
  try {
    await mig.query(
      `insert into matter (id, workspace_id, name, created_at, updated_at)
       values ($1, $2, 'DoD 3A', now(), now())`, [MATTER, WS]);
    await appDb().tx(async t => {
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, findings,
                             model_id, started_at, created_by_user_id)
         values ($1, $2, $3, '{}'::jsonb, $4::jsonb, $5::jsonb, 'm', now(), $6)`,
        [REVIEW, WS, MATTER, JSON.stringify(TARGET), JSON.stringify(bodyFor(me, other)), me]);
      // `importFindings`, NOT THE SHADOW WRITER. `writeFindingRows` is gone
      // with the blob write it shadowed (Task 22). This is the surviving
      // path from a whole findings map to rows — the one the uploader uses
      // to move an exported review — and it is the honest fixture for a
      // review that carries a blob AND rows, which is the pre-freeze shape
      // this sweep is about.
      //
      // TWO PEOPLE, THEREFORE TWO IMPORTS. `importFindings` records the
      // signed-in person's own judgements and nobody else's, so a review
      // carrying a partner's verification AND a trainee's is a thing the
      // product can only produce as two signed-in imports.
      // `seedFindingRows` does that partition; it THROWS on a cell that
      // names two people, which no request could ever produce.
      await seedFindingRows(t, REVIEW, WS, TARGET, bodyFor(me, other), me);
    });
    await body({ me, other });
  } finally {
    await cleanup();
  }
}

describe('the rows and the blob agree for EVERY review in the database (P17)', () => {
  it('reconciles every review there is, and says how many it looked at', async () => {
    await withACommittedReview(async () => {
      const ids = (await migratorDb().query<{ id: string }>('select id from review order by id'))
        .map(r => r.id);
      // NOT VACUOUS. A sweep over an empty `review` table returns no
      // discrepancies and proves nothing, and on the running stack that is
      // exactly the state it found the first time it was run. The review
      // this test planted must be among them.
      expect(ids, 'the sweep saw no reviews at all').toContain(REVIEW);

      const bad: string[] = [];
      for (const id of ids) {
        const found = await appDb().tx(t => reconcileFindings(t, id));
        if (found.length > 0) bad.push(`${id}:\n${describeDiscrepancies(found)}`);
      }
      expect(bad.join('\n')).toBe('');

      // …and the sweep really did compare rows rather than nothing: the
      // planted review has findings, a disposition each and a note.
      const counts = await migratorDb().query<{ f: string; d: string; n: string }>(
        `select (select count(*) from finding where review_id = $1)::text f,
                (select count(*) from finding_disposition where review_id = $1)::text d,
                (select count(*) from note where review_id = $1)::text n`, [REVIEW]);
      expect(counts[0]).toEqual({ f: '3', d: '3', n: '1' });
    });
  });

  it('leaves review.findings byte-identical, and now by GRANT rather than by care', async () => {
    /*
     * "The blob is unmodified." Part 3A proved this by observing that the
     * shadow writer did not touch it; TASK 22 MAKES IT UNTOUCHABLE.
     * Migration 010 converted `lexprompt_app`'s table-level UPDATE on
     * `review` into a column list that does not name `findings`, so the
     * question is no longer whether some code path happens to write it.
     *
     * `version` is asserted alongside the checksum because the review row's
     * optimistic-concurrency token is what a browser holds: a write that
     * bumped it would make the next save from a live tab fail as stale,
     * mid-run, with no user-visible cause.
     *
     * `frozenBlob.pg.test.ts` carries the freeze's own suite - the grant, the
     * refusal, the route's 400. What is here is the corpus claim this file
     * exists for, over a committed review with real human state in it.
     */
    await withACommittedReview(async () => {
      const read = async () => (await migratorDb().query<{ md5: string; v: string }>(
        'select md5(findings::text) md5, version::text v from review where id = $1',
        [REVIEW]))[0];
      const before = await read();
      expect(before.md5).toMatch(/^[0-9a-f]{32}$/);

      // Attempted as the role a request runs as, and REFUSED. Paired with a
      // column the same role may write, so a `review` table that did not
      // exist could not produce a refusal of the right shape.
      await expect(appDb().query(
        "update review set findings = '{}'::jsonb where id = $1", [REVIEW]))
        .rejects.toThrow(/permission denied/i);
      await expect(appDb().query(
        'update review set model_id = model_id where id = $1', [REVIEW]))
        .resolves.toBeDefined();

      expect(await read()).toEqual(before);
    });
  });
});
