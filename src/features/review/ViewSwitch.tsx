import React from 'react';
import type { ReviewTarget } from '../../types';
import { isCollectionTarget } from '../../lib/reviewTarget';

export type ReviewViewKind = 'review' | 'compare';

export interface ViewSwitchProps {
  value: ReviewViewKind;
  onChange: (next: ReviewViewKind) => void;
  target: ReviewTarget;
  documentCount: number;
}

const TABS: { kind: ReviewViewKind; label: string }[] = [
  { kind: 'review', label: 'Review' },
  { kind: 'compare', label: 'Compare' },
];

/**
 * The review header's `Review / Compare` control. `Review` is the card
 * ledger; `Compare` is the grid. They are already two renderers over one
 * findings map — this control is that existing toggle, not a new view
 * (§10.5).
 *
 * It renders NOTHING when there is nothing to compare across, rather than
 * rendering a disabled tab: a single-document review has one column, and a
 * collection review produces one position per clause however many documents
 * fed it, so `TabularReview` refuses it outright. A disabled tab would
 * advertise a view that will never exist for this review.
 *
 * There is no third tab. Export is a button that produces a file (R-G11).
 */
export function ViewSwitch({ value, onChange, target, documentCount }: ViewSwitchProps) {
  if (isCollectionTarget(target) || documentCount < 2) return null;

  return (
    <div className="flex gap-0.5 bg-chip-fill rounded-control p-0.5">
      {TABS.map(tab => (
        <button
          key={tab.kind}
          type="button"
          onClick={() => onChange(tab.kind)}
          className={`px-3 py-1.5 rounded-inset font-ui text-button ${value === tab.kind ? 'bg-card shadow-tab text-ink-1' : 'text-ink-3 hover:text-ink-1'}`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
