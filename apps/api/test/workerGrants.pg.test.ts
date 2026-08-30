import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, workerDb, withPg } from './helpers/pgHarness.ts';
import type { Db, Tx } from '../src/db/pool.ts';

/**
 * What the run worker's role can and cannot do, proved by attempting it.
 *
 * §14: the grant is the guarantee, not the behaviour. The obvious
 * behavioural test — "a mid-run verification survives fifteen later cells" —
 * passes with or without the worker holding a write grant on a disposition,
 * because a worker that never writes one and a worker that cannot write one
 * are indistinguishable until the day somebody writes the line. That is a
 * test which cannot fail, identified before it was written, so this suite
 * asks the database instead.
 *
 * Every refusal here is paired with the same statement succeeding as another
 * role. Without that pairing a table that did not exist, or a typo in a
 * column name, would produce failures of roughly the right shape and the
 * suite would prove nothing — which is exactly how one of Stage 2's grant
 * tests came to prove nothing.
 */

const WS = '00000000-0000-0000-0000-000000000001';

/** Seeds a review, a finding and a user on the MIGRATOR connection and
 *  COMMITS them, because the worker's own connection is a different session
 *  and cannot see another session's open transaction. Cleaned up by the
 *  caller's `finally`. */
async function seed(db: Db, suffix: string): Promise<{ userId: string }> {
  await db.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ($1, $2, 'Grants', now(), now())`, [`wg-m-${suffix}`, WS]);
  await db.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, model_id, started_at)
     values ($1, $2, $3, '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb, 'm', now())`,
    [`wg-r-${suffix}`, WS, `wg-m-${suffix}`]);
  await db.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     values ($1, 'd1', 'c1', $2, 'done')`, [`wg-r-${suffix}`, WS]);
  const rows = await db.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, 'A B', 'AB', 'reviewer', 'active')
     returning id`, [WS]);
  return { userId: rows[0].id };
}

async function cleanup(db: Db, suffix: string): Promise<void> {
  await db.query('delete from review where id = $1', [`wg-r-${suffix}`]);
  await db.query('delete from matter where id = $1', [`wg-m-${suffix}`]);
}

/** Seeds committed rows, runs `body`, and always removes them. */
async function withSeed(
  suffix: string,
  body: (seeded: { userId: string }) => Promise<void>,
): Promise<void> {
  const db = migratorDb();
  await cleanup(db, suffix);
  const seeded = await seed(db, suffix);
  try {
    await body(seeded);
  } finally {
    await cleanup(db, suffix);
  }
}

describe('the run worker can write what a model produced', () => {
  it('lets the worker role update a finding', async () => {
    await withSeed('upd', async () => {
      await expect(workerDb().query(
        "update finding set summary = $1 where review_id = 'wg-r-upd' and clause_id = 'c1'",
        ['The model answered.'])).resolves.toBeDefined();
      const rows = await migratorDb().query<{ summary: string }>(
        "select summary from finding where review_id = 'wg-r-upd'");
      expect(rows[0].summary).toBe('The model answered.');
    });
  });

  it('lets the worker role insert a finding', async () => {
    await withSeed('ins', async () => {
      await expect(workerDb().query(
        `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
         values ('wg-r-ins', 'd1', 'c2', $1, 'running')`, [WS])).resolves.toBeDefined();
    });
  });

  it('lets the worker role read the review and the document it is working on', async () => {
    await withSeed('read', async () => {
      await expect(workerDb().query('select id from review where id = $1', ['wg-r-read']))
        .resolves.toHaveLength(1);
      await expect(workerDb().query('select count(*) from document')).resolves.toBeDefined();
      await expect(workerDb().query('select count(*) from playbook_version')).resolves.toBeDefined();
      await expect(workerDb().query('select count(*) from workspace_setting')).resolves.toBeDefined();
    });
  });
});

