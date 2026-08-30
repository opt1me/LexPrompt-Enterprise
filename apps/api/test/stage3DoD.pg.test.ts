import { describe, it, expect } from 'vitest';
import { migratorDb, withPg } from './helpers/pgHarness.ts';
import {
  WS, aDocument, aMatter, aModelChoice, aReview, aRun, aUser, assertStatesAgree,
  fakeGateway, workerDeps,
} from './helpers/runHarness.ts';
import { allowlistOf, runOneStep } from '../src/run/worker.ts';
import { settleRunIfFinished } from '../src/run/queue.ts';
import { cancelPendingCells } from '../src/run/lifecycle.ts';
import { describeDiscrepancies, reconcileFindings } from '../src/findings/reconcile.ts';
import {
  dispositionFor, ensureDispositions, readDispositionEvents, setDisposition,
} from '../src/dispositions/service.ts';

/**
 * STAGE 3'S DEFINITION OF DONE — the clauses that can only be made against a
 * real Postgres, and that no other suite makes in this form.
 *
 * `stage3DoD.test.ts` carries the source-level half. This file deliberately
 * does NOT restate what `runLifecycle.pg.test.ts`, `rerunReset.pg.test.ts`,
 * `workerGrants.pg.test.ts` and `humanStateSurvives.pg.test.ts` already
 * prove; two suites making one claim is this project's most repeated
 * failure, and the weaker copy is always the one that stays green when the
 * property breaks.
 *
 * What is here is the END-TO-END shape of §18 item 4 — a run, cancelled
 * mid-flight, with a human's judgement on one of its finished cells — which
 * each of those files covers a slice of and none covers whole. Plus the
 * corpus sweep P18 keeps the frozen blob to answer, which has no home
 * anywhere else.
 */

describe('§18 item 4, end to end: a run cancelled mid-flight', () => {
  it('leaves NO cell pending, keeps what finished, and keeps the judgement on it', async () => {
    /*
     * The three properties at once, because they interact and each suite
     * above sees only one of them:
     *
     *  - nothing is left `pending` — "an abandoned run reopening with every
     *    cell spinning forever, unfinishable" is the defect this queue is
     *    named after;
     *  - what COMPLETED stays completed — a cancellation is a person's
     *    decision to stop, not a failure, and a reviewer is entitled to the
     *    findings it produced;
     *  - a verification made on one of those findings is untouched, because
     *    the engine holds no grant on the table it lives in.
     */
    await withPg(async t => {
      const userId = await aUser(t, 'Priya Raman');
      await aMatter(t, 'dod-m');
      await aDocument(t, 'dod-d', 'dod-m');
      await aReview(t, 'dod-r', 'dod-m',
        { kind: 'documents', documentIds: ['dod-d'] }, ['c1', 'c2', 'c3', 'c4']);
      await aModelChoice(t);
      await aRun(t, 'dod-run', 'dod-r',
        ['c1', 'c2', 'c3', 'c4'].map(clause => ({ key: 'dod-d', clause })), userId);

      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      const models = await allowlistOf(gateway);
      // Two cells finish. `order by clause_id` makes them c1 and c2.
      expect(await runOneStep(deps, 'dod#1', models)).toBe(true);
      expect(await runOneStep(deps, 'dod#1', models)).toBe(true);

      // A lawyer verifies one of them, through the one writer of the table.
      // `ensureDispositions` first because `aRun` seeds the state the QUEUE
      // leaves behind and `createRun` is what seeds the `unchecked` rows —
      // the omission that made the first verification on a server-started
      // run answer 404 (fixed in c991ee9), restated here as a fixture.
      const key = { reviewId: 'dod-r', findingsKey: 'dod-d', clauseId: 'c1' };
      await ensureDispositions(t, 'dod-r', WS,
        ['dod-d', 'dod-d', 'dod-d', 'dod-d'], ['c1', 'c2', 'c3', 'c4']);
      await setDisposition(
        t, key, { state: 'verified' }, 'human', { id: userId },
        new Date(1_700_000_009_000), 1);

      // …and then somebody stops the run. The two statements the cancel
      // route issues, in its order — the route itself needs a signed-in
      // request and the shipped realm has no direct grant, which is why
      // this drives the pair rather than the HTTP.
      await t.query(
        `update run set state = 'cancelling',
                        cancel_requested_at = coalesce(cancel_requested_at, now()),
                        version = version + 1
          where id = 'dod-run' and workspace_id = $1`, [WS]);
      await cancelPendingCells(t, 'dod-run', 'dod-r', WS);
      await settleRunIfFinished(t, 'dod-run', WS);

      const cells = await t.query<{ state: string; n: string }>(
        "select state, count(*)::text n from run_cell where run_id = 'dod-run' group by state");
      const byState = Object.fromEntries(cells.map(c => [c.state, Number(c.n)]));
      expect(byState.done, 'the two finished cells were rewritten').toBe(2);
      expect(byState.cancelled).toBe(2);
      expect(byState.queued ?? 0, 'a cell was left queued on a cancelled run').toBe(0);
      expect(byState.leased ?? 0).toBe(0);

      const findings = await t.query<{ status: string; n: string }>(
        "select status, count(*)::text n from finding where review_id = 'dod-r' group by status");
      const byStatus = Object.fromEntries(findings.map(f => [f.status, Number(f.n)]));
      expect(byStatus.pending ?? 0, 'a card is left spinning on a finished run').toBe(0);
      expect(byStatus.running ?? 0).toBe(0);
      expect(byStatus.done).toBe(2);
      expect(byStatus.cancelled).toBe(2);

      // THE JUDGEMENT. Untouched by the cancellation, with its own instant
      // and its own author, and its history says it moved exactly once.
      const disposition = await dispositionFor(t, key);
      expect(disposition).toMatchObject({ state: 'verified', by_user_id: userId });
      expect((await readDispositionEvents(t, key, WS))
        .map(e => `${e.from_state}->${e.to_state}/${e.cause}`))
        .toEqual(['unchecked->verified/human']);

      // A cancelled run is `cancelled`, not `failed`. §9's whole point: a
      // person asked, so nothing went wrong.
      const run = await t.query<{ state: string; error: string | null }>(
        "select state, error from run where id = 'dod-run'");
      expect(run[0].state).toBe('cancelled');
      expect(run[0].error).toBeNull();

      await assertStatesAgree(t);
    });
  }, 60_000);
});

