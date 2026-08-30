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
