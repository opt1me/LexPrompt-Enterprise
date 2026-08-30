import type { Db } from '../db/pool.ts';
import { appendEvent, pruneEvents } from './events.ts';
import { failRunCells } from './lifecycle.ts';
import { cellCounts, type RunRow } from './queue.ts';

/**
 * The reaper: A RUN THAT DIED MUST NOT LOOK FINISHED — and must not look
 * alive either.
 *
 * `CLAUDE.md` lists *"an abandoned run reopening with every cell spinning
 * forever, unfinishable"* among the defects this project has already
 * shipped. This is the thing that makes that unrepeatable. A worker holds a
 * lease and beats a heartbeat; if the process is killed, both stop, and
 * nothing else in the system would ever notice — the run stays `running`,
 * its cells stay `leased`, and every card renders a spinner with no worker
 * that will ever answer it.
 *
 * ## Three intervals, and why a queued run is not reaped
 *
 * A run whose `heartbeat_at` is older than three `API_RUN_HEARTBEAT_MS`
 * intervals becomes `failed`. THREE, so a single missed tick — a slow
 * transaction, a garbage-collection pause, a database hiccup — does not kill
 * a healthy run.
 *
 * **A run that has never started has no heartbeat and is not reaped.** A
 * `queued` run with no worker (the pool is busy, or the API restarted before
 * it started one) must not be marked failed for waiting: that is the
 * difference between a busy queue and a broken one, and getting it wrong
 * would turn every burst of work into a wall of failures. The predicate is
 * on `state in ('running','cancelling')`, which is exactly the set of runs a
 * worker has touched — and `run_live_idx` is the partial index over it.
 *
 * ## `failed`, never `cancelled`
 *
 * Nobody cancelled a reaped run. Its cells become `error` carrying the
 * reason, not `cancelled`, because `cancelled` would tell a reviewer that a
 * person made a decision that no person made.
 */

export interface ReaperDeps {
  /** The APP connection. The reaper sweeps `event` (delete) and writes
   *  findings; the worker role holds no delete grant on `event` and should
   *  not. */
  db: Db;
  heartbeatMs: number;
  eventRetentionDays: number;
  attemptsMax: number;
}

export interface ReaperHandle { stop(): Promise<void> }

/** How many heartbeat intervals a run may miss before it is presumed dead.
 *  Declared rather than inlined: it is the difference between a hiccup and a
 *  death, and it is not a number to discover in a WHERE clause. */
export const MISSED_HEARTBEATS_BEFORE_DEAD = 3;

/**
 * One sweep. Returns what it did, because a sweeper that says nothing is one
 * nobody can tell from a sweeper that is not running.
 */
export async function reapOnce(deps: ReaperDeps): Promise<{
  reaped: string[]; exhausted: number; pruned: number;
}> {
  const reaped = await reapDeadRuns(deps);
  const exhausted = await exhaustSpentCells(deps);
  const pruned = await pruneEvents(deps.db, deps.eventRetentionDays);
  return { reaped, exhausted, pruned };
}

async function reapDeadRuns(deps: ReaperDeps): Promise<string[]> {
  const staleMs = deps.heartbeatMs * MISSED_HEARTBEATS_BEFORE_DEAD;
  const dead = await deps.db.query<RunRow>(
    `select * from run
      where state in ('running','cancelling')
        and heartbeat_at is not null
        and heartbeat_at < now() - ($1 || ' milliseconds')::interval`,
    [String(staleMs)]);

  const reaped: string[] = [];
  for (const run of dead) {
    // One transaction PER RUN, and re-checked inside it. Two API replicas
    // both run a reaper; without the re-read they would both sweep the same
    // run and append two `run.finished` events for it, and a client that
    // applies the second would render a finished run twice.
    const settled = await deps.db.tx(async t => {
      const rows = await t.query<RunRow>(
        `select * from run
          where id = $1 and state in ('running','cancelling')
            and heartbeat_at < now() - ($2 || ' milliseconds')::interval
          for update`, [run.id, String(staleMs)]);
      if (!rows[0]) return false;
      const current = rows[0];
      const since = current.heartbeat_at?.toISOString() ?? 'it started';
      const message = 'This run stopped without finishing. No worker has reported on it since '
        + `${since}.`;

      await failRunCells(t, current.id, current.review_id, current.workspace_id, message);
      const updated = await t.query<RunRow>(
        `update run set state = 'failed', finished_at = now(), error = $2,
                        version = version + 1
          where id = $1 returning *`, [current.id, message]);
      const counts = await cellCounts(t, current.id, current.workspace_id);
      await appendEvent(t, {
        workspaceId: current.workspace_id,
        type: 'run.finished',
        reviewId: current.review_id,
        runId: current.id,
        payload: {
          runId: current.id,
          reviewId: current.review_id,
          state: 'failed',
          cells: counts.total,
          done: counts.done,
          errored: counts.error,
          cancelled: counts.cancelled,
          error: message,
          version: Number(updated[0].version),
        },
      });
      return true;
    });
    if (settled) reaped.push(run.id);
  }
  return reaped;
}

