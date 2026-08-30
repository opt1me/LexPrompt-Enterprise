import {
  ModelError, findingsKeyFor, isCollectionTarget, uid,
  type PlaybookClause, type PlaybookVersion, type ReviewTarget, type RunCellCounts, type RunState, type RunView,
} from '@lexprompt/core';
import type { Db, Tx } from '../db/pool.ts';
import { appendEvent } from './events.ts';
import { ensureDispositions, setDisposition } from '../dispositions/service.ts';

/**
 * The queue: a run is a row, its work is one `run_cell` per unit, and
 * creating one does NOT execute it.
 *
 * §9: *"creates a `run` row and one `run_cell` per unit of work — document ×
 * clause for a standalone review, clause alone for a collection review — in
 * state `queued`, and returns immediately. The response is the run, not the
 * results."*
 *
 * ## The two state machines, and which one is authoritative
 *
 * §6.2 gives `finding.status` five values and §6.5 gives `run_cell.state`
 * five different ones, for the same cell, and the spec does not say which
 * governs. **The ruling: `run_cell.state` is the QUEUE'S and
 * `finding.status` is the READER'S, and the worker writes both in one
 * transaction.**
 *
 * They are not merged because they answer different questions —
 * `attempts`, `leased_by` and `lease_expires_at` are meaningless to a card,
 * and `summary`/`citations` are meaningless to a scheduler — and because a
 * finding outlives every run that touched it while a cell does not. A
 * `run_cell` in `done` whose `finding` is still `running` is a bug, and
 * `runLifecycle.pg.test.ts` asserts after every scenario that it cannot
 * happen.
 *
 * ## Every findings key comes through `findingsKeyFor`
 *
 * A collection review keys by the COLLECTION, however many documents fed it;
 * a document review keys by document. Six defects in sub-project C came from
 * code that keyed by document id directly, including a retry that overwrote
 * a synthesised net position with a one-document answer. Nothing in this
 * file writes a key any other way.
 */

export interface RunRow {
  id: string;
  review_id: string;
  workspace_id: string;
  state: RunState;
  requested_by_user_id: string;
  provider: string | null;
  model: string | null;
  jurisdiction: unknown;
  concurrency: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  heartbeat_at: Date | null;
  cancel_requested_at: Date | null;
  error: string | null;
  version: string | number;
}

export interface RunCellRow {
  run_id: string;
  findings_key: string;
  clause_id: string;
  workspace_id: string;
  state: 'queued' | 'leased' | 'done' | 'error' | 'cancelled';
  attempts: number;
  leased_by: string | null;
  lease_expires_at: Date | null;
  last_error: string | null;
}

/** A jsonb column arrives parsed from `pg`, but a path that did not parse it
 *  would hand back a string. Handled rather than assumed. */
function parsedJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** Present-or-absent, never `key: undefined` — `structuredClone` preserves
 *  an undefined-valued key and every `in` check downstream would read it as
 *  a value that is there. `db/rows.ts` argues this at length; this is the
 *  same rule, applied to a run. */
