import { describe, it, expect } from 'vitest';
import { withPg, dbOn } from './helpers/pgHarness.ts';
import { buildTestApi } from './helpers/apiHarness.ts';
import {
  WS, MODEL, aDocument, aMatter, aModelChoice, aReview, aRun, aUser, assertStatesAgree,
  fakeGateway, workerDeps,
} from './helpers/runHarness.ts';
import { leaseCell, runOneStep, runsThisPoolIsWorkingOn } from '../src/run/worker.ts';
import { MISSED_HEARTBEATS_BEFORE_DEAD, reapOnce, stalledQueuedRuns } from '../src/run/reaper.ts';
import type { Tx } from '../src/db/pool.ts';
import type { RunView } from '@lexprompt/core';

/**
 * Task 11: a run that died must not look finished.
 *
 * The four facts a reader must be able to tell apart, because collapsing any
 * pair of them is this stage's version of answering quietly wrong:
 *
 *   succeeded  every cell reached `done` or `error`, and the run finished
 *   cancelled  a person asked. NOT a failure. What completed stays
 *   failed     nobody asked. NOT a cancellation and NOT a success. It says why
 *   running    in flight — and the HEARTBEAT is what distinguishes that from
 *              stuck
 *
 * Every scenario ends with `assertStatesAgree` (Step 6): an invariant checked
 * in one scenario is an assertion about one scenario.
 */

const PRINCIPAL = {
  issuer: 'https://issuer.example/realms/lexprompt', subject: 'sub-life', groups: ['reviewers'],
};

function harness(t: Tx, actorId: string) {
  const { app } = buildTestApi({
    principal: PRINCIPAL,
    db: dbOn(t),
    actor: {
      id: actorId, displayName: 'T', initials: 'T', role: 'reviewer', workspaceId: WS,
    },
  });
  return {
    async cancel(runId: string): Promise<RunView> {
      const res = await app.inject({
        method: 'POST', url: `/v1/runs/${runId}/cancel`,
        headers: { authorization: 'Bearer t' },
      });
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as RunView;
    },
  };
}

async function seed(t: Tx, suffix: string, clauses: string[]): Promise<string> {
  const userId = await aUser(t);
  await aMatter(t, `l-m-${suffix}`);
  await aDocument(t, `l-d-${suffix}`, `l-m-${suffix}`);
  await aReview(t, `l-r-${suffix}`, `l-m-${suffix}`,
    { kind: 'documents', documentIds: [`l-d-${suffix}`] }, clauses);
  await aModelChoice(t);
  await aRun(t, `l-run-${suffix}`, `l-r-${suffix}`,
    clauses.map(c => ({ key: `l-d-${suffix}`, clause: c })), userId);
  return userId;
}

async function cellStates(t: Tx, runId: string): Promise<Record<string, number>> {
  const rows = await t.query<{ state: string; n: string }>(
    'select state, count(*)::text as n from run_cell where run_id = $1 group by state', [runId]);
  return Object.fromEntries(rows.map(r => [r.state, Number(r.n)]));
}

async function findingStates(t: Tx, reviewId: string): Promise<Record<string, number>> {
  const rows = await t.query<{ status: string; n: string }>(
    'select status, count(*)::text as n from finding where review_id = $1 group by status',
    [reviewId]);
  return Object.fromEntries(rows.map(r => [r.status, Number(r.n)]));
}

async function runRow(t: Tx, runId: string) {
  return (await t.query<{
    state: string; error: string | null; finished_at: Date | null; heartbeat_at: Date | null;
  }>('select state, error, finished_at, heartbeat_at from run where id = $1', [runId]))[0];
}

