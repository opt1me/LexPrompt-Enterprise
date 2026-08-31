import React from 'react';
import type { AssignmentView } from '@lexprompt/core';
import type { DispositionAudience } from '../../lib/findingOutcome';

/** The one wording for a person the directory does not hold, matching the
 *  activity feed and the presence roster to the letter. Two wordings for one
 *  fact is how they come to disagree. */
const UNNAMED = 'Someone this workspace does not name';

export interface AssigneeChipProps {
  /** The OPEN request. A resolved one is not outstanding, and a chip for it
   *  would say somebody is looking at a clause nobody is looking at. */
  assignment: AssignmentView;
  /** How an id becomes a name and initials. The same `DispositionAudience`
   *  every attribution surface takes, so there is one resolver on this
   *  screen rather than one per component (P32). */
  audience?: DispositionAudience;
}

/**
 * SOMEBODY WAS ASKED TO LOOK AT THIS — AND A CHIP IS NOT A DISPOSITION
 * (S18, Stage 5 Task 3).
 *
 * ## The rule, which is `PresenceRoster`'s rule one step along
 *
 * A face on a clause means somebody is looking at it. This means somebody
 * was **asked to look** at it. Neither means anybody has **checked** it, and
 * a surface that could be read as "someone has verified this" when it means
 * "someone was asked to look" is the defect — in an app whose whole purpose
 * is keeping "a person decided this" apart from everything else.
 *
 * So, exactly as the roster does: no tick, no flag, no cross; no disposition
 * word anywhere in it; no state or outcome ink; and the meaning said in
 * WORDS rather than carried by a shape a reader has to learn. `Assigned` is
 * not used either — it reads as a status on the clause. *"asked to look at
 * this"* is what actually happened.
 *
 * ## It offers no control, and that is the Stage 4 lesson
 *
 * Stage 4's final review found a bystander shown *"You asked B. Trainee to
 * look at this"* with a live **Withdraw** button, for a request they had
 * nothing to do with — an affordance offering an action on another person's
 * act, which is R1 failing at the one surface Stage 4 added. This component
 * renders no button at all. The two people a request is between get the
 * richer block on the card, with the message and the one control each of
 * them may actually use; everybody else gets this.
 *
 * ## An id the directory does not hold
 *
 * Never a raw id, which says nothing to a reader while looking like it
 * should, and never "Unknown", which is a claim about a person made on the
 * strength of a failed fetch. *"Someone this workspace does not name"* — the
 * wording the activity feed, the roster and `dispositionLabel` already use.
 *
 * ## Every class string is COMPLETE
 *
 * Tailwind finds classes by scanning source text for whole literals; a
 * template-built name generates nothing at all, with no error and no failing
 * test. `--color-draft` is the informational hue this app already uses for
 * "a suggestion, not a judgement", and the card's own assignment block is
 * already drawn in it.
 */
export function AssigneeChip({ assignment, audience }: AssigneeChipProps) {
  const name = audience?.nameOf(assignment.assigneeUserId) ?? UNNAMED;
  const asker = audience?.nameOf(assignment.assignedByUserId);
  const initials = audience?.initialsOf(assignment.assigneeUserId);
  const sentence = asker === undefined
    ? `${name} was asked to look at this`
    : `${name} was asked to look at this, by ${asker}`;

  return (
    <span
      data-assignee-chip={assignment.id}
      className="inline-flex items-center gap-1 shrink-0 px-1.5 py-0.5 rounded-meter bg-draft-tint text-draft font-ui text-meta"
      title={sentence}
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center w-4 h-4 rounded-full font-mono text-pin uppercase leading-none"
      >
        {initials ?? '?'}
      </span>
      <span aria-hidden="true">asked to look</span>
      {/* The only text a screen reader gets, and it says what happened in a
          sentence. A bare set of initials beside a clause would be read as
          an attribution. */}
      {/* THE MESSAGE IS NOT HERE, and its absence is the point. What one
          person wrote to another about a clause is between the two of them;
          it is on the card for the assignee and for the assigner, and this
          chip is what everybody ELSE gets. Stage 4's final review found a
          bystander reading "B's brief" under a first-person line with a live
          Withdraw button — the line and the button are gone from this
          surface, and so is the brief. */}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

export interface ClauseAssigneesProps {
  /** The open requests on THIS clause. The caller filters; this renders what
   *  it is given. */
  assignments: AssignmentView[];
  audience?: DispositionAudience;
}

/**
 * THE MARKER ON A CLAUSE ROW OR A GRID CELL — the initials form.
 *
 * Deliberately the same vocabulary as `ClausePresence`, which is the shipped
 * answer to *"a marker on a clause that is not a state"*: one small mark,
 * one colour, one sentence, sitting BESIDE the status icon rather than in
 * place of it. The status icon says what the machine and a reviewer have
 * made of a clause; this says somebody has been asked to look. Two facts,
 * two marks, never one mark carrying both.
 *
 * NOTHING renders when nobody has been asked. A permanent empty marker is
 * one readers stop seeing, and it would take the non-empty case with it.
 */
export function ClauseAssignees({ assignments, audience }: ClauseAssigneesProps) {
  if (assignments.length === 0) return null;
  const names = assignments
    .map(a => audience?.nameOf(a.assigneeUserId) ?? UNNAMED)
    .join(', ');
  const sentence = assignments.length === 1
    ? `${names} was asked to look at this clause`
    : `${names} were asked to look at this clause`;
  return (
    <span
      data-assignees
      className="inline-flex items-center gap-0.5 shrink-0"
      title={sentence}
    >
      {assignments.map(a => (
        <span
          key={a.id}
          data-assignee={a.assigneeUserId}
          className="inline-flex items-center justify-center w-4 h-4 rounded-meter bg-draft-tint text-draft font-mono text-pin uppercase leading-none"
          aria-hidden="true"
        >
          {audience?.initialsOf(a.assigneeUserId)?.slice(0, 1) ?? '?'}
        </span>
      ))}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}
