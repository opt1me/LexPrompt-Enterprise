import { describe, it, expect } from 'vitest';
import { migratorDb, withPg, workerDb } from './helpers/pgHarness.ts';
import {
  refusesEveryDispositionEventStatement, refusesEveryDispositionStatement,
} from './helpers/dispositionGrants.ts';
import {
  WS, aDocument, aMatter, aModelChoice, aReview, aRun, aUser, assertStatesAgree,
  fakeGateway, workerDeps,
} from './helpers/runHarness.ts';
import { allowlistOf, runOneStep } from '../src/run/worker.ts';
import {
  dispositionFor, ensureDisposition, readDispositionEvents, setDisposition,
} from '../src/dispositions/service.ts';
import type { Db, Tx } from '../src/db/pool.ts';

/**
 * TASK 21'S GATE. This file is the reason `carryHumanState` and
 * `findingMerge.ts` could be deleted, and it is deliberately TWO tests that
 * do not prove the same thing.
 *
 * `carryHumanState` existed because `runReview` owned its own copy of a run
 * in the browser and emitted a whole snapshot roughly twice per cell, so a
 * verification a lawyer made while a run was going was invisible to the
 * engine and was overwritten by the next unrelated cell finishing. Deleting
 * it before the property that replaces it is real would discard a lawyer's
 * judgement with nothing on any screen to say so — this stage's one
 * irreversible risk.
 *
 * ## The first test cannot fail, and that is why the second exists
 *
 * "A mid-run verification survives fifteen later cells" passes with the
 * worker holding a write grant on `finding_disposition` and passes without
 * it, because a worker that never attempts the write and a worker that
 * cannot attempt it are indistinguishable from the outside. It was
 * identified as a test that cannot fail BEFORE it was written (plan, P-gate
 * 6), and it is kept anyway because it is the end-to-end statement of the
 * property in the vocabulary the feature is described in — but on its own it
 * would be a green light over an unchecked gap.
 *
 * **The grant is the guarantee, not the behaviour.** The second test asks
 * the database, as the role the engine really runs as, and it is the one
 * that bites: `grant update on finding_disposition to lexprompt_worker`
 * leaves the first test green and turns the second red. Run that mutation on
 * BOTH rather than assuming which one answers.
 */

const CLAUSES = Array.from({ length: 20 }, (_, i) => `c${i + 1}`);
const KEY = 'hs-d1';
const REVIEW = 'hs-r1';
const RUN = 'hs-run1';

async function seedTwentyCells(t: Tx): Promise<{ userId: string }> {
  const userId = await aUser(t, 'Priya Raman');
  await aMatter(t, 'hs-m1');
  await aDocument(t, KEY, 'hs-m1');
  await aReview(t, REVIEW, 'hs-m1', { kind: 'documents', documentIds: [KEY] }, CLAUSES);
  await aModelChoice(t);
  await aRun(t, RUN, REVIEW, CLAUSES.map(clause => ({ key: KEY, clause })), userId);
  return { userId };
}

/** Drives the worker until `n` more cells have been completed, or fails
 *  saying it ran out of work — a loop that silently stops early would make
 *  "fifteen later cells" mean whatever the queue felt like. */
async function completeCells(t: Tx, n: number): Promise<void> {
  const { gateway } = fakeGateway();
  const deps = workerDeps(t, gateway);
  const models = await allowlistOf(gateway);
  for (let i = 0; i < n; i++) {
    const did = await runOneStep(deps, 'hs#1', models);
    expect(did, `cell ${i + 1} of ${n}: the queue had no work left`).toBe(true);
  }
}

async function doneCount(t: Tx): Promise<number> {
  const rows = await t.query<{ n: string }>(
    "select count(*)::text as n from finding where review_id = $1 and status = 'done'", [REVIEW]);
  return Number(rows[0].n);
}

describe('a verification made mid-run is still there when the run ends', () => {
  it('keeps it across every subsequent cell, and the run really did write them', async () => {
    await withPg(async t => {
      const { userId } = await seedTwentyCells(t);

      await completeCells(t, 5);
      expect(await doneCount(t)).toBe(5);

      // A lawyer verifies clause 3 while the run is still going. Through the
      // same service the route uses — not a hand-written UPDATE, which would
      // test a statement no shipped code issues.
      const key = { reviewId: REVIEW, findingsKey: KEY, clauseId: 'c3' };
      const before = await ensureDisposition(t, key, WS);
      await setDisposition(
        t, key, { state: 'verified' }, 'human', { id: userId }, new Date(),
        Number(before.version));

      // Fifteen unrelated cells finish.
      await completeCells(t, 15);
      expect(await doneCount(t)).toBe(20);

      const after = await dispositionFor(t, key);
      expect(after).toMatchObject({ state: 'verified', by_user_id: userId });
      // …and the history says it moved exactly once. A disposition that was
      // cleared and re-set would satisfy `state: 'verified'` too.
      const events = await readDispositionEvents(t, key, WS);
      expect(events.map(e => `${e.from_state}->${e.to_state}/${e.cause}`))
        .toEqual(['unchecked->verified/human']);

      // The neighbours are untouched, which is the other half of "nothing
      // clobbered it": a run that reset every disposition would also pass
      // the assertion above if it happened to reset c3 back to verified.
      const c4 = await dispositionFor(t, { ...key, clauseId: 'c4' });
      expect(c4?.state ?? 'unchecked').toBe('unchecked');

      await assertStatesAgree(t);
    });
  }, 60_000);
});

