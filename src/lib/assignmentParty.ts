import type { AssignmentView } from '@lexprompt/core';

/**
 * WHICH OF THE THREE PEOPLE A READER IS, in front of one request.
 *
 * `POST …/assignments` writes a REVIEW-SCOPED event, so the push reaches
 * every socket subscribed to that review — correctly, since the socket has
 * no per-recipient filter and must not grow one. That leaves the browser
 * holding requests between two OTHER people, and the card that renders them
 * was a binary: assignee, or "you asked". A third reviewer with the review
 * open was therefore told *"You asked B. Trainee to look at this"*, with B's
 * brief beneath it and a live **Withdraw the request** button, for a request
 * they had nothing to do with — an affordance offering an action on another
 * person's act, which is the R1 rule ("do not add an affordance implying
 * collaboration the app cannot deliver") failing at the one surface Stage 4
 * added.
 *
 * There are THREE cases and the binary was the bug: mine to give, mine to
 * answer, and neither. This is the one place that decision is made — the
 * clause bucketing in `ResultsView` and the render in `FindingCard` both
 * read it, rather than each writing its own comparison and drifting.
 *
 * ## An unknown reader is a BYSTANDER, never a party
 *
 * `localUserId` is `profile?.id ?? ''` until `GET /v1/me` answers. An empty
 * id matches nobody here, deliberately: before the profile resolves this tab
 * does not know who it belongs to, and a card that renders nothing for a
 * frame is the honest outcome — where the old binary made the REAL assignee's
 * own card read "You asked B. Trainee to look at this" during exactly that
 * window, because `mine` was false and the `else` branch claimed authorship.
 */
export type AssignmentParty = 'assignee' | 'assigner' | 'bystander';

export function assignmentParty(
  assignment: Pick<AssignmentView, 'assigneeUserId' | 'assignedByUserId'>,
  localUserId: string | undefined,
): AssignmentParty {
  if (!localUserId) return 'bystander';
  if (assignment.assigneeUserId === localUserId) return 'assignee';
  if (assignment.assignedByUserId === localUserId) return 'assigner';
  return 'bystander';
}

/** Whether this reader is one of the two people a request is between. The
 *  same set `GET /v1/assignments` returns, so what a card shows live is what
 *  it shows after a reload. */
export function isPartyTo(
  assignment: Pick<AssignmentView, 'assigneeUserId' | 'assignedByUserId'>,
  localUserId: string | undefined,
): boolean {
  return assignmentParty(assignment, localUserId) !== 'bystander';
}
