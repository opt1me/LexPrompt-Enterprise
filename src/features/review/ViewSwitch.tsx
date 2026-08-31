import React from 'react';
import type { ReviewTarget } from '../../types';
import { isCollectionTarget } from '@lexprompt/core';

export type ReviewViewKind = 'review' | 'compare' | 'report';

export interface ViewSwitchProps {
  value: ReviewViewKind;
  onChange: (next: ReviewViewKind) => void;
  target: ReviewTarget;
  documentCount: number;
}

const TABS: { kind: ReviewViewKind; label: string }[] = [
  { kind: 'review', label: 'Review' },
  { kind: 'compare', label: 'Compare' },
  { kind: 'report', label: 'Report' },
];

/**
 * The review header's `Review / Compare / Report` control. `Review` is the
 * card ledger; `Compare` is the grid; `Report` is a view of the document the
 * export produces. Three renderers over one findings map — this control is
 * that toggle, not three views (§10.5).
 *
 * ## The COMPARE tab is what disappears, not the control
 *
 * It renders nothing when there is nothing to compare across, rather than a
 * disabled tab: a single-document review has one column, and a collection
 * review produces one position per clause however many documents fed it, so
 * `TabularReview` refuses it outright. A disabled tab would advertise a view
 * that will never exist for this review.
 *
 * The control itself now always renders, because `Review` and `Report` both
 * always exist — this file used to return `null` for a single-document
 * review, which would have hidden the Report tab from most reviews in the
 * app. Hiding a view that DOES exist is the same defect as advertising one
 * that does not, in the opposite direction.
 *
 * ## The third tab, and R-G11
 *
 * R-G11 dropped it because *"a `Report` tab advertises a live report view
 * the app does not have"*. The app has one as of Stage 5: `ReportView`
 * renders `findingOutcome.ts`'s strings, through the same `buildReportRows`
 * the DOCX builds its tables from. It is not an export button; export is
 * still a button that produces a file, and this is the last place anyone can
 * look at what that file will say.
 */
export function ViewSwitch({ value, onChange, target, documentCount }: ViewSwitchProps) {
  const comparable = !isCollectionTarget(target) && documentCount >= 2;
  const tabs = comparable ? TABS : TABS.filter(t => t.kind !== 'compare');

  return (
    <div className="flex gap-0.5 bg-chip-fill rounded-control p-0.5">
      {tabs.map(tab => (
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