describe('...and it cannot be lost, because the worker has no grant to lose it with', () => {
  /*
   * THE MUTATION THAT MATTERS, and it must be run on BOTH tests in this file:
   *
   *   grant select, insert, update, delete on finding_disposition
   *     to lexprompt_worker;
   *
   * applied to the live database outside the migrations. The behavioural
   * test above STAYS GREEN. This one turns red. That asymmetry is the whole
   * argument for deleting `carryHumanState`.
   *
   * Asked of the DATABASE rather than of the migration text: `caps.test.ts`
   * scans migration SQL and cannot see a grant applied from `infra/postgres`,
   * an Azure deployment step, or a DBA — and 006's own comment says the
   * explicit REVOKE exists precisely because a future blanket grant "would
   * silently undo it", which a text scan cannot see either.
   */
  // A syntactically valid uuid that names nobody. The INSERT attempts must
  // be refused for the ROLE, and a malformed uuid would be refused at BIND
  // time — a rejection of the right shape for the wrong reason, which is the
  // failure mode this whole file is about.
  const place = {
    reviewId: 'hs-r-grant', findingsKey: 'hs-d-grant', clauseId: 'c1', workspaceId: WS,
    userId: '00000000-0000-0000-0000-0000000000ff',
  };

  it('refuses the worker role every statement against finding_disposition', async () => {
    await refusesEveryDispositionStatement(workerDb(), place);
  });

  it('refuses the worker role every statement against its history', async () => {
    await refusesEveryDispositionEventStatement(workerDb(), place);
  });

  it('...and the APP role can do all of it, which is what makes the refusals about the ROLE', async () => {
    // THE SANITY CHECK. Without it, a `finding_disposition` table that did
    // not exist, or a renamed column, would produce failures of roughly the
    // right shape and the two tests above would prove nothing — which is
    // exactly how one of Stage 2's grant tests came to prove nothing.
    await withPg(async t => {
      const userId = await aUser(t);
      await aMatter(t, 'hs-m-grant');
      await aDocument(t, 'hs-d-grant', 'hs-m-grant');
      await aReview(t, 'hs-r-grant', 'hs-m-grant',
        { kind: 'documents', documentIds: ['hs-d-grant'] }, ['c1']);
      await t.query(
        `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
         values ('hs-r-grant', 'hs-d-grant', 'c1', $1, 'done')`, [WS]);
      const key = { reviewId: 'hs-r-grant', findingsKey: 'hs-d-grant', clauseId: 'c1' };
      const row = await ensureDisposition(t, key, WS);
      await expect(setDisposition(
        t, key, { state: 'verified' }, 'human', { id: userId }, new Date(),
        Number(row.version))).resolves.toBeDefined();
      expect((await readDispositionEvents(t, key, WS)).length).toBe(1);
    });
  });

  it('has not been handed the grant by anything outside the migrations either', async () => {
    /*
     * The catalogue, as a second reading of the same fact — and the one that
     * would notice a grant made to a role `lexprompt_worker` INHERITS from,
     * which an attempted statement cannot distinguish from a direct one but
     * which `006`'s REVOKE would not have removed.
     *
     * `has_table_privilege` follows role membership, so this is the strictly
     * broader question. Paired with `finding`, which the worker DOES hold,
     * so a query that always answered `false` would fail here.
     */
    const db: Db = migratorDb();
    const rows = await db.query<Record<string, boolean>>(
      `select
         has_table_privilege('lexprompt_worker', 'finding_disposition', 'select') as d_select,
         has_table_privilege('lexprompt_worker', 'finding_disposition', 'insert') as d_insert,
         has_table_privilege('lexprompt_worker', 'finding_disposition', 'update') as d_update,
         has_table_privilege('lexprompt_worker', 'finding_disposition', 'delete') as d_delete,
         has_table_privilege('lexprompt_worker', 'finding_disposition_event', 'select') as e_select,
         has_table_privilege('lexprompt_worker', 'finding_disposition_event', 'insert') as e_insert,
         has_table_privilege('lexprompt_worker', 'finding_disposition_event', 'delete') as e_delete,
         has_table_privilege('lexprompt_worker', 'finding', 'update') as f_update`);
    expect(rows[0]).toEqual({
      d_select: false, d_insert: false, d_update: false, d_delete: false,
      e_select: false, e_insert: false, e_delete: false,
      f_update: true,
    });
  });
});
