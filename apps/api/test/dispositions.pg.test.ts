import { describe, it, expect } from 'vitest';
import { appDb, migratorDb, workerDb, withPg } from './helpers/pgHarness.ts';
import type { Db, Tx } from '../src/db/pool.ts';
import {
  dispositionFor, ensureDisposition, setDisposition, type DispositionRow,
} from '../src/dispositions/service.ts';
import type { FindingKey } from '../src/findings/rows.ts';

/**
 * The disposition tables, and the service that is their only writer.
 *
 * Every constraint here exists because the alternative reading is a lie a
 * reader would act on: a rejection nobody can act on, an attribution to
 * somebody who never touched it, a current state whose history does not
 * explain it, a history somebody could edit afterwards, or an engine that
 * marks its own work as checked.
 */

const WS = '00000000-0000-0000-0000-000000000001';

async function aUser(t: Tx, name = 'A B'): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `insert into app_user (id, workspace_id, issuer, subject, display_name, initials, role, status)
     values (gen_random_uuid(), $1, 'i', 's-' || gen_random_uuid()::text, $2, 'AB', 'reviewer', 'active')
     returning id`, [WS, name]);
  return rows[0].id;
}

/** A review with `clauses.length` findings under one key, ready to be
 *  judged. */
async function aReviewWithFindings(t: Tx, clauses: string[], reviewId = 'dr1'): Promise<void> {
  await t.query(
    `insert into matter (id, workspace_id, name, created_at, updated_at)
     values ('dm1', $1, 'Brookvale', now(), now()) on conflict (id) do nothing`, [WS]);
  await t.query(
    `insert into review (id, workspace_id, matter_id, playbook_snapshot, target, model_id, started_at)
     values ($1, $2, 'dm1', '{}'::jsonb, '{"kind":"documents","documentIds":[]}'::jsonb, 'm', now())
     on conflict (id) do nothing`, [reviewId, WS]);
  for (const clause of clauses) {
    await t.query(
      `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
       values ($1, 'd1', $2, $3, 'done')`, [reviewId, clause, WS]);
  }
}

/**
 * One statement, inside a savepoint, so its failure does not abort the
 * transaction every later statement in the test still needs.
 *
 * Postgres answers every statement after a failed one with "current
 * transaction is aborted", which is what a test asserting several refusals in
 * a row reads back instead of the constraint it named — the constraint fires,
 * the assertion still fails, and the message points nowhere. `pool.ts`'s
 * nested `tx` is a SAVEPOINT, so the rollback is scoped and the original
 * error still propagates.
 */
const attempt = (t: Tx, run: (t: Tx) => Promise<unknown>): Promise<unknown> => t.tx(run);

const key = (clauseId: string, reviewId = 'dr1'): FindingKey =>
  ({ reviewId, findingsKey: 'd1', clauseId });

const insertDisposition = (t: Tx, over: Record<string, unknown> = {}) => t.query(
  `insert into finding_disposition
     (review_id, findings_key, clause_id, workspace_id, state, reason, by_user_id, at, changed_count)
   values ('dr1', 'd1', $1, $2, $3, $4, $5, $6, $7)`,
  [over.clause ?? 'c1', WS, over.state ?? 'unchecked', over.reason ?? null,
    over.by ?? null, over.at ?? null, over.changed ?? 0]);

const insertEvent = (t: Tx, over: Record<string, unknown> = {}) => t.query(
  `insert into finding_disposition_event
     (review_id, findings_key, clause_id, workspace_id, from_state, to_state, reason, cause,
      by_user_id, at)
   values ('dr1', 'd1', $1, $2, $3, $4, $5, $6, $7, now())`,
  [over.clause ?? 'c1', WS, over.from ?? 'unchecked', over.to ?? 'verified',
    over.reason ?? null, over.cause ?? 'human', over.by]);