/**
 * THE ONE PAIR OF TABLES THIS WHOLE FILE EXISTS FOR, and until Part 3A's
 * review nobody attempted them.
 *
 * `grep finding_disposition` over this file came back EMPTY. It opened with
 * "§14: the grant is the guarantee", `pgHarness.workerDb`'s docstring said
 * this suite proves the worker cannot "read or write a disposition", and
 * `runWorker.pg.test.ts:530` named it as one of a three-legged proof — and
 * the leg about dispositions did not exist. What was tested was notes,
 * `delete on finding`, `app_user.email`, `delete on event` and three
 * document columns: every neighbour of the thing, and not the thing.
 *
 * The mutation that used to leave every suite in this repository green:
 * `grant select, insert, update on finding_disposition to lexprompt_worker;`
 * applied to a live database outside the migrations. `caps.test.ts` scans
 * MIGRATION TEXT and cannot see a grant applied from `infra/postgres`, an
 * Azure deployment step, or a DBA — and 006's own comment says the explicit
 * REVOKE exists precisely because a future blanket grant "would silently
 * undo it", which a text scan cannot see either. This asks the database.
 *
 * SELECT is refused too, and that is 006's ruling rather than an
 * over-reach: the worker has no reason to read a disposition, and a select
 * grant is how a future "just check whether it was verified before
 * overwriting" gets written.
 */
describe('the run worker cannot read or write a human s judgement', () => {
  it('refuses the worker role every statement against finding_disposition', async () => {
    await withSeed('disp', async ({ userId }) => {
      const db = workerDb();
      await expect(db.query("select state from finding_disposition where review_id = 'wg-r-disp'"))
        .rejects.toThrow(/permission denied/i);
      await expect(db.query(
        `insert into finding_disposition
           (review_id, findings_key, clause_id, workspace_id, state, changed_count, by_user_id, at)
         values ('wg-r-disp', 'd1', 'c1', $1, 'verified', 1, $2, now())`, [WS, userId]))
        .rejects.toThrow(/permission denied/i);
      await expect(db.query(
        "update finding_disposition set state = 'verified' where review_id = 'wg-r-disp'"))
        .rejects.toThrow(/permission denied/i);
      await expect(db.query("delete from finding_disposition where review_id = 'wg-r-disp'"))
        .rejects.toThrow(/permission denied/i);
    });
  });

  it('refuses the worker role every statement against finding_disposition_event', async () => {
    await withSeed('dispev', async ({ userId }) => {
      const db = workerDb();
      await expect(db.query(
        "select to_state from finding_disposition_event where review_id = 'wg-r-dispev'"))
        .rejects.toThrow(/permission denied/i);
      await expect(db.query(
        `insert into finding_disposition_event
           (review_id, findings_key, clause_id, workspace_id, from_state, to_state, cause,
            by_user_id, at)
         values ('wg-r-dispev', 'd1', 'c1', $1, 'unchecked', 'verified', 'human', $2, now())`,
        [WS, userId])).rejects.toThrow(/permission denied/i);
      await expect(db.query("delete from finding_disposition_event where review_id = 'wg-r-dispev'"))
        .rejects.toThrow(/permission denied/i);
      // …and not the sequence behind the identity column either, which is
      // 006's second REVOKE and the door an INSERT would otherwise need.
      await expect(db.query("select nextval('finding_disposition_event_id_seq')"))
        .rejects.toThrow(/permission denied/i);
    });
  });

  it('...and the APP role can do all of it, which is what makes the refusals about the ROLE', async () => {
    // THE SANITY CHECK. Without it, a `finding_disposition` table that did
    // not exist, a renamed column, or a typo in `to_state` would produce
    // failures of roughly the right shape and the three tests above would
    // prove nothing — which is exactly how one of Stage 2's grant tests came
    // to prove nothing, and how this file came to be missing these at all.
    await withSeed('dispok', async ({ userId }) => {
      await withPg(async (t: Tx) => {
        await expect(t.query(
          `insert into finding_disposition
             (review_id, findings_key, clause_id, workspace_id, state, changed_count)
           values ('wg-r-dispok', 'd1', 'c1', $1, 'unchecked', 0)`, [WS]))
          .resolves.toBeDefined();
        await expect(t.query(
          `update finding_disposition set state = 'verified', changed_count = 1,
                  by_user_id = $1, at = now()
            where review_id = 'wg-r-dispok'`, [userId])).resolves.toBeDefined();
        await expect(t.query(
          `insert into finding_disposition_event
             (review_id, findings_key, clause_id, workspace_id, from_state, to_state, cause,
              by_user_id, at)
           values ('wg-r-dispok', 'd1', 'c1', $1, 'unchecked', 'verified', 'human', $2, now())`,
          [WS, userId])).resolves.toBeDefined();
        await expect(t.query(
          "select to_state from finding_disposition_event where review_id = 'wg-r-dispok'"))
          .resolves.toHaveLength(1);
        // The app role may not DELETE from the history either — that is what
        // "INSERT-only to every application role, which is what makes it
        // evidence rather than a claim" means, and migration 009 closed the
        // cascade that went around it.
        await expect(t.query("delete from finding_disposition_event where review_id = 'wg-r-dispok'"))
          .rejects.toThrow(/permission denied/i);
      }, appDb());
    });
  });
});