describe('§18/P18 — the reconciliation, over every review the database has', () => {
  it('reports what it found, and says plainly when there is nothing to reconcile', async () => {
    /*
     * THE LAST MOMENT THE FROZEN BLOB CAN ANSWER "DID THE MIGRATION LOSE
     * ANYTHING?" — and the honest answer here is that it was never asked
     * anything, because there is nothing to ask about.
     *
     * From the freeze (010) onward the rows move and the blob does not, so a
     * review created after it has findings its backup does not describe. The
     * reconciler correctly calls those "a row the blob no longer has", and
     * a sweep six months from now will report a long list that means "these
     * post-date the freeze" rather than "the shred lost something".
     *
     * So the sweep is scoped to reviews whose blob is NON-EMPTY — the only
     * ones the backup is a backup OF. An empty blob is either a review that
     * genuinely had no findings before the migration or one created after
     * it, and neither is a discrepancy.
     *
     * THIS ASSERTION IS DELIBERATELY WEAK, and that is the finding rather
     * than a hole: it is `toEqual([])` over a set which, on the database
     * this ran against, was EMPTY. `finding_migration_report` records
     * *"Migrated 0 findings; 0 human-authored records censused"* — the shred
     * ran over a table that had never held a review, because no browser has
     * ever been driven against this stack (the extension disconnects, the
     * Playwright MCP times out). Every part of P17-P19 has been exercised
     * against fixtures and none of it against data a person made. That is
     * recorded in the stage report and is not something a test can fix.
     */
    const db = migratorDb();
    const reviews = await db.query<{ id: string; has_blob: boolean }>(
      "select id, (findings <> '{}'::jsonb) as has_blob from review order by id");

    const bad: string[] = [];
    for (const review of reviews) {
      if (!review.has_blob) continue;
      // eslint-disable-next-line no-await-in-loop
      const found = await withReconcile(review.id);
      if (found.length > 0) bad.push(`${review.id}:\n${describeDiscrepancies(found)}`);
    }
    expect(bad.join('\n')).toBe('');

    // SAID OUT LOUD rather than left as a silently-passing loop. A reader of
    // a green gate must be able to tell "reconciled 40 reviews" from
    // "reconciled none", and this suite cannot make the second into the
    // first — only a person driving a browser can.
    process.stdout.write(
      `\nstage3DoD: reconciled ${reviews.filter(r => r.has_blob).length} review(s) carrying a `
      + `frozen blob, out of ${reviews.length} in the database; ${bad.length} discrepancies.\n`);
  }, 60_000);

  it('and the sweep can find something, so the empty result above is not the only one it gives', async () => {
    // The sanity check the assertion above cannot make about itself. A
    // reconciliation that has only ever been observed returning `[]` is a
    // reconciliation that returns `[]`; `frozenBlob.pg.test.ts` corrupts
    // every field in turn, and this is the one-line version of it so the
    // corpus sweep is not the only exercise of the tool it depends on.
    await withPg(async t => {
      await aMatter(t, 'dod-rec-m');
      await aDocument(t, 'dod-rec-d', 'dod-rec-m');
      await t.query(
        `insert into review (id, workspace_id, matter_id, playbook_snapshot, document_ids,
                             target, findings, model_id, started_at)
         values ('dod-rec', $1, 'dod-rec-m', '{}'::jsonb, '["dod-rec-d"]'::jsonb,
                 '{"kind":"documents","documentIds":["dod-rec-d"]}'::jsonb, $2::jsonb, 'm', now())`,
        [WS, JSON.stringify({ 'dod-rec-d': { c1: {
          clauseId: 'c1', status: 'done', summary: 'Six months.', citations: [],
          verification: { state: 'unchecked' }, notes: [],
        } } })]);
      // The blob says there is a finding; there is no row. That is exactly
      // the shape "the migration lost something" would take.
      const found = await reconcileFindings(t, 'dod-rec');
      expect(found.length).toBeGreaterThan(0);
      expect(describeDiscrepancies(found)).toMatch(/dod-rec-d\/c1: finding/);
    });
  });
});

/** One review reconciled inside its own rolled-back transaction, so the
 *  corpus sweep leaves nothing behind whatever it finds. */
async function withReconcile(reviewId: string): Promise<Awaited<ReturnType<typeof reconcileFindings>>> {
  let out: Awaited<ReturnType<typeof reconcileFindings>> = [];
  await withPg(async t => { out = await reconcileFindings(t, reviewId); });
  return out;
}
