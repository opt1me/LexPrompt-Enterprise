import { verificationCounts } from './findingOutcome';
import type { Review } from '../types';

export { verificationCounts };
export type { VerificationCounts } from './findingOutcome';

/**
 * How much of a review a human has actually stood behind, for the two places
 * that show it: the review workspace header and each review row on the
 * matter home.
 *
 * Only `verified` counts. A flagged finding is one someone wants a second
 * look at and a rejected one is a finding someone disagreed with — neither
 * is progress toward a report anybody can rely on, and rolling them in
 * would make the number say the opposite of what a reader assumes it says.
 */
export function progressLabel(findings: Review['findings']): string {
  const { verified, total } = verificationCounts(findings);
  return `${verified} of ${total} verified`;
}

export function progressPercent(findings: Review['findings']): number {
  const { verified, total } = verificationCounts(findings);
  return total === 0 ? 0 : Math.round((verified / total) * 100);
}