describe('cancel leaves no cell in pending, and rewrites nothing that finished', () => {
  it('cancels what has not started and keeps what has', async () => {
    await withPg(async t => {
      const userId = await seed(t, 'cancel', ['c1', 'c2', 'c3']);
      const { gateway } = fakeGateway();
      // One cell answered for real, so there is completed work to protect.
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);
      expect((await cellStates(t, 'l-run-cancel')).done).toBe(1);

      const run = await harness(t, userId).cancel('l-run-cancel');

      expect(run.state).toBe('cancelled');
      // NOTHING is left `queued` or `leased`. This is the shipped defect the
      // task is named after: "an abandoned run reopening with every cell
      // spinning forever, unfinishable".
      const cells = await cellStates(t, 'l-run-cancel');
      expect(cells.queued ?? 0).toBe(0);
      expect(cells.leased ?? 0).toBe(0);
      expect(cells.done).toBe(1);
      expect(cells.cancelled).toBe(2);

      // …and the completed finding is UNTOUCHED. A cancelled run is real,
      // partial work: the reviewer is entitled to what it found.
      const findings = await findingStates(t, 'l-r-cancel');
      expect(findings.done).toBe(1);
      expect(findings.cancelled).toBe(2);
      expect(findings.pending ?? 0).toBe(0);
      expect(findings.running ?? 0).toBe(0);

      // A cancellation is NOT a failure and says so: no error text.
      expect((await runRow(t, 'l-run-cancel')).error).toBeNull();
      expect((await runRow(t, 'l-run-cancel')).finished_at).not.toBeNull();
      await assertStatesAgree(t);
    });
  });

  it('cancels a run no worker ever started, without waiting for one', async () => {
    // There may be no worker at all: the pool can be busy, or the API can
    // have restarted since. A run that could only be cancelled by the worker
    // holding it would be uncancellable in exactly that case.
    await withPg(async t => {
      const userId = await seed(t, 'never', ['c1', 'c2']);
      const run = await harness(t, userId).cancel('l-run-never');
      expect(run.state).toBe('cancelled');
      expect(run.cells).toMatchObject({ total: 2, cancelled: 2, queued: 0, leased: 0 });
      await assertStatesAgree(t);
    });
  });

  it('is idempotent, and never rewrites a run that already succeeded', async () => {
    await withPg(async t => {
      const userId = await seed(t, 'done', ['c1']);
      const { gateway } = fakeGateway();
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);
      expect((await runRow(t, 'l-run-done')).state).toBe('succeeded');

      const h = harness(t, userId);
      const run = await h.cancel('l-run-done');
      // A complete review must not read as a partial one because somebody
      // pressed Cancel after it finished.
      expect(run.state).toBe('succeeded');
      expect((await h.cancel('l-run-done')).state).toBe('succeeded');
      await assertStatesAgree(t);
    });
  });

  it('stops the queue: a cancelling run s remaining cells are not leased', async () => {
    await withPg(async t => {
      const userId = await seed(t, 'stop', ['c1', 'c2', 'c3']);
      await harness(t, userId).cancel('l-run-stop');
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      expect(await leaseCell(deps.db, deps, 'w#1')).toBeNull();
      await assertStatesAgree(t);
    });
  });
});

