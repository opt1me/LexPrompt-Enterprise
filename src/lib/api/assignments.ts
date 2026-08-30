import type {
  AssignmentInboxPage, AssignmentView, AssignmentsPage,
} from '@lexprompt/core';
import { apiGet, apiSend } from './client';

/**
 * ASKING A COLLEAGUE TO LOOK AT A CLAUSE, from the browser (§6.3, S17).
 *
 * Four calls and no cache. A cache here would be a second answer to "what
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
 * The open requests I AM A PARTY TO — asked of me, and made by me — within
 * one review.
 *
 * BOTH DIRECTIONS, because this is the only read there is. A request the
 * caller made used to exist in this tab's memory and nowhere else, so it
 * disappeared on reload along with its "Withdraw the request" control, while
 * the assignee went on seeing it open. It is a third party who is told
 * nothing, which the server enforces and `assignmentParty` mirrors on the
 * push.
 *
 * Scoped to a review because that is the Stage 4 surface. The firm-wide
 * "assigned to me" counter is Stage 5 (S18) — a different screen over the
 * same mechanism, not a different truth.
 */
export async function getOpenAssignments(reviewId: string): Promise<AssignmentView[]> {
  const page = await apiGet<AssignmentsPage>(
    `/v1/assignments?state=open&review=${encodeURIComponent(reviewId)}`);
  return page.assignments;
}

/**
 * EVERY OPEN REQUEST ADDRESSED TO ME, ACROSS EVERY MATTER (Stage 5, S18).
 *
 * The same route with no `review`, which is a DIFFERENT projection and not
 * merely a wider one: it answers `AssignmentInboxPage`, carrying the matter,
 * the review's name and the clause's title resolved server-side, because a
 * cross-matter list rendered from ids alone is three opaque strings.
 *
 * ONLY WHAT WAS ASKED OF ME. The review-scoped call above answers both
 * directions -- a request you made is your own act, and the review screen
 * offers you a Withdraw control for it -- and this one does not, because a
 * count of "assigned to me" that included what you asked of others would
 * tell you that you owe somebody an answer you do not owe.
 *
 * NO CACHE, REJECTS ON FAILURE, and NEVER resolves to an empty page. A count
 * of zero because a fetch failed is a lawyer not doing something a colleague
 * is waiting on, and it looks exactly like a quiet week -- `assignedToMe.ts`
 * is what keeps those two states apart on screen.
 *
 * `reviewId` above is REQUIRED, and was optional before this call existed:
 * the same URL with no `review` now answers a different shape, so a caller
 * omitting it would have received a page with no `assignments` key at all
 * and read it as an empty list. A compile error is the honest form of that.
 */
export async function getMyInbox(): Promise<AssignmentInboxPage> {
  return apiGet<AssignmentInboxPage>('/v1/assignments?state=open');
}
