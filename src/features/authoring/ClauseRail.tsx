import React from 'react';
import { CheckCircle2, XCircle, Circle } from 'lucide-react';
import type { ClauseDisposition, DraftClause } from '../../lib/authoringDraft';

export interface ClauseRailProps {
  clauses: DraftClause[];
  activeId: string;
  onSelect: (clauseId: string) => void;
  /** Inert while a publish is in flight. Moving clause commits whatever is
   *  typed into the editor, and a commit landing mid-publish would change
   *  the draft under the write (Major 4). */
  disabled?: boolean;
}

/** Shared with `DraftReview`'s main-pane badge so the word used for a given
 *  disposition never drifts between the rail and the editor showing the
 *  same clause (CLAUDE.md: sibling drift). */
export const DISPOSITION_LABEL: Record<ClauseDisposition, string> = {
  unreviewed: 'Unreviewed',
  kept: 'Kept',
  cut: 'Cut',
};

const DISPOSITION_ICON: Record<ClauseDisposition, typeof Circle> = {
  unreviewed: Circle,
  kept: CheckCircle2,
  cut: XCircle,
};

const DISPOSITION_CLASS: Record<ClauseDisposition, string> = {
  unreviewed: 'text-ink-4',
  kept: 'text-accent',
  cut: 'text-risk-high',
};

/**
 * Left rail for the draft review screen (spec §6): kept/cut/unreviewed
 * counts up top so a reviewer can see how much of the draft is left without
 * opening every clause, then every clause with its own disposition and a
 * click to jump straight to it.
 */
export function ClauseRail({ clauses, activeId, onSelect, disabled = false }: ClauseRailProps) {
  const kept = clauses.filter((c) => c.disposition === 'kept').length;
  const cut = clauses.filter((c) => c.disposition === 'cut').length;
  const unreviewed = clauses.filter((c) => c.disposition === 'unreviewed').length;

  return (
    <div className="flex flex-col h-full bg-card border border-rule rounded-panel overflow-hidden">
      <div className="p-3 border-b border-rule flex items-center justify-center gap-3 font-mono text-chip uppercase shrink-0">
        <span className="text-accent">{kept} kept</span>
        <span className="text-risk-high">{cut} cut</span>
        <span className="text-ink-4">{unreviewed} unreviewed</span>
      </div>
      <ul className="flex-1 overflow-y-auto custom-scrollbar">
        {clauses.map((c) => {
          const Icon = DISPOSITION_ICON[c.disposition];
          const isActive = c.id === activeId;
          return (
            <li key={c.id}>
              <button
                onClick={() => onSelect(c.id)}
                disabled={disabled}
                aria-current={isActive}
                className={`w-full text-left px-3 py-2.5 flex items-center gap-2 border-b border-rule-soft transition-colors ${
                  isActive ? 'bg-accent-tint' : 'hover:bg-chip-fill'
                }`}
              >
                <Icon className={`h-3.5 w-3.5 shrink-0 ${DISPOSITION_CLASS[c.disposition]}`} aria-hidden="true" />
                <span className="flex-1 font-ui text-ui-sm text-ink-2 truncate">{c.title}</span>
                <span className={`font-mono text-chip uppercase shrink-0 ${DISPOSITION_CLASS[c.disposition]}`}>
                  {DISPOSITION_LABEL[c.disposition]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
