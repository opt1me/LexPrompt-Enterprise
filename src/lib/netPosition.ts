import type { NetPosition, TrailStep } from '../types';

/** Thrown when a transition would produce an invalid `NetPosition` — today
 *  that means exactly one thing: an amendment with no text. Thrown rather
 *  than returned so a caller cannot accidentally persist the invalid value
 *  by ignoring a result; the UI catches it and keeps the amend dialog open.
 */
export class NetPositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetPositionError';
  }
}

/**
 * The only constructor, and it never takes a state — there is no way to
 * build a confirmed position without going through a human action
 * (`confirmPosition` or `amendPosition`), by construction rather than by
 * convention. Mirrors `unchecked()`: every net position starts here, for the
 * same reason every finding starts `unchecked` — it is a synthesis across
 * documents that no human has yet read, and must never be presented as if
 * one had.
 */
export function unconfirmedPosition(proposed: string, trail: TrailStep[]): NetPosition {
  return { proposed, state: 'unconfirmed', trail };
}

/**
 * A human read the model's synthesis and accepted it as written. Attribution
 * and timestamp are always rewritten by the action that caused the change —
 * the trail (the argument for the conclusion) survives untouched, because
 * confirming does not change what the documents were read to say, only that
 * a person has now looked.
 */
export function confirmPosition(current: NetPosition, byUserId: string, at: number): NetPosition {
  return { ...current, state: 'confirmed', byUserId, at };
}

/**
 * A human rewrote the position outright. `state` becomes `confirmed` because
 * a human wrote the text — an amended position is a STRONGER claim than a
 * merely confirmed one, not a weaker one. `proposed` is kept (not
 * overwritten) so the trail can show what changed between the model's
 * synthesis and the human's correction. An empty amendment is rejected the
 * way `applyVerification` rejects a reasonless rejection: thrown, so a
 * caller cannot persist the invalid value by ignoring a result.
 */
export function amendPosition(
  current: NetPosition,
  text: string,
  byUserId: string,
  at: number,
): NetPosition {
  const amended = text.trim();
  if (!amended) {
    throw new NetPositionError('An amended position needs text.');
  }
  return { ...current, amended, state: 'confirmed', byUserId, at };
}

/**
 * Clears confirmation because the thing it was about has changed — the
 * clause was re-derived and the proposed text is new content. Drops
 * `amended` as well as the confirmation: the amendment described a human's
 * synthesis of documents against output that has now been replaced, and
 * keeping it would let a report present that person's words as describing
 * text they never saw. Same rule as `resetVerification`, for the same
 * reason. `at` is dropped entirely rather than set to `undefined` —
 * `structuredClone` (how IndexedDB writes every record) preserves an
 * `undefined`-valued key, so leaving it in any form would still read as
 * "was confirmed at some point".
 */
export function resetPosition(current: NetPosition): NetPosition {
  const { proposed, trail } = current;
  return { proposed, state: 'unconfirmed', trail };
}

/** The text a reader should see: the human's amendment if there is one,
 *  otherwise the model's proposal. Mirrors the ordering `NetPosition.amended`
 *  documents — an amendment is a stronger claim than the proposal it
 *  replaces, so it always wins. */
export function positionText(position: NetPosition): string {
  return position.amended ?? position.proposed;
}
