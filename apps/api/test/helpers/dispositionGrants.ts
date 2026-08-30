import { expect } from 'vitest';
import type { Db } from '../../src/db/pool.ts';

/**
 * "The worker holds no grant on either disposition table", as a pair of
 * assertions two suites need.
 *
 * Extracted at the SECOND copy rather than the third (`CLAUDE.md`; `uid()`
 * is the cautionary tale about waiting for the seventh).
 * `workerGrants.pg.test.ts` asks this because it is the file about grants;
 * `humanStateSurvives.pg.test.ts` asks it because it is the file that GATES
 * the deletion of `carryHumanState`, and a gate whose proof lives only in
 * another file is a gate somebody can remove without touching the gate.
 *
 * Two copies of the same eight statements would drift, and the way they
 * would drift is by losing one verb — which is precisely how this stage's
 * grant coverage came to be missing `finding_disposition` entirely until
 * Part 3A's review.
 *
 * Each function attempts EVERY verb. `select` is refused too, and that is
 * 006's ruling rather than an over-reach: the worker has no reason to read
 * a disposition, and a select grant is how a future "just check whether it
 * was verified before overwriting" gets written.
 */

export interface DispositionPlace {
  reviewId: string;
  findingsKey: string;
  clauseId: string;
  workspaceId: string;
  /** An `app_user` id, so the INSERT attempts are refused for the ROLE
   *  rather than for a foreign key that could never have been satisfied. */
  userId: string;
}

/** Every statement against `finding_disposition`, as `db`'s role, all refused. */
export async function refusesEveryDispositionStatement(
  db: Db, at: DispositionPlace,
): Promise<void> {
  const { reviewId, findingsKey, clauseId, workspaceId, userId } = at;
  await expect(db.query(
    'select state from finding_disposition where review_id = $1', [reviewId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query(
    `insert into finding_disposition
       (review_id, findings_key, clause_id, workspace_id, state, changed_count, by_user_id, at)
     values ($1, $2, $3, $4, 'verified', 1, $5, now())`,
    [reviewId, findingsKey, clauseId, workspaceId, userId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query(
    "update finding_disposition set state = 'verified' where review_id = $1", [reviewId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query(
    'delete from finding_disposition where review_id = $1', [reviewId]))
    .rejects.toThrow(/permission denied/i);
}

/** Every statement against `finding_disposition_event` — and the sequence
 *  behind its identity column, which is the door an INSERT would otherwise
 *  need (006's second REVOKE). */
export async function refusesEveryDispositionEventStatement(
  db: Db, at: DispositionPlace,
): Promise<void> {
  const { reviewId, findingsKey, clauseId, workspaceId, userId } = at;
  await expect(db.query(
    'select to_state from finding_disposition_event where review_id = $1', [reviewId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query(
    `insert into finding_disposition_event
       (review_id, findings_key, clause_id, workspace_id, from_state, to_state, cause,
        by_user_id, at)
     values ($1, $2, $3, $4, 'unchecked', 'verified', 'human', $5, now())`,
    [reviewId, findingsKey, clauseId, workspaceId, userId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query(
    'delete from finding_disposition_event where review_id = $1', [reviewId]))
    .rejects.toThrow(/permission denied/i);
  await expect(db.query("select nextval('finding_disposition_event_id_seq')"))
    .rejects.toThrow(/permission denied/i);
}
