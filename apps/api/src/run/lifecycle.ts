import type { Tx } from '../db/pool.ts';

/**
 * The terminal transitions a run's leftovers go through, in ONE place.
 *
 * Three callers need them — the cancel route, the worker releasing the last
 * lease, and the reaper — and this project's most repeated defect is two
 * implementations of one idea drifting apart. The distinction they must all
 * keep is the one Task 11's table is about:
 *
 *   cancelled  a person asked. Not a failure. What completed stays.
 *   error      nobody asked. The run stopped, and the message says why.
 *
 * A cell left `queued` by a cancelled run becomes `cancelled`; the identical
 * cell left by a REAPED run becomes `error`, because nobody cancelled it and
 * calling it cancelled would tell a reviewer a decision was made that was
 * not. That is the whole reason these are two functions and not one with a
 * flag.
 *
 * ## A `done` cell is never rewritten
 *
 * Both statements below name the states they may touch. A cancelled run is
 * real, partial work: a reviewer is entitled to the twelve findings it
 * produced, and a sweep that reset them to "cancelled" would destroy answers
 * a person may already have read and verified.
 */

/** The states a finding may be moved OUT of by a sweep. Anything else is an
 *  answer, and an answer is not a sweep's to overwrite. */
const OPEN_FINDING_STATES = ['pending', 'running'];

/**
 * A cancelled run's leftovers.
 *
 * `queued` cells become `cancelled` immediately. `leased` cells are LEFT to
 * the worker holding them — it checks `cancel_requested_at` between cells,
 * aborts the call in flight, and releases the cell itself. Sweeping a leased
 * cell here would declare finished a cell whose worker is still mid-write,
 * and the write would then land on a run the reader has been told is over.
 */
export async function cancelPendingCells(
  t: Tx, runId: string, reviewId: string, workspaceId: string,
): Promise<number> {
  const cells = await t.query<{ findings_key: string; clause_id: string }>(
    `update run_cell set state = 'cancelled', leased_by = null, lease_expires_at = null
      where run_id = $1 and workspace_id = $2 and state = 'queued'
      returning findings_key, clause_id`,
    [runId, workspaceId]);
  if (cells.length === 0) return 0;

  await t.query(
    `update finding set status = 'cancelled', version = version + 1, updated_at = now()
      where review_id = $1 and workspace_id = $2
        and status = any($5::text[])
        and (findings_key, clause_id) in (
          select k, c from unnest($3::text[], $4::text[]) as a(k, c))`,
    [reviewId, workspaceId, cells.map(c => c.findings_key), cells.map(c => c.clause_id),
      OPEN_FINDING_STATES]);
  return cells.length;
}

/**
 * A reaped run's leftovers: `error`, NOT `cancelled`, carrying the reason.
 *
 * Both `queued` and `leased` cells are swept here, and the leased ones are
 * the point: a lease that has expired means the worker holding it is gone.
 * Leaving them `leased` is exactly the shipped defect this whole task exists
 * to prevent — a run reopening with every cell spinning forever, with no
 * worker that will ever finish them and nothing on screen that says so.
 *
 * The message goes onto the FINDING as well as onto the cell, because the
 * finding is what a card renders. A reviewer looking at the clause sees why
 * it has no answer, in the same place an extraction error would appear.
 */
export async function failRunCells(
  t: Tx, runId: string, reviewId: string, workspaceId: string, message: string,
): Promise<number> {
  const cells = await t.query<{ findings_key: string; clause_id: string }>(
    `update run_cell set state = 'error', last_error = $3, leased_by = null,
                         lease_expires_at = null
      where run_id = $1 and workspace_id = $2 and state in ('queued','leased')
      returning findings_key, clause_id`,
    [runId, workspaceId, message]);
  if (cells.length === 0) return 0;

  await t.query(
    `update finding set status = 'error', error = $6, version = version + 1, updated_at = now()
      where review_id = $1 and workspace_id = $2
        and status = any($5::text[])
        and (findings_key, clause_id) in (
          select k, c from unnest($3::text[], $4::text[]) as a(k, c))`,
    [reviewId, workspaceId, cells.map(c => c.findings_key), cells.map(c => c.clause_id),
      OPEN_FINDING_STATES, message]);
  return cells.length;
}

/**
 * One cell that has run out of attempts.
 *
 * §9: *"`attempts` is bounded (3); a cell that exhausts them becomes `error`
 * carrying its last error text, which is a finding a person can retry by
 * hand — not a cell that quietly never finishes."* The last error text is
 * the one the extractor produced, and it reaches the card exactly as an
 * extraction error does today.
 */
export async function exhaustCell(
  t: Tx,
  key: { runId: string; reviewId: string; findingsKey: string; clauseId: string },
  workspaceId: string,
  message: string,
): Promise<void> {
  await t.query(
    `update run_cell set state = 'error', last_error = $4, leased_by = null,
                         lease_expires_at = null
      where run_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $5`,
    [key.runId, key.findingsKey, key.clauseId, message, workspaceId]);
  await t.query(
    `update finding set status = 'error', error = $4, version = version + 1, updated_at = now()
      where review_id = $1 and findings_key = $2 and clause_id = $3 and workspace_id = $5`,
    [key.reviewId, key.findingsKey, key.clauseId, message, workspaceId]);
}
