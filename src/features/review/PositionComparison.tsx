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
export function PositionComparison({ position, finding }: PositionComparisonProps) {
  const documentSide = describeFindingOutcome(finding);

  return (
    <div className="bg-white/5 border border-white/10 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wide">
        <Scale className="w-3 h-3" aria-hidden="true" /> Standard position
      </div>

      {/* An AI-drafted position nobody has read yet is a suggestion, not the
         firm's position — the same distinction `StandardPositionEditor` (or
         its equivalent) makes when a person is asked to accept one. Shown
         here too, because a reader meeting the comparison for the first time
         on a finding has no other way to know whether to trust it. */}
      {!position.reviewedByHuman && (
        <p className="text-[10px] uppercase font-bold text-amber-300">
          AI-drafted suggestion — not yet reviewed by a person
        </p>
      )}

      <p className="text-xs text-gray-300 leading-relaxed">
        <span className="font-semibold text-gray-400">We ask for </span>
        {position.text}
      </p>
      <p className="text-xs text-gray-300 leading-relaxed">
        <span className="font-semibold text-gray-400">This document says </span>
        {documentSide}
      </p>

      {finding.positionRationale && (
        <p className="text-xs text-gray-400 italic leading-relaxed">{finding.positionRationale}</p>
      )}
    </div>
  );
}