describe('the run worker cannot write a person s remark', () => {
  it('refuses the worker role a note', async () => {
    await withSeed('note', async ({ userId }) => {
      await expect(workerDb().query(
        `insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
         values ('wg-n1', 'wg-r-note', 'd1', 'c1', $1, 'A remark the engine wrote.', $2, now())`,
        [WS, userId])).rejects.toThrow(/permission denied/i);
    });
  });

  it('refuses the worker role a DELETE of a note', async () => {
    await withSeed('notedel', async () => {
      await expect(workerDb().query("delete from note where id = 'wg-n1'"))
        .rejects.toThrow(/permission denied/i);
    });
  });

  it('...and the APP role can insert one, which is what makes the refusal about the role', async () => {
    // Without this the three above would pass against a `note` table that did
    // not exist at all.
    await withSeed('noteok', async ({ userId }) => {
      await withPg(async (t: Tx) => {
        await expect(t.query(
          `insert into note (id, review_id, findings_key, clause_id, workspace_id, text, by_user_id, at)
           values ('wg-n2', 'wg-r-noteok', 'd1', 'c1', $1, 'A person wrote this.', $2, now())`,
          [WS, userId])).resolves.toBeDefined();
      }, appDb());
    });
  });

  it('refuses the worker role an UPDATE of a note, which nobody has', async () => {
    await withSeed('noteupd', async () => {
      await expect(workerDb().query("update note set text = 'rewritten'"))
        .rejects.toThrow(/permission denied/i);
      // Not even the app role: a remark is added or withdrawn, never edited
      // in place, and that is a grant rather than a convention.
      await withPg(async (t: Tx) => {
        await expect(t.query("update note set text = 'rewritten'"))
          .rejects.toThrow(/permission denied/i);
      }, appDb());
    });
  });

  it('refuses the worker role a DELETE of a finding, which only the app role has', async () => {
    await withSeed('finddel', async () => {
      await expect(workerDb().query("delete from finding where review_id = 'wg-r-finddel'"))
        .rejects.toThrow(/permission denied/i);
    });
  });
});

/**
 * EVERY STATEMENT THE RUN WORKER AND THE PARSE WORKER ACTUALLY ISSUE, tried
 * as the worker role.
 *
 * ADDED BECAUSE THE PG SUITES COULD NOT SEE THE DEFECT THAT SHIPPED IN THE
 * FIRST REAL RUN. `run/worker.ts` reads `app_user` to attribute each gateway
 * call to the person who asked for the run, and `lexprompt_worker` held no
 * grant on it: every cell of that run failed with *"permission denied for
 * table app_user"*. That is the system failing in the loud direction — the
 * run ended, each finding said why — but the whole suite was green
 * beforehand, because `runWorker.pg.test.ts` drives the worker over the
 * harness's pinned APP connection.
 *
 * That is a real limitation of running a suite inside a rolled-back
 * transaction: it can prove the SQL is right and can prove nothing at all
 * about which role may run it. So the statements are listed here and
 * attempted as the role that will really run them, and each is paired with
 * the same statement succeeding — a table that did not exist would otherwise
 * produce failures of roughly the right shape and prove nothing.
 */