function absentUnless<K extends string, V>(
  key: K, value: V | null | undefined,
): Record<K, V> | Record<string, never> {
  return value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function fromRunRow(row: RunRow, cells: RunCellCounts): RunView {
  return {
    id: row.id,
    reviewId: row.review_id,
    state: row.state,
    requestedByUserId: row.requested_by_user_id,
    ...absentUnless('provider', row.provider),
    ...absentUnless('model', row.model),
    ...absentUnless('jurisdiction', parsedJson(row.jurisdiction) as never),
    concurrency: row.concurrency,
    createdAt: row.created_at.getTime(),
    ...absentUnless('startedAt', row.started_at?.getTime()),
    ...absentUnless('finishedAt', row.finished_at?.getTime()),
    ...absentUnless('heartbeatAt', row.heartbeat_at?.getTime()),
    ...absentUnless('cancelRequestedAt', row.cancel_requested_at?.getTime()),
    ...absentUnless('error', row.error),
    cells,
    version: Number(row.version),
  };
}

const NO_CELLS: RunCellCounts = {
  total: 0, queued: 0, leased: 0, done: 0, error: 0, cancelled: 0,
};

/**
 * How much of the run has actually happened, counted from the cells
 * themselves rather than tracked in a column.
 *
 * A counter column would have to be kept in step by every writer, and the
 * writer most likely to skip it is the one that crashed — which is exactly
 * the run whose progress a reader most needs to be true. Counting is cheap
 * (the primary key covers it) and cannot go stale.
 */
export async function cellCounts(
  t: Pick<Tx, 'query'>, runId: string, workspaceId: string,
): Promise<RunCellCounts> {
  const rows = await t.query<{ state: RunCellRow['state']; n: string }>(
    'select state, count(*)::text as n from run_cell where run_id = $1 and workspace_id = $2 '
    + 'group by state', [runId, workspaceId]);
  const counts = { ...NO_CELLS };
  for (const row of rows) {
    const n = Number(row.n);
    counts[row.state] += n;
    counts.total += n;
  }
  return counts;
}

/**
 * The clauses a review claims to check, read off its own SNAPSHOT.
 *
 * The snapshot and not the live playbook: `Review.playbookSnapshot` is a
 * deep copy for exactly this reason, and a run built from today's playbook
 * would answer a review whose header says "ran against v4" with v5's
 * clauses.
 *
 * A clause with no usable id is dropped rather than run: it could only key a
 * cell nothing reads. A snapshot where that leaves nothing at all is refused
 * by `createRun`, so the drop cannot become a silent empty run.
 */
export function clausesOf(snapshot: unknown): PlaybookClause[] {
  const version = snapshot as Partial<PlaybookVersion> | null;
  const clauses: unknown[] = Array.isArray(version?.clauses) ? version.clauses : [];
  return clauses.filter((c): c is PlaybookClause =>
    typeof c === 'object' && c !== null && typeof (c as { id?: unknown }).id === 'string'
    && (c as { id: string }).id !== '');
}

export interface CellKey { findingsKey: string; clauseId: string }

/**
 * Every unit of work this run will do.
 *
 * A collection review produces ONE cell per clause however many documents
 * feed it — that is what `findingsKeyFor` returning the collection id means,
 * and it is why `extractCollectionClause` exists as a separate function with
 * its own prompt. A document review produces document × clause.
 */
export function cellsFor(target: ReviewTarget, snapshot: unknown): CellKey[] {
  const clauses = clausesOf(snapshot);
  if (isCollectionTarget(target)) {
    const key = findingsKeyFor(target);
    return clauses.map(c => ({ findingsKey: key, clauseId: c.id }));
  }
  return target.documentIds.flatMap(documentId =>
    clauses.map(c => ({ findingsKey: findingsKeyFor(target, documentId), clauseId: c.id })));
}

export interface CreateRunInput {
  reviewId: string;
  matterId: string;
  target: ReviewTarget;
  playbookSnapshot: unknown;
}

export interface CreateRunActor { id: string; workspaceId: string }

/**
 * Creates the run, its cells and a `pending` finding for each — in ONE
 * transaction — and returns without executing anything.
 *
 * The `pending` findings are seeded here rather than by the worker for two
 * reasons. The reader has something to render the moment the POST returns,
 * so "queued" is a state on screen rather than an empty pane; and the
 * transition a card shows is then `pending -> running -> done`, in which a
 * cell that never ran is visibly distinct from one that ran and found
 * nothing. A findings pane that filled in only as answers arrived could not
 * tell "not started" from "started, silent".
 */
export async function createRun(
  t: Tx, review: CreateRunInput, actor: CreateRunActor, only?: CellKey[],
): Promise<RunView> {
  const ws = actor.workspaceId;
  // `only` is the per-clause RETRY (Task 16): the same run, the same cell
  // seeding, the same finding reset and the same `rerun_reset` disposition
  // clearing — over one cell instead of all of them.
  //
  // A parameter rather than a second function, deliberately. §9.1's retry
  // transaction is character for character what this one already does for a
  // whole review, and a second implementation of "re-running a clause clears
  // its verification and its net position, and records that it did" is
  // exactly the sibling drift this project has paid for six times. The
  // caller validates `only` against `cellsFor` before it gets here, so a key
  // this review's target does not explain cannot become a cell.
  const cells = only ?? cellsFor(review.target, review.playbookSnapshot);
  if (cells.length === 0) {
    // A run with nothing to do would sit `queued` forever with no cell for a
    // worker to lease and no reason on screen. Refused with the cause: a
    // playbook version with no clauses, or a target naming no document.
    throw new ModelError(
      'This review has nothing to run: its playbook snapshot names no clauses, or its target '
      + 'names no document. Nothing was started.', 'unknown', 400);
  }

  const concurrency = await snapshotConcurrency(t, ws);
  const runId = uid();

  await t.query(
    `insert into run (id, review_id, workspace_id, state, requested_by_user_id, concurrency)
     values ($1, $2, $3, 'queued', $4, $5)`,
    [runId, review.reviewId, ws, actor.id, concurrency]);

  // One statement for all the cells and one for all the findings, through
  // `unnest`. A per-cell round trip is forty statements for a forty-cell
  // run, inside a transaction, before the caller gets a response.
  const keys = cells.map(c => c.findingsKey);
  const clauseIds = cells.map(c => c.clauseId);
  await t.query(
    `insert into run_cell (run_id, findings_key, clause_id, workspace_id, state)
     select $1, k, c, $2, 'queued' from unnest($3::text[], $4::text[]) as a(k, c)`,
    [runId, ws, keys, clauseIds]);

  // `do update` and NOT `do nothing`: re-running a review must put every
  // cell back to `pending`, or a card left over from the last run would show
  // its old answer while the new run is in flight — an answer attributed to
  // a run that is not the one on screen.
  //
  // The disposition is reset with it, by `resetDispositions` below and in
  // this same transaction. Leaving it was tried and is wrong: the content
  // this row carries is about to be replaced, and a `finding_disposition`
  // still saying `verified` by A at yesterday's timestamp re-attaches a
  // person's judgement to text nobody has seen. That is `resetVerification`
  // — *"keeping the old verification would let an export claim a human
  // checked text they never saw"* — inverted, one layer down.
  await t.query(
    `insert into finding (review_id, findings_key, clause_id, workspace_id, status)
     select $1, k, c, $2, 'pending' from unnest($3::text[], $4::text[]) as a(k, c)
     on conflict (review_id, findings_key, clause_id) do update
       set status = 'pending', summary = null, risk_level = null, risk_analysis = null,
           error = null, auth_error = false, truncated = false, truncated_documents = null,
           no_content = false, position_outcome = null, position_rationale = null,
           citations = '[]'::jsonb, net_position = null,
           version = finding.version + 1, updated_at = now()
     where finding.workspace_id = $2`,
    [review.reviewId, ws, keys, clauseIds]);

  // THE `unchecked` ROW EVERY FINDING STARTS WITH (§6.3), seeded with the
  // finding itself.
  //
  // Found by driving the flip end to end against the live database, which
  // is the only place it could show: for the whole of Part 3A a
  // `finding_disposition` was created by the blob's shadow write
  // (`ensureDisposition`, inside `writeFindingRows`), so a review that had
  // ever been saved by a browser already had one. A run started through
  // `POST /v1/reviews/:id/runs` over a review whose findings map was empty
  // — which is exactly what Task 18's `handleStartRun` writes — seeded
  // `finding` rows and no dispositions at all, and the FIRST verification a
  // reviewer made on it answered *"There is no finding … to record a
  // judgement about."* A person clicking Verify on a finding plainly in
  // front of them, told it does not exist.
  //
  // `changed_count = 0`, actor NULL, instant NULL and NO event: nobody has
  // touched it, so there is nothing to attribute, and such a finding renders
  // as "Not checked" and names nobody. This creates the row a judgement can
  // later be recorded ON; it records no judgement.
  //
  // BEFORE `resetDispositions`, so a row created here is already `unchecked`
  // and is not swept by it — a reset event for a judgement nobody made would
  // be noise in the table 006 calls evidence.
  await ensureDispositions(t, review.reviewId, ws, keys, clauseIds);

  await resetDispositions(t, review.reviewId, ws, keys, clauseIds, actor);

  const row = (await t.query<RunRow>(
    'select * from run where id = $1 and workspace_id = $2', [runId, ws]))[0];
  const counts = await cellCounts(t, runId, ws);

  await appendEvent(t, {
    workspaceId: ws,
    type: 'run.started',
    reviewId: review.reviewId,
    runId,
    matterId: review.matterId,
    payload: {
      runId, reviewId: review.reviewId, cells: counts.total, version: Number(row.version),
    },
  });

  return fromRunRow(row, counts);
}

/**
 * RE-RUNNING A CLAUSE RESETS ITS VERIFICATION — the server's copy of the
 * rule `resetVerification` keeps in the browser, and the caller `rerun_reset`
 * was built for.
 *
 * `createRun` has just put every one of this run's findings back to
 * `pending` and blanked the model's answer. A `finding_disposition` left
 * alone then says a person verified an answer that no longer exists, and the
 * next export says a human checked text they never saw. CLAUDE.md calls that
 * rule load-bearing and mutation-tested in the browser; this is the same
 * rule one layer down, where the row outlives the blob.
 *
 * Three things make this the honest version of the reset rather than an
 * UPDATE that would do the job:
 *
 *  - It goes through `setDisposition`, the ONE writer of both tables, so the
 *    history row is written in the same transaction and cannot be forgotten.
 *  - Its cause is `rerun_reset`, not `human`. The engine did this, and
 *    `rerun_reset_only_unchecks` means the one write the system performs on
 *    its own behalf can only ever REMOVE a claim of human checking.
 *  - It touches only dispositions that are not already `unchecked`. A
 *    never-touched finding has no judgement to clear, and writing an event
 *    for one would fill the evidence table with rows saying nothing
 *    happened.
 *
 * Anything this leaves is a judgement about an answer that still exists: a
 * clause NOT in this run's cell set keeps its verification, because nothing
 * is replacing what it was made about.
 */
async function resetDispositions(
  t: Tx, reviewId: string, workspaceId: string,
  keys: string[], clauseIds: string[], actor: CreateRunActor,
): Promise<number> {
  const touched = await t.query<{
    findings_key: string; clause_id: string; version: string | number;
  }>(
    `select findings_key, clause_id, version from finding_disposition
      where review_id = $1 and workspace_id = $2 and state <> 'unchecked'
        and (findings_key, clause_id) in (
          select k, c from unnest($3::text[], $4::text[]) as a(k, c))`,
    [reviewId, workspaceId, keys, clauseIds]);

  const at = new Date();
  for (const row of touched) {
    await setDisposition(
      t,
      { reviewId, findingsKey: row.findings_key, clauseId: row.clause_id },
      { state: 'unchecked' },
      'rerun_reset',
      { id: actor.id, workspaceId },
      at,
      typeof row.version === 'number' ? row.version : Number(row.version));
  }
  return touched.length;
}

/**
 * The per-run bound, SNAPSHOTTED at creation (P26) from
 * `workspace_setting.concurrency` — the column Stage 2's ledger recorded as
 * "stored but not enforced". This is where it becomes real.
 *
 * Snapshotted for the reason `playbook_snapshot` is: an admin who lowers the
 * firm's concurrency at noon must not retroactively change the bound a run
 * started at eleven was executing under, and a run that read the live value
 * at lease time would change speed mid-flight for a reason nothing on screen
 * explains.
 *
 * Clamped to the column's own 1..32 check rather than refused: the setting
 * is an admin's, it is already validated where it is written, and a run is
 * the wrong place to discover that it is not. A workspace with no settings
 * row yet falls back to the table's own default of 5.
 */
async function snapshotConcurrency(t: Tx, workspaceId: string): Promise<number> {
  const rows = await t.query<{ concurrency: number }>(
    'select concurrency from workspace_setting where workspace_id = $1', [workspaceId]);
  const raw = rows[0]?.concurrency ?? 5;
  return Math.max(1, Math.min(32, Math.trunc(raw)));
}

/**
 * A run whose cells are all in a terminal state has ended, and this decides
 * WHICH ending — the one thing in this file that a reader's whole
 * understanding of a review rests on.
 *
 * Returns the state it settled the run into, or `null` when the run is still
 * live. Idempotent: it only ever moves a run out of `running`/`cancelling`,
 * so two workers finishing the last two cells at once cannot produce two
 * `run.finished` events.
 */
export async function settleRunIfFinished(
  t: Tx, runId: string, workspaceId: string,
): Promise<RunState | null> {
  const runs = await t.query<RunRow>(
    "select * from run where id = $1 and workspace_id = $2 and state in ('running','cancelling') "
    + 'for update', [runId, workspaceId]);
  const run = runs[0];
  if (!run) return null;

  const counts = await cellCounts(t, runId, workspaceId);
  const live = counts.queued + counts.leased;
  if (live > 0) return null;

  // `cancelled` when a person asked, `succeeded` otherwise. NOT "cancelled
  // if any cell is cancelled": a cell can be cancelled by the cancel path
  // alone, so the two agree — but the run's own `cancel_requested_at` is the
  // fact about what a person did, and reading the cells for it would infer a
  // human's intent from the engine's bookkeeping.
  const state: RunState = run.cancel_requested_at ? 'cancelled' : 'succeeded';
  const updated = await t.query<RunRow>(
    `update run set state = $3, finished_at = now(), version = version + 1
      where id = $1 and workspace_id = $2 and state in ('running','cancelling')
      returning *`,
    [runId, workspaceId, state]);
  if (!updated[0]) return null;

  await appendEvent(t, {
    workspaceId,
    type: 'run.finished',
    reviewId: run.review_id,
    runId,
    payload: {
      runId,
      reviewId: run.review_id,
      state,
      cells: counts.total,
      done: counts.done,
      errored: counts.error,
      cancelled: counts.cancelled,
      version: Number(updated[0].version),
    },
  });
  return state;
}

/** The run and its cell counts, for the read route and the tests. */
export async function readRun(
  db: Db, runId: string, workspaceId: string,
): Promise<RunView | null> {
  const rows = await db.query<RunRow>(
    'select * from run where id = $1 and workspace_id = $2', [runId, workspaceId]);
  if (!rows[0]) return null;
  return fromRunRow(rows[0], await cellCounts(db, runId, workspaceId));
}