describe('the database refuses what a card must never be able to say', () => {
  it('refuses a rerun_reset that does not move to unchecked', async () => {
    // S21 made structural: the one write the system performs on its own
    // behalf can only ever REMOVE a claim of human checking.
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      await expect(insertEvent(t, { cause: 'rerun_reset', to: 'verified', by }))
        .rejects.toThrow(/rerun_reset_only_unchecks/);
    });
  });

  it('accepts a rerun_reset that moves to unchecked, which is what makes the refusal about the rule', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      await expect(insertEvent(t, { cause: 'rerun_reset', from: 'verified', to: 'unchecked', by }))
        .resolves.toBeDefined();
    });
  });

  it('refuses a rejection with no reason, in both tables', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      await expect(attempt(t, tt =>
        insertDisposition(tt, { state: 'rejected', by, at: new Date(), changed: 1 })))
        .rejects.toThrow(/disposition_reason_on_reject/);
      await expect(attempt(t, tt => insertDisposition(tt, {
        state: 'rejected', reason: '   ', by, at: new Date(), changed: 1,
      }))).rejects.toThrow(/disposition_reason_on_reject/);
      await expect(attempt(t, tt => insertEvent(tt, { to: 'rejected', by })))
        .rejects.toThrow(/event_reason_on_reject/);
    });
  });

  it('refuses an actor on a never-touched disposition, and a touched one with none', async () => {
    // A never-touched finding has NO actor, and that is a different fact from
    // an unchecked one somebody reset.
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      await expect(attempt(t, tt => insertDisposition(tt, { by, at: new Date(), changed: 0 })))
        .rejects.toThrow(/disposition_actor_iff_touched/);
      await expect(attempt(t, tt => insertDisposition(tt, { state: 'verified', changed: 1 })))
        .rejects.toThrow(/disposition_actor_iff_touched/);
      await expect(attempt(t, tt => insertDisposition(tt, { state: 'verified', by, changed: 1 })))
        .rejects.toThrow(/disposition_actor_iff_touched/);
      // …and the two honest shapes are accepted.
      await expect(insertDisposition(t, { changed: 0 })).resolves.toBeDefined();
    });
  });

  it('refuses a disposition for a finding that does not exist', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      await expect(attempt(t, tt => insertDisposition(tt, { clause: 'c-nothing' })))
        .rejects.toThrow(/finding_disposition_review_id_findings_key_clause_id_fkey/);
    });
  });

  it('anchors the HISTORY to the review instead, which is what lets evidence outlive a finding', async () => {
    /*
     * CHANGED BY MIGRATION 009, deliberately. This used to assert that an
     * event for an unknown CLAUSE was refused by a foreign key to `finding`
     * — and that same foreign key, `on delete cascade`, gave the app role a
     * transitive DELETE on the table 006 calls evidence "because it is
     * INSERT-only to every application role". One `delete from finding` and
     * who verified that clause, when, and what they changed it from was gone.
     *
     * So the parent is the REVIEW now. What that costs is exactly the
     * assertion above: a row-level guarantee that an event names a finding
     * that exists. What replaces it is the code-level one, which is stronger
     * about the thing that matters — `setDisposition` is the only writer,
     * and it reads `finding_disposition` (which still has its foreign key to
     * `finding`) and refuses BY NAME before it writes an event. That refusal
     * is the test three describes below, "refuses to record a judgement about
     * a finding that has no disposition row yet".
     */
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      // An unknown REVIEW is still refused by the database.
      await expect(attempt(t, tt => tt.query(
        `insert into finding_disposition_event
           (review_id, findings_key, clause_id, workspace_id, from_state, to_state, cause,
            by_user_id, at)
         values ('no-such-review', 'd1', 'c1', $1, 'unchecked', 'verified', 'human', $2, now())`,
        [WS, by]))).rejects.toThrow(/finding_disposition_event_review_fkey/);
      // …and the parent is the review, not the finding, which is what makes
      // the history survive a per-key delete.
      await expect(attempt(t, tt => insertEvent(tt, { clause: 'c-nothing', by })))
        .resolves.toBeDefined();
    });
  });

  it('refuses an event with no author', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      await expect(insertEvent(t, { by: null })).rejects.toThrow(/by_user_id/);
    });
  });
});

describe('the history is evidence, not a claim', () => {
  it('cannot update or delete a history row, as the app role', async () => {
    await withPg(async t => {
      await expect(attempt(t, tt =>
        tt.query("update finding_disposition_event set to_state = 'verified'")))
        .rejects.toThrow(/permission denied/i);
      await expect(attempt(t, tt => tt.query('delete from finding_disposition_event')))
        .rejects.toThrow(/permission denied/i);
    }, appDb());
  });

  it('…and the app role CAN insert one, which is what makes the refusal about the verb', async () => {
    // Without this, a table that did not exist would produce refusals of
    // roughly the right shape and the two above would prove nothing — which
    // is exactly how one of Stage 2's grant tests came to prove nothing.
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const by = await aUser(t);
      await expect(insertEvent(t, { by })).resolves.toBeDefined();
    }, appDb());
  });

  it('refuses the worker role both tables, in all four verbs', async () => {
    // The worker has no reason to read a disposition either, and a select
    // grant is how "just check whether it was verified before overwriting"
    // gets written.
    const worker: Db = workerDb();
    const statements = [
      'select * from finding_disposition',
      `insert into finding_disposition (review_id, findings_key, clause_id, workspace_id, state)
       values ('x', 'd', 'c', '${WS}', 'verified')`,
      "update finding_disposition set state = 'verified'",
      'delete from finding_disposition',
      'select * from finding_disposition_event',
      `insert into finding_disposition_event (review_id, findings_key, clause_id, workspace_id,
         from_state, to_state, cause, by_user_id, at)
       values ('x', 'd', 'c', '${WS}', 'unchecked', 'verified', 'human',
               '00000000-0000-0000-0000-0000000000aa', now())`,
      "update finding_disposition_event set to_state = 'verified'",
      'delete from finding_disposition_event',
    ];
    for (const sql of statements) {
      await expect(worker.query(sql), sql).rejects.toThrow(/permission denied/i);
    }
  });
});

