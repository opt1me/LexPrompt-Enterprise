import type { Finding } from '../types';

/**
 * How well-tested a firm's standard position is, derived at read time from
 * the findings that ran against it — see spec §7. Never stored: storing it
 * would let the summary drift from the evidence it claims to describe.
 *
 * A discriminated union rather than one shape with optional fields, so a
 * caller cannot read `supporting`/`total` off a `conceded` or `untested`
 * result and get `undefined` silently — the kind you have determines the
 * fields that exist.
 */
export type PositionHealth =
  | { kind: 'held'; supporting: number; total: number }
  | { kind: 'conceded'; count: number }
  | { kind: 'untested' }
  | { kind: 'no-position' };

export interface PositionHealthOptions {
  /** False when the clause carries no `StandardPosition` at all — "no house
   *  rule here" is a different fact from "we have one and it's untested",
   *  and this is the only way to tell the two apart: a clause with no
   *  position also has no `positionOutcome` on any of its findings, so the
   *  finding evidence alone can't distinguish it from `untested`. Defaults
   *  to `true` so a caller that already knows the clause has a position
   *  doesn't have to say so. */
  hasPosition?: boolean;
}

/**
 * `publishedAt` is the playbook *version* the clause's standard position
 * was published in — `findings` is whatever the caller already loaded (one
 * review's findings, or several stitched together across matters). This is
 * a pure function over that array (ruling R-D2): it never reads the store,
 * which is what keeps it testable and keeps IO out of a render path.
 *
 * Only `verified` findings count, and only ones verified at or after
 * `publishedAt` — a verification made against an earlier wording of the
 * position says nothing about the current one (the standard position can
 * be edited and republished without touching old reviews). Within that
 * set, a verified `unclear` tested nothing: it moves neither the `meets`
 * nor the `deviates` count, so a position tested only by `unclear`s is
 * still `UNTESTED`, not "HELD 0 of 0" — an empty basis is never `HELD`,
 * because `supporting === total` at `0 === 0` is exactly the shape of
 * "inferred from silence", which this project treats as a defect.
 *
 * Conceded outranks held: a position with even one qualifying concession
 * is reported as `conceded`, not as "held, minus the ones that deviated" —
 * a firm reading this wants to know the position has been given up on at
 * least once, not a net tally.
 */
export function positionHealth(
  publishedAt: number,
  findings: Finding[],
  opts?: PositionHealthOptions,
): PositionHealth {
  if (opts?.hasPosition === false) {
    return { kind: 'no-position' };
  }

  const tested = findings.filter(
    f =>
      f.verification.state === 'verified' &&
      f.verification.at !== undefined &&
      f.verification.at >= publishedAt &&
      (f.positionOutcome === 'meets' || f.positionOutcome === 'deviates'),
  );

  const conceded = tested.filter(f => f.positionOutcome === 'deviates');
  if (conceded.length > 0) {
    return { kind: 'conceded', count: conceded.length };
  }

  const held = tested.filter(f => f.positionOutcome === 'meets');
  if (held.length > 0) {
    return { kind: 'held', supporting: held.length, total: tested.length };
  }

  return { kind: 'untested' };
}

export function positionHealthLabel(health: PositionHealth): string {
  switch (health.kind) {
    case 'held':
      return `HELD ${health.supporting} of ${health.total}`;
    case 'conceded':
      return `CONCEDED ${health.count} times`;
    case 'untested':
      return 'UNTESTED';
    case 'no-position':
      return 'NO POSITION';
  }
}