describe('a dead worker s cell is re-leased and finishes', () => {
  it('re-leases a cell whose lease expired, and counts the attempt', async () => {
    await withPg(async t => {
      await seed(t, 'release', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);

      const first = await leaseCell(deps.db, deps, 'worker-a');
      expect(first?.cell.attempts).toBe(1);
      // The worker died holding it.
      await t.query("update run_cell set lease_expires_at = now() - interval '1 minute' "
        + 'where run_id = $1', ['l-run-release']);

      const again = await leaseCell(deps.db, deps, 'worker-b');
      expect(again?.cell.clause_id).toBe(first?.cell.clause_id);
      expect(again?.cell.leased_by).toBe('worker-b');
      expect(again?.cell.attempts).toBe(2);

      // MUTATION: drop `or (c.state = 'leased' and c.lease_expires_at <
      // now())` from the claim query and this fails. Without the mutation
      // check it would pass against a queue that never leases anything at
      // all — which is how a Stage 2 test came to prove nothing — so the
      // FIRST lease is asserted above too.
      await assertStatesAgree(t);
    });
  });

  it('finishes the run after a re-lease, rather than leaving it half done', async () => {
    await withPg(async t => {
      await seed(t, 'finish', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      await leaseCell(deps.db, deps, 'worker-a');
      await t.query("update run_cell set lease_expires_at = now() - interval '1 minute' "
        + 'where run_id = $1', ['l-run-finish']);

      expect(await runOneStep(deps, 'worker-b', [MODEL])).toBe(true);
      expect((await runRow(t, 'l-run-finish')).state).toBe('succeeded');
      expect((await findingStates(t, 'l-r-finish')).done).toBe(1);
      await assertStatesAgree(t);
    });
  });
});

describe('attempts exhausted is an error finding, never a silent stop', () => {
  it('closes a cell that has spent every attempt, carrying its last error', async () => {
    // Without this the cell is UNREACHABLE: the claim query requires
    // `attempts < max`, so nothing leases it again, the run's queued+leased
    // count never reaches zero, and the run sits `running` with a live
    // heartbeat forever — the one state the reaper's own rule says is not
    // stuck.
    await withPg(async t => {
      await seed(t, 'spent', ['c1']);
      await t.query(
        `update run_cell set state = 'leased', attempts = 3,
                             lease_expires_at = now() - interval '1 minute',
                             last_error = 'the provider timed out'
          where run_id = $1`, ['l-run-spent']);
      await t.query("update run set state = 'running', heartbeat_at = now() where id = $1",
        ['l-run-spent']);

      const result = await reapOnce({
        db: dbOn(t), heartbeatMs: 15_000, eventRetentionDays: 7, attemptsMax: 3,
      });
      expect(result.exhausted).toBe(1);

      const cells = await cellStates(t, 'l-run-spent');
      expect(cells.error).toBe(1);
      const rows = await t.query<{ error: string }>(
        'select error from finding where review_id = $1', ['l-r-spent']);
      // The card shows the LAST ERROR, exactly as it shows an extraction
      // error today — a finding a person can retry by hand.
      expect(rows[0].error).toContain('the provider timed out');
      expect(rows[0].error).toContain('3 times');
      await assertStatesAgree(t);
    });
  });
});

describe('the reaper', () => {
  const reaper = (t: Tx) => ({
    db: dbOn(t), heartbeatMs: 1_000, eventRetentionDays: 7, attemptsMax: 3,
  });

  it('marks a run whose heartbeat stopped as FAILED, and says why', async () => {
    await withPg(async t => {
      await seed(t, 'dead', ['c1', 'c2']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      await leaseCell(deps.db, deps, 'worker-a');
      // The worker was killed. Its lease and its heartbeat both stop.
      await t.query(
        `update run set heartbeat_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
        ['l-run-dead', String(1_000 * (MISSED_HEARTBEATS_BEFORE_DEAD + 1))]);

      const result = await reapOnce(reaper(t));
      expect(result.reaped).toEqual(['l-run-dead']);

      const run = await runRow(t, 'l-run-dead');
      // FAILED, not cancelled: nobody asked it to stop, and calling it
      // cancelled would tell a reviewer a decision was made that was not.
      expect(run.state).toBe('failed');
      expect(run.error).toMatch(/stopped without finishing/);
      expect(run.finished_at).not.toBeNull();

      // Its cells become `error` — NOT `cancelled` — and so do their
      // findings, carrying the same sentence, in the place a card renders.
      const cells = await cellStates(t, 'l-run-dead');
      expect(cells.error).toBe(2);
      expect(cells.cancelled ?? 0).toBe(0);
      const rows = await t.query<{ status: string; error: string }>(
        'select status, error from finding where review_id = $1', ['l-r-dead']);
      expect(rows.every(r => r.status === 'error')).toBe(true);
      expect(rows[0].error).toMatch(/No worker has reported on it/);

      const events = await t.query<{ type: string; payload: Record<string, unknown> }>(
        "select type, payload from event where run_id = $1 and type = 'run.finished'",
        ['l-run-dead']);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ state: 'failed', cells: 2, errored: 2 });
      await assertStatesAgree(t);
    });
  });

  it('does NOT reap a queued run that no worker has picked up yet', async () => {
    // The difference between a busy queue and a broken one. A `queued` run
    // has no heartbeat because nothing has touched it, and marking it failed
    // for waiting would turn every burst of work into a wall of failures.
    await withPg(async t => {
      await seed(t, 'waiting', ['c1']);
      expect((await runRow(t, 'l-run-waiting')).heartbeat_at).toBeNull();
      const result = await reapOnce(reaper(t));
      expect(result.reaped).toEqual([]);
      expect((await runRow(t, 'l-run-waiting')).state).toBe('queued');
      expect((await cellStates(t, 'l-run-waiting')).queued).toBe(1);
      await assertStatesAgree(t);
    });
  });

  it('does NOT reap a run that is only WAITING FOR A SLOT behind another run', async () => {
    /*
     * FINAL REVIEW M1. A healthy run was reaped for being starved.
     *
     * `run.heartbeat_at` advances in exactly two places — `leaseCell` and
     * the pool's ticker — and the ticker used to update only runs with a
     * cell leased BY THIS PROCESS. CLAIM orders `by c.run_id, …  limit 1`,
     * so with two live runs in one workspace every slot deterministically
     * takes from the lexicographically-lower `run_id`; the other run sits at
     * `running` with only `queued` cells, beats nothing, and is `failed`
     * 45 s later with every unstarted clause written `error` carrying *"This
     * run stopped without finishing"*. Nothing had stopped.
     *
     * The two statements below are exactly the two the ticker issues —
     * `runsThisPoolIsWorkingOn`, then the heartbeat update over what it
     * returned — because the ticker itself is a `setInterval` inside
     * `startWorkerPool` that no suite can hold still, which is why this went
     * unnoticed.
     */
    await withPg(async t => {
      await seed(t, 'busy', ['c1']);
      await seed(t, 'starved', ['c1', 'c2']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);

      // The pool's one slot is on `l-run-busy`; `l-run-starved` is `running`
      // with both cells still queued and a heartbeat three intervals old.
      await leaseCell(deps.db, deps, 'worker-a#1');
      await t.query(
        "update run set state = 'running', heartbeat_at = now() - interval '5 minutes' "
        + "where id = 'l-run-starved'");

      const active = await runsThisPoolIsWorkingOn(
        { db: deps.db, caps: deps.caps, workerId: 'worker-a' });
      expect(active, 'a live pool did not count the run it is about to work on')
        .toContain('l-run-starved');
      expect(active).toContain('l-run-busy');

      await t.query('update run set heartbeat_at = now() where id = any($1::text[])', [active]);
      const result = await reapOnce(reaper(t));
      expect(result.reaped, 'a run that was only waiting for a slot was reaped').toEqual([]);
      expect((await runRow(t, 'l-run-starved')).state).toBe('running');
      expect((await cellStates(t, 'l-run-starved')).queued).toBe(2);
      await assertStatesAgree(t);
    });
  });

  it('does NOT beat for a QUEUED run, which would silence the stalled-queue report', async () => {
    // The other half of the rule, and it is not decoration:
    // `stalledQueuedRuns` finds a run stuck behind
    // `run_one_live_per_review` by `heartbeat_at is null`. A ticker that
    // beat for every claimable cell would give a queued run a heartbeat and
    // take the one report that names it off the log for ever.
    await withPg(async t => {
      await seed(t, 'notstarted', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      // `now()` is the TRANSACTION's timestamp, so a run seeded in this
      // transaction is never older than it — the same backdating the
      // stalled-queue tests below use.
      await t.query("update run set created_at = now() - interval '1 hour' where id = $1",
        ['l-run-notstarted']);
      expect(await runsThisPoolIsWorkingOn(
        { db: deps.db, caps: deps.caps, workerId: 'worker-a' })).toEqual([]);
      expect((await runRow(t, 'l-run-notstarted')).heartbeat_at).toBeNull();
      expect(await stalledQueuedRuns(reaper(t))).toContain('l-run-notstarted');
      await assertStatesAgree(t);
    });
  });

  it('does NOT beat for a run whose every cell has SPENT its attempts', async () => {
    // `exhaustSpentCells` owns those, not this pool: CLAIM requires
    // `attempts < max`, so nothing here will ever lease one again, and
    // beating for it would keep a genuinely unfinishable run alive.
    await withPg(async t => {
      await seed(t, 'spent', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      await t.query(
        "update run set state = 'running' where id = 'l-run-spent'");
      await t.query(
        'update run_cell set attempts = $1 where run_id = $2',
        [deps.caps.runAttemptsMax, 'l-run-spent']);
      expect(await runsThisPoolIsWorkingOn(
        { db: deps.db, caps: deps.caps, workerId: 'worker-a' })).toEqual([]);
      await assertStatesAgree(t);
    });
  });

  it('does NOT reap a run whose heartbeat is fresh', async () => {
    await withPg(async t => {
      await seed(t, 'alive', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      await leaseCell(deps.db, deps, 'worker-a');
      const result = await reapOnce(reaper(t));
      expect(result.reaped).toEqual([]);
      expect((await runRow(t, 'l-run-alive')).state).toBe('running');
      await assertStatesAgree(t);
    });
  });

  it('leaves a reaped run s COMPLETED findings alone', async () => {
    // A run that died after twelve of forty cells still found twelve
    // things. Sweeping them away would destroy work a person may already
    // have read.
    await withPg(async t => {
      await seed(t, 'partial', ['c1', 'c2', 'c3']);
      const { gateway } = fakeGateway();
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);
      await t.query(
        `update run set heartbeat_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
        ['l-run-partial', String(1_000 * (MISSED_HEARTBEATS_BEFORE_DEAD + 1))]);

      await reapOnce(reaper(t));
      const findings = await findingStates(t, 'l-r-partial');
      expect(findings.done).toBe(1);
      expect(findings.error).toBe(2);
      expect(findings.pending ?? 0).toBe(0);
      // A PARTIAL RUN MUST NEVER READ AS A COMPLETE ONE: the counts travel
      // with the run so "1 of 3" is a fact a reader is entitled to.
      const events = await t.query<{ payload: Record<string, unknown> }>(
        "select payload from event where run_id = $1 and type = 'run.finished'",
        ['l-run-partial']);
      expect(events[0].payload).toMatchObject({
        state: 'failed', cells: 3, done: 1, errored: 2,
      });
      await assertStatesAgree(t);
    });
  });

  it('reaps a run once, however many times it sweeps', async () => {
    // Two API replicas both run a reaper. Without the re-read inside the
    // transaction they would both sweep and append two `run.finished`
    // events, and a client applying the second would render a finished run
    // twice.
    await withPg(async t => {
      await seed(t, 'twice', ['c1']);
      const { gateway } = fakeGateway();
      const deps = workerDeps(t, gateway);
      await leaseCell(deps.db, deps, 'worker-a');
      await t.query(
        `update run set heartbeat_at = now() - ($2 || ' milliseconds')::interval where id = $1`,
        ['l-run-twice', String(1_000 * (MISSED_HEARTBEATS_BEFORE_DEAD + 1))]);

      expect((await reapOnce(reaper(t))).reaped).toEqual(['l-run-twice']);
      expect((await reapOnce(reaper(t))).reaped).toEqual([]);
      const events = await t.query<{ id: string }>(
        "select id from event where run_id = $1 and type = 'run.finished'", ['l-run-twice']);
      expect(events).toHaveLength(1);
      await assertStatesAgree(t);
    });
  });
});

describe('the four endings stay distinguishable', () => {
  it('succeeded, cancelled and failed are three different rows, not one', async () => {
    await withPg(async t => {
      const { gateway } = fakeGateway();

      const userA = await seed(t, 'ok', ['c1']);
      await runOneStep(workerDeps(t, gateway), 'w#1', [MODEL]);

      const userB = await seed(t, 'stopped', ['c1']);
      await harness(t, userB).cancel('l-run-stopped');

      await seed(t, 'died', ['c1']);
      const deps = workerDeps(t, gateway);
      await leaseCell(deps.db, deps, 'worker-a');
      await t.query(
        `update run set heartbeat_at = now() - interval '1 hour' where id = $1`, ['l-run-died']);
      await reapOnce({
        db: dbOn(t), heartbeatMs: 1_000, eventRetentionDays: 7, attemptsMax: 3,
      });

      expect((await runRow(t, 'l-run-ok')).state).toBe('succeeded');
      expect((await runRow(t, 'l-run-stopped')).state).toBe('cancelled');
      expect((await runRow(t, 'l-run-died')).state).toBe('failed');
      // Only the one that failed says why. A cancellation with an error
      // message would read as a failure; a failure without one is a run
      // nobody can act on.
      expect((await runRow(t, 'l-run-ok')).error).toBeNull();
      expect((await runRow(t, 'l-run-stopped')).error).toBeNull();
      expect((await runRow(t, 'l-run-died')).error).toBeTruthy();
      expect(userA).not.toBe(userB);
      await assertStatesAgree(t);
    });
  });
});

/**
 * M5: A RUN WHOSE LAST CELL WAS EXHAUSTED IS `succeeded`, NOT `failed`.
 *
 * `exhaustSpentCells` closed the cell and returned. `settleRunIfFinished`
 * has four call sites and none of them was here, so if the exhausted cell
 * was the run's last live one, `queued + leased` reached zero with nobody to
 * notice: the run's lease was gone, so the worker pool stopped heartbeating
 * for it, and ~45s later `reapDeadRuns` marked it **failed** with *"This run
 * stopped without finishing. No worker has reported on it since …"* — for a
 * run in which every cell has an answer and most of them are `done`.
 *
 * 008's opening comment is explicit that telling `succeeded` from `failed`
 * is the file's whole purpose, and that "collapsing any pair of those is
 * this stage's version of answering quietly wrong". This collapsed exactly
 * that pair, and attributed it to a worker that never went away.
 */
describe('exhausting the last cell settles the run, rather than leaving it to be reaped', () => {
  it('settles a run whose only cell was exhausted as succeeded, with a run.finished event', async () => {
    await withPg(async t => {
      await seed(t, 'settle1', ['c1']);
      await t.query(
        `update run_cell set state = 'leased', attempts = 3,
                             lease_expires_at = now() - interval '1 minute',
                             last_error = 'the provider timed out'
          where run_id = $1`, ['l-run-settle1']);
      await t.query("update run set state = 'running', heartbeat_at = now() where id = $1",
        ['l-run-settle1']);

      const result = await reapOnce({
        db: dbOn(t), heartbeatMs: 15_000, eventRetentionDays: 7, attemptsMax: 3,
      });
      expect(result.exhausted).toBe(1);

      const run = await runRow(t, 'l-run-settle1');
      // NOT `failed`, and not still `running`. Every cell has an answer.
      expect(run.state).toBe('succeeded');
      expect(run.finished_at).not.toBeNull();
      expect(run.error).toBeNull();

      const events = await t.query<{ type: string; payload: unknown }>(
        "select type, payload from event where run_id = $1 and type = 'run.finished'",
        ['l-run-settle1']);
      expect(events).toHaveLength(1);
      await assertStatesAgree(t);
    });
  });

  it('leaves a run with a live cell alone — settling is idempotent, not eager', async () => {
    await withPg(async t => {
      await seed(t, 'settle2', ['c1', 'c2']);
      // One cell spent; the other still queued and perfectly claimable.
      await t.query(
        `update run_cell set state = 'leased', attempts = 3,
                             lease_expires_at = now() - interval '1 minute'
          where run_id = $1 and clause_id = 'c1'`, ['l-run-settle2']);
      await t.query("update run set state = 'running', heartbeat_at = now() where id = $1",
        ['l-run-settle2']);

      await reapOnce({
        db: dbOn(t), heartbeatMs: 15_000, eventRetentionDays: 7, attemptsMax: 3,
      });

      const run = await runRow(t, 'l-run-settle2');
      expect(run.state).toBe('running');
      expect(run.finished_at).toBeNull();
      expect(await t.query(
        "select 1 from event where run_id = $1 and type = 'run.finished'", ['l-run-settle2']))
        .toEqual([]);
      await assertStatesAgree(t);
    });
  });

  it('does not overwrite an answer a cell already produced', async () => {
    // n1: `exhaustCell` shipped WITHOUT the `status in ('pending','running')`
    // guard the reaper's inline copy had, so calling it — which nothing did —
    // would have replaced a `done` answer with an error message. The reaper
    // now goes through it, so the guard has to be in the shared function.
    await withPg(async t => {
      await seed(t, 'settle3', ['c1']);
      await t.query(
        `update run_cell set state = 'leased', attempts = 3,
                             lease_expires_at = now() - interval '1 minute'
          where run_id = $1`, ['l-run-settle3']);
      await t.query("update run set state = 'running', heartbeat_at = now() where id = $1",
        ['l-run-settle3']);
      await t.query(
        `update finding set status = 'done', summary = 'The break notice is six months.'
          where review_id = $1`, ['l-r-settle3']);

      await reapOnce({
        db: dbOn(t), heartbeatMs: 15_000, eventRetentionDays: 7, attemptsMax: 3,
      });

      const rows = await t.query<{ status: string; summary: string | null; error: string | null }>(
        'select status, summary, error from finding where review_id = $1', ['l-r-settle3']);
      expect(rows[0].status).toBe('done');
      expect(rows[0].summary).toBe('The break notice is six months.');
      expect(rows[0].error).toBeNull();
    });
  });
});

/**
 * n9: a `queued` run nothing will ever lease is REPORTED, never reaped.
 *
 * Not reaping it is right: a busy queue is not a broken one, and turning
 * every burst of work into a wall of failures is worse than the wait. But
 * `run_one_live_per_review` then makes every later POST on that review
 * answer 409 "This review is already running", for a run that is not
 * running and never will be, and the only exit is a cancel route nothing in
 * Part 3A calls and nothing tells an operator about.
 */
describe('a queued run with no worker is reported, and still not reaped', () => {
  it('names it once it has waited longer than the reaper s own staleness window', async () => {
    await withPg(async t => {
      await seed(t, 'stall', ['c1']);
      await t.query(
        "update run set state = 'queued', heartbeat_at = null, created_at = now() - interval '1 hour' "
        + 'where id = $1', ['l-run-stall']);

      const deps = { db: dbOn(t), heartbeatMs: 1_000, eventRetentionDays: 7, attemptsMax: 3 };
      expect(await stalledQueuedRuns(deps)).toEqual(['l-run-stall']);
      // …and it is still QUEUED. A report is not a state change.
      expect((await runRow(t, 'l-run-stall')).state).toBe('queued');
      expect((await reapOnce(deps)).reaped).toEqual([]);
      expect((await runRow(t, 'l-run-stall')).state).toBe('queued');
    });
  });

  it('says nothing about a run that has only just been created', async () => {
    await withPg(async t => {
      await seed(t, 'fresh', ['c1']);
      await t.query("update run set state = 'queued', heartbeat_at = null where id = $1",
        ['l-run-fresh']);
      expect(await stalledQueuedRuns(
        { db: dbOn(t), heartbeatMs: 1_000, eventRetentionDays: 7, attemptsMax: 3 })).toEqual([]);
    });
  });
});
