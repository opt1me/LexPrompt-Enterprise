import React from 'react';
import type { Review, RiskLevel } from '../../types';
import { summariseMatter } from '../../lib/matterStats';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

export interface MatterStatsProps {
  reviews: Review[];
  /** Non-null replaces the whole row: statistics derived from reviews
   *  nobody could read are not statistics (R-G10). */
  reviewsError: string | null;
  onRetryReviews: () => void;
}

const RISK_ORDER: RiskLevel[] = ['High', 'Medium', 'Low'];
// Complete literal class names per variant, never built by string
// interpolation — a template like `text-risk-${level}` produces no
// styling at all, since Tailwind can only see whole class names as they
// appear in source.
const RISK_INK: Record<RiskLevel, string> = {
  High: 'text-risk-high', Medium: 'text-risk-med', Low: 'text-risk-low', Info: 'text-draft',
};
const RISK_FILL: Record<RiskLevel, string> = {
  High: 'bg-risk-high', Medium: 'bg-risk-med', Low: 'bg-risk-low', Info: 'bg-draft',
};

const CARD = 'bg-card border border-rule rounded-card p-5';

/**
 * The matter home's stat row (Task 15, spec §10.1) — how much of this
 * matter has actually been checked by a human, what needs attention, and
 * its risk profile. Answers the question the redesign's thesis rests on,
 * which the matter home did not previously state anywhere.
 *
 * Counted through `summariseMatter`, which itself goes through
 * `verificationCounts` — the same function both exporters use — so this
 * board can never quote a different number than the DOCX/CSV export of the
 * same reviews (CLAUDE.md's sibling-drift rule).
 *
 * R-G10 is the reason this component exists as a component rather than a
 * plain render in `MatterHome`: it owns two branches that must never be
 * skipped —
 *  - `reviewsError` replaces the ENTIRE row with the load-error panel.
 *    Statistics derived from reviews nobody could read are not statistics.
 *  - Zero completed reviews renders an empty form, never "0 of 0 findings
 *    verified" — that reads as "nothing outstanding", which is a claim
 *    about the matter's safety nobody made (the same defect class as the
 *    CSV writing unreviewed clauses as blank cells).
 */
export function MatterStats({ reviews, reviewsError, onRetryReviews }: MatterStatsProps) {
  if (reviewsError) {
    return <LoadErrorPanel compact message={reviewsError} onRetry={onRetryReviews} />;
  }

  const s = summariseMatter(reviews);

  if (s.completedReviews === 0) {
    return (
      <div className={CARD}>
        <p className="font-prose text-section text-ink-1">No review has run yet</p>
        <p className="font-ui text-ui text-ink-2 mt-1">
          {s.running
            ? 'A review is still running. Its findings will appear here as it goes.'
            : "Run a playbook over this matter's documents to see how much of it has been checked."}
        </p>
      </div>
    );
  }

  const pct = (n: number) => (s.counts.total > 0 ? (n / s.counts.total) * 100 : 0);
  const riskTotal = RISK_ORDER.reduce((sum, l) => sum + s.risk[l], 0);

  return (
    <div className="grid gap-4 md:grid-cols-[1.35fr_1fr_1fr]">
      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Verification progress</h3>
        <p className="mt-2 flex items-baseline gap-2">
          <span className="font-prose text-figure text-ink-1">{s.counts.verified}</span>
          <span className="font-ui text-ui text-ink-2">of {s.counts.total} findings verified</span>
        </p>
        <div className="mt-3 h-2 rounded-inset bg-chip-fill overflow-hidden flex">
          <span className="bg-state-verified" style={{ width: `${pct(s.counts.verified)}%` }} />
          <span className="bg-state-flagged" style={{ width: `${pct(s.counts.flagged)}%` }} />
          <span className="bg-state-rejected" style={{ width: `${pct(s.counts.rejected)}%` }} />
        </div>
        <p className="mt-2 font-ui text-meta text-ink-3">
          {s.counts.verified} verified · {s.counts.flagged} flagged · {s.counts.rejected} rejected · {s.counts.unchecked} unchecked
        </p>
        {s.running && (
          <p className="mt-2 font-ui text-meta text-risk-med">A review is still running, so these counts are not final.</p>
        )}
      </section>

      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Needs attention</h3>
        <p className="mt-3 flex items-baseline gap-2">
          <span className={`font-mono text-clause ${RISK_INK.Medium}`}>{s.needsAttention.flagged}</span>
          <span className="font-ui text-ui-sm text-ink-2">Flagged for follow-up</span>
        </p>
        <p className="mt-2 flex items-baseline gap-2">
          <span className={`font-mono text-clause ${RISK_INK.High}`}>{s.needsAttention.deviating}</span>
          <span className="font-ui text-ui-sm text-ink-2">Deviating from a standard position</span>
        </p>
      </section>

      <section className={CARD}>
        <h3 className="font-mono text-label uppercase text-ink-4">Risk profile</h3>
        {RISK_ORDER.map(level => (
          <p key={level} className="mt-2 flex items-center gap-2">
            <span className={`w-14 font-mono text-chip uppercase ${RISK_INK[level]}`}>{level}</span>
            <span className="flex-1 h-1.5 rounded-meter bg-chip-fill overflow-hidden">
              <span
                className={`block h-full ${RISK_FILL[level]}`}
                style={{ width: `${riskTotal > 0 ? (s.risk[level] / riskTotal) * 100 : 0}%` }}
              />
            </span>
            <span className="font-mono text-pin text-ink-4">{s.risk[level]}</span>
          </p>
        ))}
      </section>
    </div>
  );
}
