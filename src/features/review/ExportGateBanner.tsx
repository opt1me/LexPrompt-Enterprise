import React from 'react';
import { TriangleAlert } from 'lucide-react';
import type { Review } from '../../types';
import { verificationCounts } from '../../lib/findingOutcome';

export interface ExportGateBannerProps {
  findings: Review['findings'];
  /** Sends the reader to the first unchecked finding. Omitted, the banner
   *  states the fact and offers nothing to click — which is still the
   *  honest thing to say at the moment someone is deciding to export. */
  onReviewUnchecked?: () => void;
}

/**
 * "N findings are unchecked. Export is available, but the report will mark
 * them as unverified AI output."
 *
 * Every clause of that sentence is already true and already enforced:
 * export is never blocked (B §7), and `verificationLabel` already writes
 * UNVERIFIED AI OUTPUT into both exporters. This says so where the decision
 * is made rather than leaving the reader to discover it in the file.
 *
 * Counts come from `verificationCounts` — the same helper both exporters'
 * header summary line uses (`exportSummaryLine`) — so this banner cannot
 * become a third, drifting description of what an export contains. Do not
 * add a local tally here; that is exactly the sibling-drift failure
 * `findingOutcome.ts` exists to prevent (CLAUDE.md).
 *
 * It must never block, disable or gate the export button. It is a
 * statement, not a gate — the name is the mockup's, not a description of
 * what it does (spec §10.3, R-G6).
 */
export function ExportGateBanner({ findings, onReviewUnchecked }: ExportGateBannerProps) {
  const { unchecked } = verificationCounts(findings);
  if (unchecked === 0) return null;

  return (
    <div className="shrink-0 border-b border-risk-med-edge bg-risk-med-tint px-6 py-3 flex items-center gap-3 font-ui text-ui text-risk-med">
      <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>
        <span className="font-semibold">
          {unchecked === 1 ? '1 finding is unchecked.' : `${unchecked} findings are unchecked.`}
        </span>{' '}
        Export is available, but the report will mark them as unverified AI output.
      </span>
      {onReviewUnchecked && (
        <button
          type="button"
          onClick={onReviewUnchecked}
          className="ml-auto shrink-0 font-ui text-ui font-semibold text-risk-med hover:underline"
        >
          Review unchecked →
        </button>
      )}
    </div>
  );
}