describe('setDisposition is the only writer, and it writes both rows or neither', () => {
  it('records the change and the event that explains it', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      const start = await ensureDisposition(t, key('c1'), WS);
      expect(start).toMatchObject({ state: 'unchecked', changed_count: 0, by_user_id: null, at: null });

      const at = new Date(1_700_000_009_000);
      const after = await setDisposition(
        t, key('c1'), { state: 'verified' }, 'human', actor, at, 1);
      expect(after.state).toBe('verified');
      expect(after.by_user_id).toBe(actor.id);
      expect(after.at?.getTime()).toBe(1_700_000_009_000);
      expect(after.changed_count).toBe(1);

      const events = await t.query<{ from_state: string; to_state: string; cause: string; at: Date }>(
        `select from_state, to_state, cause, at from finding_disposition_event
         where clause_id = 'c1' order by id`);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ from_state: 'unchecked', to_state: 'verified', cause: 'human' });
      // The human's own instant, not the moment their browser autosaved.
      expect(events[0].at.getTime()).toBe(1_700_000_009_000);
    });
  });

  it('refuses a rejection with no reason before it reaches the database', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await expect(setDisposition(
        t, key('c1'), { state: 'rejected', reason: '  ' }, 'human', actor, new Date(), 1))
        .rejects.toThrow(/needs a reason/);
      // Nothing was written — not the state, and not a half-history.
      expect((await dispositionFor(t, key('c1'), WS))?.state).toBe('unchecked');
      expect(await t.query('select 1 from finding_disposition_event')).toEqual([]);
    });
  });

  it('DROPS a reason on any state but rejected, so a stale one cannot keep reading as current', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await setDisposition(t, key('c1'), { state: 'rejected', reason: 'The cap is wrong.' },
        'human', actor, new Date(), 1);
      const after = await setDisposition(t, key('c1'), { state: 'verified', reason: 'The cap is wrong.' },
        'human', actor, new Date(), 2);
      expect(after.reason).toBeNull();
    });
  });

  it('refuses a rerun_reset to anything but unchecked, in code as well as in the schema', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await expect(setDisposition(
        t, key('c1'), { state: 'verified' }, 'rerun_reset', actor, new Date(), 1))
        .rejects.toThrow(/can only move a disposition to unchecked/);
    });
  });

  it('REFUSES a stale change and applies nothing, rather than overwriting a judgement nobody saw', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const partner = { id: await aUser(t, 'Partner'), workspaceId: WS };
      const trainee = { id: await aUser(t, 'Trainee'), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await setDisposition(t, key('c1'), { state: 'rejected', reason: 'Wrong schedule.' },
        'human', partner, new Date(), 1);
      // The trainee was looking at version 1.
      await expect(setDisposition(t, key('c1'), { state: 'verified' }, 'human', trainee, new Date(), 1))
        .rejects.toThrow(/changed since you opened it/i);
      const now = await dispositionFor(t, key('c1'), WS);
      expect(now?.state).toBe('rejected');
      expect(now?.by_user_id).toBe(partner.id);
      expect(await t.query('select 1 from finding_disposition_event')).toHaveLength(1);
    });
  });

  it('names WHO SET THE CURRENT STATE, never who set the first', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const trainee = { id: await aUser(t, 'Trainee'), workspaceId: WS };
      const partner = { id: await aUser(t, 'Partner'), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await setDisposition(t, key('c1'), { state: 'verified' }, 'human', trainee, new Date(1), 1);
      const after = await setDisposition(t, key('c1'), { state: 'verified' }, 'human', partner, new Date(2), 2);
      expect(after.by_user_id).toBe(partner.id);
      // …and the trainee is still in the history, which is where they belong.
      const events = await t.query<{ by_user_id: string }>(
        'select by_user_id from finding_disposition_event order by id');
      expect(events.map(e => e.by_user_id)).toEqual([trainee.id, partner.id]);
    });
  });
});

