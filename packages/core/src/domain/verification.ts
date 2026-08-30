import type { Note, Verification, VerificationState } from './types.ts';

/** Thrown when a transition would produce an invalid `Verification` — today
 *  that means exactly one thing: a rejection with no reason. Thrown rather
 *  than returned so a caller cannot accidentally persist the invalid value
 *  by ignoring a result; the UI catches it and keeps the reason dialog open.
 */
export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

export function unchecked(): Verification {
  return { state: 'unchecked' };
}

/** Only `rejected` demands a reason. A flag says "look at this"; a rejection
 *  says "this is wrong", and the reader of an export needs to know why. */
export function requiresReason(state: VerificationState): boolean {
  return state === 'rejected';
}

/**
 * The reason that SURVIVES a move to `state` — `null` when the state does
 * not take one.
 *
 * `applyVerification` has dropped a reason on anything but `rejected` since
 * this module existed, and the server's `setDisposition` re-stated the same
 * rule as `requiresReason(state) && reason ? reason : null`. Two copies, and
 * a third place — the shadow writer's blob reader — kept the reason for
 * EVERY state and then compared its undropped value against the stored,
 * dropped one. That comparison could never be equal, so a flagged finding
 * carrying a reason wrote a fresh history row on every autosave: roughly one
 * every two seconds for the length of a run, into the INSERT-only evidence
 * table, burying the one real change.
 *
 * So the rule is a function now, and there is one of it. `null` rather than
 * `undefined` because both database columns are nullable and every caller
 * compares against a stored `reason` that is `null` when absent.
 */
export function effectiveReason(state: VerificationState, reason?: string): string | null {
  const trimmed = reason?.trim();
  return requiresReason(state) && trimmed ? trimmed : null;
}

export interface VerificationChange {
  state: VerificationState;
  reason?: string;
}

/**
 * Every state can reach every other state — a reviewer who verified in error
 * must be able to flag it, and a rejection can be withdrawn. What is NOT
 * free-form is the shape of the result: attribution and timestamp are always
 * rewritten by the human action that caused the change, and a reason is
 * required on `rejected` and dropped on everything else (a stale "wrong
 * clause" left hanging on a now-verified finding would read as if it still
 * applied).
 *
 * There used to be a third rule here — *"`assigneeId`, which is about the
 * clause and not this decision, survives"*. The field is gone (P24, Task
 * 22): it reached nobody, and an assignment is a record with an assigner, a
 * message and a resolution rather than a string carried on somebody else's
 * judgement.
 */
export function applyVerification(
  current: Verification,
  change: VerificationChange,
  byUserId: string,
  at: number,
): Verification {
  const reason = change.reason?.trim();

  if (requiresReason(change.state) && !reason) {
    throw new VerificationError('A rejected finding needs a reason.');
  }

  const next: Verification = { state: change.state, byUserId, at };
  if (requiresReason(change.state) && reason) next.reason = reason;
  return next;
}

/**
 * Clears a verification because the thing it was about has changed — the
 * clause was re-run and the finding is new content. Attribution, timestamp
 * and reason all go: they described a judgement about text that no longer
 * exists, and keeping them would let an export claim a human checked
 * something they never saw. This is the single most important rule in this
 * sub-project.
 *
 * It carried `assigneeId` across, on the grounds that an assignment points
 * at a clause rather than at a run's output. The field is gone (P24, Task
 * 22) and the parameter with it, so a reset is now the whole of
 * `unchecked()` and nothing else - which is what the sentence above always
 * described.
 */
export function resetVerification(): Verification {
  return unchecked();
}

/** The stable key identifying one finding across a review: a review holds
 *  `findings[documentId][clauseId]`, so neither id alone is unique. */
export function findingKey(documentId: string, clauseId: string): string {
  return `${documentId}::${clauseId}`;
}

export function makeNote(
  documentId: string,
  clauseId: string,
  text: string,
  byUserId: string,
  at: number,
  id: string,
): Note {
  return { id, findingId: findingKey(documentId, clauseId), text: text.trim(), byUserId, at };
}
