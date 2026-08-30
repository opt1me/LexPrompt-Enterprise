import type { Tx } from '../db/pool.ts';
import type { AuditAction } from './actions.ts';

/**
 * THE ONE WRITER OF `audit_event`, anywhere in this codebase (§6.5, S11).
 *
 * ## It takes a `Tx`, and that is the whole design
 *
 * `appendEvent` (`run/events.ts`) takes one for the same reason and the two
 * live side by side so the next reader sees the pattern rather than
 * inventing a second one: an audit row committed while the act it records
 * rolled back is a log that says something happened which did not. That is
 * the confidently-wrong failure mode this project is organised around,
 * arriving in the one place a firm would treat as evidence.
 *
 * A `Db` parameter would let a caller write outside the act's transaction by
 * accident, with nothing failing. `Tx` makes the correct call the only one
 * that compiles.
 *
 * ## It never fails quietly
 *
 * There is no try/catch here and there must not be one. An audit write that
 * swallows its own failure gives back a log that is silently incomplete, and
 * an incomplete audit log is worse than none because it looks complete —
 * the same argument the CSV blank-cell defect made. A failure rolls the
 * whole act back, which is the honest outcome: the act did not happen, and
 * the record agrees.
 *
 * ## The instant is the DATABASE's
 *
 * `at` defaults to `now()` and is not a parameter. Unlike a disposition —
 * where the instant is when a person decided, which can precede the write by
 * minutes — an audited act IS the write; there is no earlier moment for it
 * to have happened at, and a caller able to state one could backdate the
 * record.
 *
 * ## What must never be audited here
 *
 * A disposition change. S22, and `actions.ts` carries the reasoning: it is
 * recorded once, in `finding_disposition_event`, because two append-only
 * records of one fact is how a card and an export come to disagree.
 */
export interface AuditEntry {
  workspaceId: string;
  actorUserId: string;
  action: AuditAction;
  subjectType: string;
  subjectId: string;
  matterId?: string;
  reviewId?: string;
  detail?: Record<string, unknown>;
}

export async function appendAudit(t: Tx, e: AuditEntry): Promise<void> {
  await t.query(
    `insert into audit_event
       (workspace_id, actor_user_id, action, subject_type, subject_id, matter_id, review_id,
        detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [e.workspaceId, e.actorUserId, e.action, e.subjectType, e.subjectId,
      e.matterId ?? null, e.reviewId ?? null, JSON.stringify(e.detail ?? {})]);
}