describe('the current state and its history cannot disagree', () => {
  it('recomputes finding_disposition from its history and finds it equal', async () => {
    // The cache-versus-source check (§19). The disagreement here would be
    // between what a card says a person judged and what actually happened.
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1', 'c2', 'c3', 'c4']);
      const a = { id: await aUser(t, 'A'), workspaceId: WS };
      const b = { id: await aUser(t, 'B'), workspaceId: WS };
      for (const clause of ['c1', 'c2', 'c3', 'c4']) await ensureDisposition(t, key(clause), WS);

      await setDisposition(t, key('c1'), { state: 'verified' }, 'human', a, new Date(1_000), 1);
      await setDisposition(t, key('c2'), { state: 'flagged' }, 'human', b, new Date(2_000), 1);
      await setDisposition(t, key('c2'), { state: 'rejected', reason: 'The cap is in schedule 6.' },
        'human', a, new Date(3_000), 2);
      await setDisposition(t, key('c3'), { state: 'verified' }, 'human', a, new Date(4_000), 1);
      // …and one that returns to unchecked, which a reconciliation over a
      // single forward change would never exercise.
      await setDisposition(t, key('c3'), { state: 'unchecked' }, 'rerun_reset', b, new Date(5_000), 2);
      await setDisposition(t, key('c4'), { state: 'verified' }, 'human', b, new Date(6_000), 1);
      await setDisposition(t, key('c4'), { state: 'flagged' }, 'human', a, new Date(7_000), 2);
      await setDisposition(t, key('c4'), { state: 'verified' }, 'human', b, new Date(8_000), 3);

      const stored = await t.query<Record<string, unknown>>(
        `select clause_id, state, reason, by_user_id::text, at, changed_count
         from finding_disposition where review_id = 'dr1' order by clause_id`);
      const recomputed = await t.query<Record<string, unknown>>(
        `select distinct on (clause_id) clause_id,
                to_state as state, reason, by_user_id::text, at,
                count(*) over (partition by clause_id)::int as changed_count
         from finding_disposition_event
         where review_id = 'dr1'
         order by clause_id, id desc`);
      expect(recomputed).toEqual(stored);
      expect(stored).toHaveLength(4);
      expect(stored.map(r => r.changed_count)).toEqual([1, 2, 2, 3]);
    });
  });
});

describe('a disposition belongs to the finding it is about', () => {
  it('goes when the finding goes, rather than counting toward a clause nobody has', async () => {
    // ON THE MIGRATOR CONNECTION. Migration 011 took `delete on finding` away
    // from `lexprompt_app`, so no application role can produce this state any
    // more — which is the point of the revoke, and makes the fixture the
    // schema owner's to build. The CASCADE it exercises is unchanged; only
    // who may trigger it is.
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await setDisposition(t, key('c1'), { state: 'verified' }, 'human', actor, new Date(), 1);
      await t.query("delete from finding where review_id = 'dr1' and clause_id = 'c1'");
      expect(await t.query('select 1 from finding_disposition')).toEqual([]);
      // THE HISTORY DOES NOT (migration 009). This assertion used to read
      // `.toEqual([])` for the event table too, and that was the defect: 006
      // calls this table evidence BECAUSE no application role may delete
      // from it, and a cascade through `delete on finding` is a delete. The
      // current disposition is the blob's mirror and goes with the finding;
      // the record of who changed what, when, has no copy anywhere else.
      //
      // Since migration 011 no application role holds `delete on finding`
      // either, so the cascade is reachable only from the schema owner —
      // which is why this test runs on the migrator connection.
      expect(await t.query('select 1 from finding_disposition_event')).toHaveLength(1);
    }, migratorDb());
  });

  it('and goes when the REVIEW goes, so the evidence is retained rather than immortal', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await ensureDisposition(t, key('c1'), WS);
      await setDisposition(t, key('c1'), { state: 'verified' }, 'human', actor, new Date(), 1);
      await t.query("delete from review where id = 'dr1'");
      expect(await t.query('select 1 from finding_disposition_event')).toEqual([]);
    });
  });

  it('refuses to record a judgement about a finding that has no disposition row yet', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      const actor = { id: await aUser(t), workspaceId: WS };
      await expect(setDisposition(t, key('c1'), { state: 'verified' }, 'human', actor, new Date(), 1))
        .rejects.toThrow(/no finding .* to record a judgement about/);
    });
  });

  it('creates the unchecked row idempotently, without an event and without an actor', async () => {
    await withPg(async t => {
      await aReviewWithFindings(t, ['c1']);
      await ensureDisposition(t, key('c1'), WS);
      const again = await ensureDisposition(t, key('c1'), WS);
      expect(again).toMatchObject({ state: 'unchecked', changed_count: 0, by_user_id: null, at: null });
      expect(await t.query('select 1 from finding_disposition_event')).toEqual([]);
    });
  });
});

export type { DispositionRow };
