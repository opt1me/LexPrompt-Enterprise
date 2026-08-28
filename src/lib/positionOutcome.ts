import type { PositionOutcome, StandardPosition } from '../types';

export const NO_RATIONALE_NOTE =
  'The model reported a deviation but gave no reason, so this is recorded as unclear.';

// Drift review, D1. The definition of what a `PositionOutcome` can be — not
// just this module's own classification of one — so `reviewMigration.ts`'s
// validation of a STORED value imports this rather than keeping its own
// byte-identical copy. A fourth outcome added here and not there would
// otherwise make the migration silently reject a value this module happily
// produces, or vice versa.
export const OUTCOMES: readonly PositionOutcome[] = ['meets', 'deviates', 'unclear'];

export interface PositionOutcomeFields {
  positionOutcome?: PositionOutcome;
  positionRationale?: string;
}

/**
 * The ONLY place a `positionOutcome` is produced. Three rules, each of which
 * exists because the alternative is a confident wrong answer:
 *
 *  - A missing or unrecognised outcome becomes `unclear`, NEVER `meets`.
 *    This mirrors `readStatus` in sub-project B's migration deliberately:
 *    the safe default is the one that prompts a human to look. A default of
 *    `meets` would let a clause nobody could evaluate report that the firm's
 *    house rule was satisfied.
 *  - `deviates` with no rationale becomes `unclear`, and says so. A
 *    deviation nobody can see the argument for is not actionable, and
 *    presenting it as one invites a lawyer to act on nothing. `meets` is NOT
 *    downgraded the same way: an unexplained agreement asserts nothing a
 *    reader would act on.
 *  - A clause with no standard position gets no outcome at all — the keys
 *    are absent, not `undefined`. `structuredClone` (how IndexedDB writes
 *    every record) preserves an `undefined`-valued key, so returning
 *    `{ positionOutcome: undefined }` would persist a key that reads as
 *    "there was a position" to anything doing an `in` check.
 */
export function normalisePositionOutcome(
  position: StandardPosition | undefined,
  rawOutcome: unknown,
  rawRationale: unknown,
): PositionOutcomeFields {
  if (!position) return {};

  const rationale = typeof rawRationale === 'string' && rawRationale.trim() !== ''
    ? rawRationale.trim()
    : undefined;

  // Case-insensitive for the same reason `extractClause` matches risk levels
  // that way: a mismatched case can only arrive via `parseJsonLoose`'s
  // fallback for models that don't honour the strict schema — exactly the
  // models most likely to emit 'DEVIATES'.
  const outcome = typeof rawOutcome === 'string'
    ? OUTCOMES.find(o => o === rawOutcome.toLowerCase())
    : undefined;

  if (outcome === 'deviates' && !rationale) {
    return { positionOutcome: 'unclear', positionRationale: NO_RATIONALE_NOTE };
  }
  if (!outcome) {
    return rationale
      ? { positionOutcome: 'unclear', positionRationale: rationale }
      : { positionOutcome: 'unclear' };
  }
  return rationale ? { positionOutcome: outcome, positionRationale: rationale } : { positionOutcome: outcome };
}