/**
 * A cell that has spent every attempt and is still holding an expired lease.
 *
 * §9: *"`attempts` is bounded (3); a cell that exhausts them becomes `error`
 * carrying its last error text, which is a finding a person can retry by
 * hand — not a cell that quietly never finishes."*
 *
 * Without this the cell is unreachable: the claim query requires `attempts <
 * max`, so nothing will ever lease it again, its run's `queued + leased`
 * count never reaches zero, and `settleRunIfFinished` never settles it. The
 * run would sit `running` with a live heartbeat — the one state the reaper's
 * own rule says is NOT stuck — forever. It is the exact defect this task is
 * named after, arriving through the door the retry bound left open.
 */
async function exhaustSpentCells(deps: ReaperDeps): Promise<number> {
  const spent = await deps.db.query<{
    run_id: string; findings_key: string; clause_id: string; workspace_id: string;
    last_error: string | null; review_id: string;
  }>(
    `select c.run_id, c.findings_key, c.clause_id, c.workspace_id, c.last_error, r.review_id
       from run_cell c join run r on r.id = c.run_id
      where c.state = 'leased' and c.lease_expires_at < now() and c.attempts >= $1
        and r.state in ('running','cancelling')`,
    [deps.attemptsMax]);

  for (const cell of spent) {
    const reason = cell.last_error
      ? `${cell.last_error} (tried ${deps.attemptsMax} times)`
      : `This clause was attempted ${deps.attemptsMax} times and never finished. The worker `
        + 'stopped each time without reporting why. Retry it by hand once the run is over.';
    await deps.db.tx(async t => {
      await t.query(
        `update run_cell set state = 'error', last_error = $4, leased_by = null,
                             lease_expires_at = null
          where run_id = $1 and findings_key = $2 and clause_id = $3 and state = 'leased'`,
        [cell.run_id, cell.findings_key, cell.clause_id, reason]);
      await t.query(
        `update finding set status = 'error', error = $4, version = version + 1,
                            updated_at = now()
          where review_id = $1 and findings_key = $2 and clause_id = $3
            and status in ('pending','running')`,
        [cell.review_id, cell.findings_key, cell.clause_id, reason]);
    });
  }
  return spent.length;
}

/**
 * The loop. `stop()` waits for the sweep in flight so a shutdown never
 * leaves a half-written run.
 */
export function startReaper(deps: ReaperDeps): ReaperHandle {
  let running = true;
  let inFlight: Promise<unknown> = Promise.resolve();

  const timer = setInterval(() => {
    if (!running) return;
    inFlight = reapOnce(deps).then(result => {
      if (result.reaped.length > 0) {
        process.stderr.write(
          `api: reaper marked ${result.reaped.length} run(s) failed — no worker had reported on `
          + `them for ${deps.heartbeatMs * MISSED_HEARTBEATS_BEFORE_DEAD}ms: `
          + `${result.reaped.join(', ')}\n`);
      }
      if (result.exhausted > 0) {
        process.stderr.write(
          `api: reaper closed ${result.exhausted} cell(s) that had spent every attempt\n`);
      }
    }).catch((error: Error) => {
      // The reaper failing silently is the failure it exists to prevent, one
      // level up: nothing else in this system notices a dead run.
      process.stderr.write(`api: reaper sweep failed: ${error.message}\n`);
    });
  }, deps.heartbeatMs);
  timer.unref?.();

  return {
    async stop() {
      running = false;
      clearInterval(timer);
      await inFlight;
    },
  };
}
