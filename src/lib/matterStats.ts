import type { Review, RiskLevel } from '../types';
import { verificationCounts, positionOutcomeCounts, type VerificationCounts } from './findingOutcome';

export interface MatterStatSummary {
  counts: VerificationCounts;
  /** `deviating` is only meaningful when `hasPosition` is true — see
   *  `positionOutcomeCounts`'s doc comment ("absent is not zero"). A matter
   *  where no clause anywhere carried a standard position must render no
   *  deviating line at all, not "0 deviating": a zero there would read as a
   *  comparison that never happened. */
  needsAttention: { flagged: number; deviating: number; hasPosition: boolean };
  risk: Record<RiskLevel, number>;
  /** Reviews that actually finished. The stat cards render their EMPTY form
   *  while this is 0 (R-G10) — three zeroes would read as "nothing wrong
   *  here", which is a claim about the matter's safety that nobody made. */
  completedReviews: number;
  /** At least one review started, not completed, not cancelled. */
  running: boolean;
}

/** Pure: whatever reviews the caller already loaded, summarised. Reads no
 *  store, exactly as `positionHealth` does not (R-D2), so the IO stays in
 *  the container and this stays testable.
 *
 *  Verification counting goes through `verificationCounts`, and the
 *  deviating count through `positionOutcomeCounts` — the same functions the
 *  DOCX report, the CSV, and the tabular grid's clause index all use — so a
 *  status board can never disagree with them about how much had been
 *  checked, or claim a comparison happened when no clause anywhere carried a
 *  standard position. `summariseMatter` briefly had its own copy of the
 *  deviating tally, with neither `isVerifiable` nor the `hasPosition`
 *  distinction, which is exactly how it ended up rendering "0 Deviating from
 *  a standard position" on a matter with no standard positions at all. */
export function summariseMatter(reviews: Review[]): MatterStatSummary {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  const risk: Record<RiskLevel, number> = { High: 0, Medium: 0, Low: 0, Info: 0 };
  let deviating = 0;
  let hasPosition = false;
  let completedReviews = 0;
  let running = false;

  for (const review of reviews) {
    if (review.completedAt !== undefined) completedReviews++;
    else if (review.cancelledAt === undefined) running = true;

    const c = verificationCounts(review.findings);
    counts.total += c.total;
    counts.verified += c.verified;
    counts.unchecked += c.unchecked;
    counts.flagged += c.flagged;
    counts.rejected += c.rejected;

    const p = positionOutcomeCounts(review.findings);
    deviating += p.deviating;
    hasPosition = hasPosition || p.hasPosition;

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (finding?.riskLevel) risk[finding.riskLevel]++;
      }
    }
  }

  return {
    counts,
    needsAttention: { flagged: counts.flagged, deviating, hasPosition },
    risk,
    completedReviews,
    running,
  };
}
