import type { AssignmentView, AssignmentsPage } from '@lexprompt/core';
import { apiGet, apiSend } from './client';

/**
 * ASKING A COLLEAGUE TO LOOK AT A CLAUSE, from the browser (§6.3, S17).
 *
 * Three calls and no cache. A cache here would be a second answer to "what
 * has been asked of me": the socket already pushes `assignment.created` and
 * `assignment.resolved`, and a module holding its own copy would have to
 * reconcile the two — the shape that produces a badge showing a request the
 * server closed ten minutes ago.
 *
 * REJECTS on failure and never resolves to an empty list. "Nobody has asked
 * me anything" and "the request failed" render identically once the second
 * has been flattened into the first, and what they render as is a person
 * missing a request a colleague is waiting on. `describeLoadError` turns the
 * rejection into a sentence, the same way every other load path does.
 *
 * NOTHING HERE ASSERTS AN ATTRIBUTION. The assigner is the token's actor,
 * server-side; there is no field on any of these calls that could name one,
 * for the reason `users.ts` gives about itself and the reason the disposition
 * route refuses a `byUserId` in a body.
 */

/** Asks `assigneeUserId` to look at one clause. The assigner is the signed-in
 *  caller, decided by the server. */
export async function createAssignment(
  reviewId: string, findingsKey: string, clauseId: string,
  assigneeUserId: string, message?: string,
): Promise<AssignmentView> {
  return apiSend<AssignmentView>(
    'POST',
    `/v1/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingsKey)}`
    + `/${encodeURIComponent(clauseId)}/assignments`,
    { assigneeUserId, ...(message === undefined ? {} : { message }) });
}

/** Closes one — by the person who was asked, or by the person who asked. The
 *  server refuses anybody else. */
export async function resolveAssignment(id: string): Promise<AssignmentView> {
  return apiSend<AssignmentView>(
    'POST', `/v1/assignments/${encodeURIComponent(id)}/resolve`, {});
}

/**
 * What has been asked of ME, open, within one review.
 *
 * Scoped to a review because that is the Stage 4 surface: the assignee sees
 * what has been asked of them within the review they are in. The firm-wide
 * "assigned to me" counter is Stage 5 (S18) — a different screen over the
 * same mechanism, not a different truth.
 */
export async function getOpenAssignments(reviewId?: string): Promise<AssignmentView[]> {
  const query = reviewId === undefined
    ? '?state=open' : `?state=open&review=${encodeURIComponent(reviewId)}`;
  const page = await apiGet<AssignmentsPage>(`/v1/assignments${query}`);
  return page.assignments;
}
