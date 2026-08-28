import React, { useState } from 'react';
import { ChevronUp, ChevronDown, GripVertical, Scale } from 'lucide-react';
import type { PlaybookClause } from '../../types';

export interface ClauseListRailProps {
  clauses: PlaybookClause[];
  /** The clause the main pane is showing. `undefined` only when there are
   *  no clauses at all. */
  activeId?: string;
  onSelect: (clauseId: string) => void;
  /** The ONE reordering path, owned by `TemplateEditor` — both affordances
   *  below (chevrons and drag handle) call it, so there is no second
   *  implementation to drift. */
  onReorder: (from: number, to: number) => void;
  /** Rendered at the foot of the rail: "Add clause" and the
   *  "Suggest what I'm missing" block. Passed in rather than built here so
   *  the rail stays a list and the AI wiring stays in one component. */
  footer?: React.ReactNode;
}

/**
 * The playbook's clause list, as the editor's left rail (handoff 1g/2b).
 *
 * One line per clause — number, title, and whether it carries a standard
 * position — because the previous layout rendered every clause EXPANDED at
 * once, three walls of text each, which is the "overly busy for a lawyer"
 * the owner asked us to undo. Navigation lives here; the clause itself is
 * read one at a time in the main pane.
 *
 * Deliberately NOT `features/authoring/ClauseRail`: that rail lists
 * `DraftClause`es by kept/cut/unreviewed disposition — a different type
 * carrying a different fact — and reworking it into a shared component
 * would mean editing `features/authoring/`, which another change owns.
 * What IS shared is the idiom (a `<ul>` of buttons, `aria-current` for the
 * active row); if a third rail appears, extract then.
 *
 * No health chip here. "This clause has no house rule" and "this clause has
 * one that nothing has tested" are different facts, and a rail row is not
 * where that distinction can be drawn honestly — the main pane shows health
 * beside the position it describes, or shows nothing.
 */
export function ClauseListRail({ clauses, activeId, onSelect, onReorder, footer }: ClauseListRailProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const withPosition = clauses.filter((c) => c.standardPosition).length;

  return (
    <nav
      aria-label="Clauses"
      className="flex flex-col lg:h-full bg-card border border-rule rounded-panel overflow-hidden"
    >
      <div className="p-3 border-b border-rule shrink-0">
        <h3 className="font-mono text-chip uppercase text-ink-4">Clauses ({clauses.length})</h3>
        {/* Declared new copy (R-G6), carried over from the old clause pane:
            it answers the question the rail is for — how much of this
            playbook actually carries a house rule. */}
        <p className="mt-1 font-ui text-meta text-ink-3">
          {withPosition} of {clauses.length} clauses have a standard position
        </p>
      </div>

      {clauses.length === 0 ? (
        <p className="flex-1 p-4 font-ui text-ui-sm text-ink-4">
          No clauses yet. Add one to get started.
        </p>
      ) : (
        <ul className="flex-1 lg:overflow-y-auto custom-scrollbar">
          {clauses.map((clause, idx) => {
            const isActive = clause.id === activeId;
            return (
              <li
                key={clause.id}
                data-clause-row
                onDragOver={(e) => { if (dragIndex !== null) e.preventDefault(); }}
                onDrop={(e) => {
                  if (dragIndex === null) return;
                  e.preventDefault();
                  onReorder(dragIndex, idx);
                  setDragIndex(null);
                }}
                className={`group flex items-stretch border-b border-rule-soft transition-colors ${
                  dragIndex === idx ? 'bg-accent-tint' : ''
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelect(clause.id)}
                  aria-current={isActive}
                  // `relative`: containing block for the sr-only span below,
                  // which is `position: absolute` and would otherwise be
                  // placed against whatever ancestor happens to be positioned.
                  className={`relative flex-1 min-w-0 text-left pl-3 pr-1 py-2.5 flex items-center gap-2 transition-colors ${
                    isActive ? 'bg-accent-tint' : 'hover:bg-chip-fill'
                  }`}
                >
                  <span className="font-mono text-pin text-ink-5 w-4 shrink-0">{idx + 1}</span>
                  <span className={`flex-1 font-ui text-ui-sm truncate ${isActive ? 'text-ink-1' : 'text-ink-2'}`}>
                    {clause.title || 'Untitled clause'}
                  </span>
                  {clause.standardPosition && (
                    <>
                      <Scale className="h-3 w-3 text-accent shrink-0" aria-hidden="true" />
                      <span className="sr-only">has a standard position</span>
                    </>
                  )}
                </button>
                {/* Revealed on hover, and on focus so the chevrons are not
                    invisible to the keyboard that is the only way to reach
                    them — a drag handle cannot be. */}
                <span className="flex items-center pr-2 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <button
                    type="button"
                    onClick={() => onReorder(idx, idx - 1)}
                    disabled={idx === 0}
                    aria-label={`Move ${clause.title} up`}
                    className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill disabled:opacity-30"
                  ><ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  <button
                    type="button"
                    onClick={() => onReorder(idx, idx + 1)}
                    disabled={idx === clauses.length - 1}
                    aria-label={`Move ${clause.title} down`}
                    className="p-1 rounded-control text-ink-4 hover:text-ink-1 hover:bg-chip-fill disabled:opacity-30"
                  ><ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  <span
                    draggable
                    aria-hidden="true"
                    title="Drag to reorder"
                    onDragStart={(e) => {
                      setDragIndex(idx);
                      // Firefox refuses to start a drag without payload.
                      // Optional-chained because jsdom's synthetic drag
                      // events carry no dataTransfer at all.
                      (e.dataTransfer as DataTransfer | undefined)?.setData('text/plain', String(idx));
                    }}
                    onDragEnd={() => setDragIndex(null)}
                    className="cursor-grab active:cursor-grabbing text-ink-6 hover:text-ink-4 p-1"
                  ><GripVertical className="h-3.5 w-3.5" /></span>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {footer && <div className="p-3 border-t border-rule shrink-0 space-y-3">{footer}</div>}
    </nav>
  );
}