describe('every table the engine touches, as the role the engine runs as', () => {
  it('reads the identity columns it needs to attribute a call, and NOT the email', async () => {
    await withSeed('actor', async ({ userId }) => {
      // The exact projection `actorForRun` uses.
      await expect(workerDb().query(
        'select id::text as id, issuer, subject, display_name, initials, role from app_user '
        + 'where id = $1', [userId])).resolves.toHaveLength(1);
      // …and nothing beyond it. The gateway's call body carries the id and
      // the (issuer, subject) pair and no address, so a worker that could
      // read one could read something nothing it does needs.
      await expect(workerDb().query('select email from app_user'))
        .rejects.toThrow(/permission denied/i);
    });
  });

  it('leases, updates and reads a run and its cells', async () => {
    await withSeed('queue', async ({ userId }) => {
      const db = workerDb();
      await db.query(
        `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
         values ('wg-run-queue', 'wg-r-queue', $1, 'queued', $2, 5)`, [WS, userId]);
      await db.query(
        `insert into run_cell (run_id, findings_key, clause_id, workspace_id, state)
         values ('wg-run-queue', 'd1', 'c1', $1, 'queued')`, [WS]);
      await expect(db.query(
        `update run_cell set state = 'leased', leased_by = 'w#1',
                             lease_expires_at = now() + interval '1 minute', attempts = 1
          where run_id = 'wg-run-queue'`)).resolves.toBeDefined();
      await expect(db.query(
        "update run set state = 'running', heartbeat_at = now() where id = 'wg-run-queue'"))
        .resolves.toBeDefined();
      await expect(db.query("select 1 from run where id = 'wg-run-queue'"))
        .resolves.toHaveLength(1);
      // The worker may not DELETE a run. Cancel and the reaper both run on
      // the app connection.
      await expect(db.query("delete from run where id = 'wg-run-queue'"))
        .rejects.toThrow(/permission denied/i);
      await migratorDb().query("delete from run_cell where run_id = 'wg-run-queue'");
      await migratorDb().query("delete from run where id = 'wg-run-queue'");
    });
  });

  it('appends an event and cannot prune one', async () => {
    await withSeed('event', async ({ userId }) => {
      const db = workerDb();
      await db.query(
        `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
         values ('wg-run-ev', 'wg-r-event', $1, 'running', $2, 5)`, [WS, userId]);
      await expect(db.query(
        `insert into event (workspace_id, review_id, run_id, type, payload)
         values ($1, 'wg-r-event', 'wg-run-ev', 'finding.done', '{"version":1}'::jsonb)`,
        [WS])).resolves.toBeDefined();
      // The pruner runs beside the reaper, on the app connection.
      await expect(db.query("delete from event where run_id = 'wg-run-ev'"))
        .rejects.toThrow(/permission denied/i);
      await migratorDb().query("delete from event where run_id = 'wg-run-ev'");
      await migratorDb().query("delete from run where id = 'wg-run-ev'");
    });
  });

  it('reads a collection s reading order', async () => {
    // `orderedMembers` decides the order and `document_date` never sorts it.
    // 005 granted the worker four tables and not this one, so a collection
    // cell would have failed with a permission error naming a table rather
    // than reading the order it must not guess at.
    await withSeed('coll', async () => {
      await expect(workerDb().query('select count(*) from collection')).resolves.toBeDefined();
    });
  });

  it('writes a parse result, and only the three columns a parse produces', async () => {
    await withSeed('parse', async () => {
      const db = migratorDb();
      await db.query(
        `insert into document (id, workspace_id, kind, matter_id, name, doc_type, text,
                               parse_state, byte_size, mime, blob_key, role, added_at)
         values ('wg-doc-parse', $1, 'matter', 'wg-m-parse', 'x.pdf', 'pdf', '', 'pending', 1,
                 'application/pdf', 'k', 'standalone', now())`, [WS]);
      try {
        await expect(workerDb().query(
          `update document set text = 'read', parse_state = 'parsed', parse_error = null
            where id = 'wg-doc-parse'`)).resolves.toBeDefined();
        // NOT the disclosure. Detecting tracked changes is still
        // browser-side, and a worker that could write this column would, on
        // its first docx, replace "this document carries tracked changes"
        // with nothing — the counterparty's redline read back as the
        // contract, which is the second entry on CLAUDE.md's list.
        await expect(workerDb().query(
          "update document set markup_notice = null where id = 'wg-doc-parse'"))
          .rejects.toThrow(/permission denied/i);
        // …nor rename it, nor move it to another matter, nor delete it.
        await expect(workerDb().query(
          "update document set name = 'renamed.pdf' where id = 'wg-doc-parse'"))
          .rejects.toThrow(/permission denied/i);
        await expect(workerDb().query("delete from document where id = 'wg-doc-parse'"))
          .rejects.toThrow(/permission denied/i);
      } finally {
        await db.query("delete from document where id = 'wg-doc-parse'");
      }
    });
  });
});
