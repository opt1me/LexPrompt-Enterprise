import type {
  AssignmentInboxPage, AssignmentView, ReviewAssignments,
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

/*
 * `getOpenAssignments(reviewId)` USED TO BE HERE, and it is gone rather than
 * left standing beside `getReviewAssignments` below.
 *
 * It read `GET /v1/assignments?state=open&review=…` — the caller's own queue
 * within one review, both directions. `getReviewAssignments` is a strict
 * SUPERSET of that answer (every open request on the review, whoever was
 * asked) and every consumer already decides what to render from
 * `assignmentParty`, so keeping both would have been two client calls for
 * one screen's question, differing only in a filter one of them applies
 * server-side and the other applies twice. That is the sibling drift this
 * project has paid for six times, and the copy that stops being called is
 * always the one that quietly goes wrong.
 *
 * The `?review=` projection itself is unchanged and still served: Stage 4's
 * contract, pinned by `assignments.pg.test.ts` and
 * `assignmentReaches.compose.test.ts`.
 */

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

/**
 * EVERY OPEN REQUEST ON ONE REVIEW, WHOEVER WAS ASKED (Stage 5 Task 3).
 *
 * A different question from `getOpenAssignments`, and a different route. That
 * one answers the caller's own queue and always will; this one answers what
 * is outstanding on a review the caller can already read, INCLUDING requests
 * between two other people — which is the fact the assignee chip renders and
 * which a third reviewer otherwise has no way to learn at all.
 *
 * WHAT IT DOES NOT COME WITH IS AN ACTION. The server refuses anybody but
 * the assignee and the assigner at `resolve`, and the chip offers no
 * control: a bystander is told that somebody was asked, and nothing more.
 * Stage 4's fix round is why that sentence is worth writing down — a third
 * reviewer was being shown "You asked B. Trainee to look at this" with a
 * live Withdraw button.
 *
 * REJECTS on failure, like every call in this module, and never resolves to
 * an empty list.
 */
export async function getReviewAssignments(reviewId: string): Promise<AssignmentView[]> {
  const page = await apiGet<ReviewAssignments>(
    `/v1/reviews/${encodeURIComponent(reviewId)}/assignments`);
  return page.assignments;
}
