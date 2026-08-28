/**
 * The structural defence spec §11 names for sub-project F: how strongly a
 * proposed standard position is actually supported by a firm's own past
 * documents. Computed here, in code, over a plain list of yes/no votes —
 * never asked of the model. A model asked to rate its own confidence will
 * produce a plausible number under any evidence at all, and "how strongly is
 * this actually supported" is the number the whole feature's credibility
 * rests on, so it has to come from arithmetic a reader can check, not from
 * an opinion the same model that made the proposal also supplies.
 *
 * Pure arithmetic over the basis. No AI path, no I/O, no React — importing
 * anything from `openrouter.ts` here would reintroduce exactly the hazard
 * this module exists to keep out.
 */

/** One document's vote on a proposed position: did it support the position
 *  or oppose it (i.e. depart from it)? */
export interface BasisEntry {
  documentId: string;
  supports: boolean;
}

/**
 * `'consistent'` — every document in the basis agrees, and there is more
 *   than one of them. A house rule, not a coincidence.
 * `'mixed'` — the basis disagrees: at least one document supports and at
 *   least one opposes.
 * `'weak'` — everything else: a single document either way, or an empty
 *   basis. See `computeStrength` for why both collapse to `weak` rather than
 *   to `consistent`.
 */
export type PositionStrength = 'consistent' | 'mixed' | 'weak';

/**
 * The two rules the whole feature turns on, both refusals to overclaim:
 *
 * A single instance is `weak`, even when it supports the position. One
 * strike may have been a trade on that particular deal, not a policy —
 * `supporting === total` must never be tested before `total > 1`, because at
 * `1 === 1` (and at `0 === 0`, the empty-basis case below) it is true and
 * wrong. `total === 1` is checked first and unconditionally routes to
 * `weak`, whichever way that one document votes.
 *
 * An empty basis is `weak`, never `consistent`. Vacuous unanimity — "every
 * one of zero documents agrees" — is exactly the shape of "guessed from
 * silence," which this project treats as a defect wherever it appears (see
 * CLAUDE.md and spec §2's "never guess a position from silence"). `total ===
 * 0` is folded into the same `total <= 1` check as the single-instance rule,
 * for the same reason: neither has enough evidence to call anything a
 * policy.
 */
export function computeStrength(basis: BasisEntry[]): PositionStrength {
  const total = basis.length;
  if (total <= 1) return 'weak';

  const supporting = basis.filter(entry => entry.supports).length;
  if (supporting === total || supporting === 0) return 'consistent';
  return 'mixed';
}

/** Whether the basis actually disagrees with itself — at least one
 *  supporting entry and at least one opposing one. An empty or single-entry
 *  basis is not "contradicted": there is nothing in it to disagree. */
export function isContradicted(basis: BasisEntry[]): boolean {
  if (basis.length === 0) return false;
  const supporting = basis.filter(entry => entry.supports).length;
  return supporting > 0 && supporting < basis.length;
}

/**
 * The honest, human-readable form of a strength value — this is the only
 * place this wording lives, for the same reason `verificationLabel` is the
 * only place export wording lives (CLAUDE.md's sibling-drift rule): a
 * strength badge and an export line must not be able to say two different
 * things about the same basis.
 *
 * `weak` gets its own sentence for exactly the single-instance case (`total
 * === 1`) rather than an "n of m" count, because that is the one this whole
 * module exists to keep from reading like proof — "a single instance" says
 * outright what "1 of 1" would let a reader misread as unanimity. An empty
 * basis (`total === 0`) has no single instance to name, so it falls through
 * to the same "n of m" form as every other case — "0 of 0" is exactly as
 * honest about an empty basis as the number itself is.
 */
export function strengthLabel(strength: PositionStrength, supporting: number, total: number): string {
  // An empty basis is `weak`, but "0 of 0" reads as a ratio computed over
  // evidence — the same vacuous shape `computeStrength` refuses when it
  // declines to call an empty basis `consistent`, surfacing one layer up in
  // the words a reader actually sees. Say there is no evidence instead.
  if (total === 0) return 'Weak — no supporting documents yet';
  if (strength === 'weak' && total === 1) return 'Weak — a single instance';
  const label = strength === 'consistent' ? 'Consistent' : strength === 'mixed' ? 'Mixed' : 'Weak';
  return `${label} — ${supporting} of ${total}`;
}
