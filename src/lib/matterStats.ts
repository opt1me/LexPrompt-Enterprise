import type { Review, RiskLevel } from '../types';
import { verificationCounts, type VerificationCounts } from './findingOutcome';

export interface MatterStatSummary {
  counts: VerificationCounts;
  needsAttention: { flagged: number; deviating: number };
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
 *  Verification counting goes through `verificationCounts` rather than a
 *  second loop, because the DOCX report and the CSV quote that same
 *  function: a status board that disagreed with the export about how much
 *  had been checked would be the exact drift `findingOutcome.ts` exists to
 *  prevent. */
export function summariseMatter(reviews: Review[]): MatterStatSummary {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  const risk: Record<RiskLevel, number> = { High: 0, Medium: 0, Low: 0, Info: 0 };
  let deviating = 0;
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

    for (const byClause of Object.values(review.findings ?? {})) {
      for (const finding of Object.values(byClause ?? {})) {
        if (finding?.riskLevel) risk[finding.riskLevel]++;
        if (finding?.positionOutcome === 'deviates') deviating++;
      }
    }
  }

  return {
    counts,
    needsAttention: { flagged: counts.flagged, deviating },
    risk,
    completedReviews,
    running,
  };
}
