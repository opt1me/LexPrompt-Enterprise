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

export interface VerificationChange {
  state: VerificationState;
  reason?: string;
}

/**
 * Every state can reach every other state — a reviewer who verified in error
 * must be able to flag it, and a rejection can be withdrawn. What is NOT
 * free-form is the shape of the result: attribution and timestamp are always
 * rewritten by the human action that caused the change, a reason is required
 * on `rejected` and dropped on everything else (a stale "wrong clause" left
 * hanging on a now-verified finding would read as if it still applied), and
 * `assigneeId` — which is about the clause, not this decision — survives.
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
  if (current.assigneeId !== undefined) next.assigneeId = current.assigneeId;
  return next;
}

/**
 * Clears a verification because the thing it was about has changed — the
 * clause was re-run and the finding is new content. Attribution, timestamp
 * and reason all go: they described a judgement about text that no longer
 * exists, and keeping them would let an export claim a human checked
 * something they never saw. This is the single most important rule in this
 * sub-project. `assigneeId` stays because it points at a clause, not at a
 * particular run's output.
 */
export function resetVerification(current: Verification): Verification {
  const next = unchecked();
  if (current.assigneeId !== undefined) next.assigneeId = current.assigneeId;
  return next;
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
