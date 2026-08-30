import { describe, expect, it } from 'vitest';
import { positionHealth, positionHealthLabel } from './positionHealth';
import type { Finding, PositionOutcome, Verification } from '../types';

/** Minimal but real `Finding`s. `verification` is built from the actual
 *  `Verification` shape in `@lexprompt/core` — `{ state, byUserId?,
 *  at?, reason?, assigneeId? }` — not guessed.
 *
 *  Named `verifiedFinding`/`uncheckedFinding`, NOT `verified`/`unchecked`:
 *  `@lexprompt/core` already exports a zero-arg `unchecked()`
 *  returning a bare `Verification`, and a same-named local helper here
 *  returning a `Finding` would shadow it.
 *
 *  `uncheckedFinding` still carries a defined, "recent" `at` on its
 *  verification (real unchecked findings never do) so that the "counts
 *  only verified findings" test is actually discriminating: if it were
 *  built with `at` absent, dropping the `state === 'verified'` filter
 *  would still be caught by an `at` guard, and the mutation meant to catch
 *  the missing verified-only filter would pass for the wrong reason. */
let findingSeq = 0;

function makeFinding(outcome: PositionOutcome, verification: Verification): Finding {
  findingSeq += 1;
  return {
    clauseId: `clause-${findingSeq}`,
    status: 'done',
    citations: [],
    verification,
    notes: [],
    positionOutcome: outcome,
  };
}

function verifiedFinding(outcome: PositionOutcome, at = 1_000): Finding {
  return makeFinding(outcome, { state: 'verified', byUserId: 'u1', at });
}

function uncheckedFinding(outcome: PositionOutcome): Finding {
  return makeFinding(outcome, { state: 'unchecked', at: 1_000 });
}

describe('positionHealth', () => {
  it('is UNTESTED when no verified finding has tested it', () => {
    expect(positionHealthLabel(positionHealth(0, []))).toBe('UNTESTED');
    expect(
      positionHealthLabel(positionHealth(0, [uncheckedFinding('meets'), uncheckedFinding('deviates')])),
    ).toBe('UNTESTED');
  });

  it('counts only verified findings — an unchecked meets does not strengthen a position', () => {
    // The model agreeing with itself is not evidence. Letting it count would
    // close the loop this app exists to keep open.
    const h = positionHealth(0, [verifiedFinding('meets'), uncheckedFinding('meets'), uncheckedFinding('meets')]);
    expect(positionHealthLabel(h)).toBe('HELD 1 of 1');
  });

  it('is HELD n of m when every verified finding met it', () => {
    expect(positionHealthLabel(positionHealth(0, [verifiedFinding('meets'), verifiedFinding('meets')]))).toBe(
      'HELD 2 of 2',
    );
  });

  it('is CONCEDED once a verified deviation lands after the version was published', () => {
    expect(
      positionHealthLabel(positionHealth(50, [verifiedFinding('meets', 100), verifiedFinding('deviates', 120)])),
    ).toBe('CONCEDED 1 time');
  });

  // m5 (final honesty review): "CONCEDED 1 times" was ungrammatical, and a
  // second concession must still pluralise correctly rather than the fix
  // just special-casing 1.
  it('pluralises correctly for more than one concession', () => {
    expect(
      positionHealthLabel(
        positionHealth(0, [verifiedFinding('deviates', 100), verifiedFinding('deviates', 200)]),
      ),
    ).toBe('CONCEDED 2 times');
  });

  it('ignores a verified deviation from before this version was published', () => {
    // The position changed; a concession against the old wording says nothing
    // about the new one.
    expect(
      positionHealthLabel(positionHealth(200, [verifiedFinding('deviates', 100), verifiedFinding('meets', 250)])),
    ).toBe('HELD 1 of 1');
  });

  it('does not count a verified unclear as either held or conceded', () => {
    expect(positionHealthLabel(positionHealth(0, [verifiedFinding('unclear')]))).toBe('UNTESTED');
  });

  // A verified unclear tested nothing (positionHealth.ts's own doc comment).
  // That has to mean invisible to the count entirely, not merely unable to
  // move `supporting` — if it leaked into `total` while a `meets`/`deviates`
  // sibling made the result HELD, a reader would see "HELD 1 of 2" and read
  // that as two comparisons, one of which somehow didn't count, rather than
  // the true fact: exactly one comparison ever resolved either way.
  it('a verified unclear does not inflate the denominator when mixed with a tested finding', () => {
    const h = positionHealth(0, [verifiedFinding('meets'), verifiedFinding('unclear')]);
    expect(positionHealthLabel(h)).toBe('HELD 1 of 1');
  });

  // The `at === publishedAt` boundary: a verification stamped the exact
  // instant a version was published must count as evidence for it, not be
  // excluded as "too early" — the alternative would mean the very FIRST
  // review run against a freshly-published position could never count as
  // testing it, no matter how genuinely it did.
  it('counts a verification made exactly when the version was published', () => {
    expect(positionHealthLabel(positionHealth(100, [verifiedFinding('meets', 100)]))).toBe('HELD 1 of 1');
  });

  it('is NO POSITION when the clause has no standard position', () => {
    expect(positionHealthLabel(positionHealth(0, [], { hasPosition: false }))).toBe('NO POSITION');
  });

  it('an empty history is UNTESTED, not an error', () => {
    expect(() => positionHealth(0, [])).not.toThrow();
  });

  // Minor 3 (final honesty review): every other consumer of
  // `positionOutcome` gates on `isVerifiable` (status === 'done') —
  // `findingOutcome.ts`'s `hasStandingPosition`, and
  // `TabularReview.tsx`'s `positionOutcomeCounts` — but `positionHealth`'s
  // `tested` filter checked only `verification.state`. `extractClause`'s
  // `noContent` branch DOES attach a `positionOutcome` to a finding whose
  // `status` is `'error'` (a model that gave an outcome and an empty
  // summary still gave an outcome). Nothing in the app's own write paths
  // can currently attach a `verified` verification to a non-`done`
  // finding — `isVerifiable` gates both the mouse and keyboard verify
  // controls — so this finding is built directly rather than produced
  // through the UI; the point is that `positionHealth` itself must not
  // trust `status` implicitly, matching every sibling that reads this
  // field.
  it('does not count an error finding as tested, even carrying a verified verification and an outcome', () => {
    const errorFinding: Finding = {
      clauseId: 'c1',
      status: 'error',
      error: 'The model returned no content for this clause.',
      noContent: true,
      citations: [],
      verification: { state: 'verified', byUserId: 'u1', at: 1_000 },
      notes: [],
      positionOutcome: 'deviates',
    };
    expect(positionHealthLabel(positionHealth(0, [errorFinding]))).toBe('UNTESTED');
  });
});
