import React from 'react';
import { Scale } from 'lucide-react';
import type { Finding, StandardPosition } from '../../types';
import { describeFindingOutcome } from '../../lib/findingOutcome';

export interface PositionComparisonProps {
  position: StandardPosition;
  finding: Finding;
}

/**
 * "We ask for" against "this document says" — the comparison a `PositionChip`
 * summarises into one word, spelled out. Rendered above the evidence on
 * `FindingCard`, for the same reason `NetPositionPanel` is: the reader meets
 * the position and the argument for it before the quotes that back it up.
 *
 * The document's side comes from `describeFindingOutcome`
 * (`src/lib/findingOutcome.ts`), never re-derived here. That function already
 * knows the summary-vs-net-position precedence — a collection finding has no
 * `summary`, only a `netPosition`, and `positionText` prefers a human's
 * amendment over the model's proposal — and a second copy of that precedence
 * is this project's most repeated defect (CLAUDE.md: "sibling drift").
 */
const OUTCOME_CARD: Record<'deviates' | 'meets' | 'unclear', string> = {
  deviates: 'bg-risk-high-tint border-risk-high-edge',
  meets: 'bg-accent-tint border-accent-edge',
  unclear: 'bg-risk-med-tint border-risk-med-edge',
};

/** A clause with no house rule is not a comparison that came out blank — no
 *  placeholder, no "n/a". `positionOutcome` is set alongside `summary`/
 *  `netPosition` by the same extraction that produced this finding
 *  (`normalisePositionOutcome`, the only place it's produced) whenever the
 *  clause carries a `standardPosition`, so its absence here means the
 *  outcome was never derived for this finding, not that the model chose
 *  "meets" or "unclear" — rendering nothing is the honest response to that,
 *  not a downgraded card. */
export function PositionComparison({ position, finding }: PositionComparisonProps) {
  if (!finding.positionOutcome) return null;

  const documentSide = describeFindingOutcome(finding);
  const cardClass = OUTCOME_CARD[finding.positionOutcome];

  return (
    <div className={`border rounded-control p-3 space-y-2 ${cardClass}`}>
      <div className="flex items-center gap-1 font-mono text-label uppercase text-ink-4">
        <Scale className="w-3 h-3" aria-hidden="true" /> Standard position
      </div>

      {/* An AI-drafted position nobody has read yet is a suggestion, not the
         firm's position — the same distinction `StandardPositionEditor` (or
         its equivalent) makes when a person is asked to accept one. Shown
         here too, because a reader meeting the comparison for the first time
         on a finding has no other way to know whether to trust it. */}
      {!position.reviewedByHuman && (
        <p className="font-mono text-label uppercase text-risk-med">
          AI-drafted suggestion — not yet reviewed by a person
        </p>
      )}

      <p className="font-prose text-field text-ink-prose leading-relaxed">
        <span className="font-semibold text-ink-2">We ask for </span>
        {position.text}
      </p>
      <p className="font-prose text-field text-ink-prose leading-relaxed">
        <span className="font-semibold text-ink-2">This document says </span>
        {documentSide}
      </p>

      {finding.positionRationale && (
        <p className="font-ui text-ui-sm text-ink-3 italic leading-relaxed">{finding.positionRationale}</p>
      )}
    </div>
  );
}
