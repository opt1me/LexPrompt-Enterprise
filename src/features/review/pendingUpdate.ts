import type { DispositionWithHistory } from '@lexprompt/core';

/**
 * WHETHER SOMEBODY ELSE'S CHANGE MAY BE PUT ON SCREEN RIGHT NOW, OR MUST BE
 * HELD AND ANNOUNCED (P36).
 *
 * ## The rule this exists for, and why it is not covered by await-then-apply
 *
 * `CLAUDE.md`: *"the reviewer must never see a state the store did not
 * actually take"*. That rule is about a state the store REFUSED being shown
 * as though it landed. This is the inverse, and live change is what
 * introduces it: a state the store genuinely DID take, swapped in under a
 * person's hand while they are deciding about the state it replaced.
 *
 * A partner's rejection landing while the trainee is three words into a
 * reject reason is not a lie about the database — it is worse, because the
 * person then submits a judgement about text that has moved. The symptom is
 * nothing: no error, no flicker anyone would name, and a history row that
 * reads as a considered second opinion.
 *
 * ## Two conditions, and only two
 *
 * A disposition write is in flight for THIS finding, or a control that
 * composes a disposition for THIS finding is open. Not "any modal", not
 * "the window is unfocused", not "the user typed recently" — a guard broader
 * than its reason becomes a guard nobody can reason about, and the default
 * has to stay "apply immediately" or the app feels broken in a way that is a
 * second, quieter defect.
 *
 * ## Pure, and in its own file
 *
 * Part 4A's poll path calls this and Part 4B's socket path (Task 21) calls
 * the same function. Two copies of "may I apply this now?" would be the
 * sibling-drift rule broken on the one decision that decides whether a
 * lawyer sees a state change.
 */
export interface ApplyGate {
  /** The finding a disposition write is in flight for, as
   *  `findingKey(docId, clauseId)` — `App.tsx`'s `verifyBusyKey`. */
  busyKey: string | null;
  /** The finding a disposition-composing control is open for. The reject
   *  reason dialog is the only one today; a second one joins it here rather
   *  than growing a second gate. */
  openModalKey: string | null;
  /** The finding being asked about. */
  findingKey: string;
}

export function mayApplyNow({ busyKey, openModalKey, findingKey }: ApplyGate): boolean {
  if (busyKey === findingKey) return false;
  if (openModalKey === findingKey) return false;
  return true;
}

/** An incoming change that arrived at a moment it could not be applied. */
export interface HeldUpdate {
  findingKey: string;
  incoming: DispositionWithHistory;
}

/**
 * Whether two dispositions describe the SAME row at the same moment.
 *
 * By `version`, not by object identity — and that is the whole point of this
 * function. `rememberDispositions` replaces a review's whole map on every
 * read, so every poll hands the card a structurally identical but
 * referentially new object. A card comparing identity would announce
 * *"R. Okafor changed this while you were writing"* every few seconds at a
 * reviewer who is simply typing, about a change nobody made.
 *
 * `version` is exactly the fact that answers this: `finding_disposition`
 * increments it on every change and on nothing else, which is the same
 * property the write's own optimistic-concurrency guard rests on.
 *
 * The KEY is compared too. A card re-rendered for a different cell (the
 * grid's detail panel does this without remounting) is not looking at a
 * changed disposition, it is looking at a different finding — and holding
 * one cell's row back because another cell's modal is open would be a hold
 * with no reader.
 */
export function sameDisposition(
  a: DispositionWithHistory | undefined, b: DispositionWithHistory | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.disposition.reviewId === b.disposition.reviewId
    && a.disposition.findingsKey === b.disposition.findingsKey
    && a.disposition.clauseId === b.disposition.clauseId
    && a.disposition.version === b.disposition.version;
}

/** Whether two dispositions are about the same cell at all. */
export function sameCell(
  a: DispositionWithHistory | undefined, b: DispositionWithHistory | undefined,
): boolean {
  if (!a || !b) return false;
  return a.disposition.reviewId === b.disposition.reviewId
    && a.disposition.findingsKey === b.disposition.findingsKey
    && a.disposition.clauseId === b.disposition.clauseId;
}
