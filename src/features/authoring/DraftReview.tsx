import React, { useEffect, useState } from 'react';
import { ShieldAlert, Scale, Sparkles, Plus, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { ClauseRail, DISPOSITION_LABEL } from './ClauseRail';
import {
  canSaveDraft,
  saveGateLabel,
  keepClause,
  cutClause,
  type AuthoringDraft,
  type DraftClause,
} from '../../lib/authoringDraft';
import type { PlaybookClause } from '../../types';
import { uid } from '../../lib/uid';

export interface DraftReviewProps {
  draft: AuthoringDraft;
  onChange: (draft: AuthoringDraft) => void;
  /** Enabled only when `canSaveDraft(draft)`; labelled by `saveGateLabel`. */
  onSave: () => void;
  onDiscard: () => void;
  saving?: boolean;
}

/** Same guard `useVerifyKeys` uses: without it, a reviewer typing "just
 *  jot" into a field would fire the shortcut on the letter j. */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
}

/**
 * The draft review screen (spec §6) — the surface where the save gate is
 * actually enforced. `Save as v1`'s `disabled` and label come straight from
 * `canSaveDraft`/`saveGateLabel` (`src/lib/authoringDraft.ts`) and nothing
 * here re-derives that rule: a gate correct in a pure function and ignored
 * by its only caller is this project's most repeated defect shape.
 */
export function DraftReview({ draft, onChange, onSave, onDiscard, saving = false }: DraftReviewProps) {
  const [activeId, setActiveId] = useState<string>(() => draft.clauses[0]?.id ?? '');

  // Falls back to the first clause if the active one disappears (e.g. a
  // suggestion turned into a new clause list elsewhere). Guarded on
  // membership rather than on draft identity, so it never fights the
  // forward-only "stay put" rule in the keyboard handler below.
  useEffect(() => {
    if (activeId && !draft.clauses.some((c) => c.id === activeId)) {
      setActiveId(draft.clauses[0]?.id ?? '');
    }
  }, [draft.clauses, activeId]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'j' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      const index = draft.clauses.findIndex((c) => c.id === activeId);
      if (index === -1) return;
      // Forward-only: never wraps. Wrapping would make a reviewer believe
      // they had already seen a clause they had not (spec §6).
      const nextIndex = draft.clauses.findIndex((c, i) => i > index && c.disposition === 'unreviewed');
      if (nextIndex !== -1) {
        event.preventDefault();
        setActiveId(draft.clauses[nextIndex].id);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draft.clauses, activeId]);

  const activeClause = draft.clauses.find((c) => c.id === activeId);
  const canSave = canSaveDraft(draft);
  const saveLabel = saveGateLabel(draft);
  const reviewedCount = draft.clauses.filter((c) => c.disposition !== 'unreviewed').length;

  const handleKeep = (edits: Partial<PlaybookClause>) => {
    if (!activeClause) return;
    onChange(keepClause(draft, activeClause.id, edits));
  };

  const handleCut = () => {
    if (!activeClause) return;
    onChange(cutClause(draft, activeClause.id));
  };

  const handleAddSuggestion = (text: string) => {
    if (!activeClause) return;
    const newClause: DraftClause = {
      id: uid(),
      title: text,
      extractPrompt: text,
      disposition: 'unreviewed',
      edited: false,
      suggestions: [],
    };
    onChange({
      ...draft,
      clauses: draft.clauses.flatMap((c) =>
        c.id === activeClause.id
          ? [{ ...c, suggestions: c.suggestions.filter((s) => s !== text) }, newClause]
          : [c],
      ),
    });
  };

  /** Spec §7: `Discard` confirms first, because it destroys work the user
   *  has partly reviewed and nothing about it is recoverable — the draft
   *  lives only in this tab's memory (R-E1). The confirm sits here rather
   *  than in the caller because the button sits here: a gate one screen
   *  away from the control it guards is how a second caller ends up wiring
   *  the control without it. */
  const handleDiscard = () => {
    const reviewed = draft.clauses.filter((c) => c.disposition !== 'unreviewed').length;
    const detail = reviewed > 0
      ? ` The ${reviewed} clause${reviewed === 1 ? '' : 's'} you have already reviewed will be lost.`
      : '';
    if (!window.confirm(`Discard this draft? Nothing has been saved.${detail}`)) return;
    onDiscard();
  };

  const handleDismissSuggestion = (text: string) => {
    if (!activeClause) return;
    onChange({
      ...draft,
      clauses: draft.clauses.map((c) =>
        c.id === activeClause.id ? { ...c, suggestions: c.suggestions.filter((s) => s !== text) } : c,
      ),
    });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col bg-[#09090b]">
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 shrink-0">
        <div>
          <span className="inline-block px-2 py-1 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] font-bold uppercase tracking-wider">
            Unsaved draft
          </span>
          <h2 className="text-xl font-bold text-white mt-2">{draft.contractType}</h2>
          <p className="text-xs text-gray-500 mt-1">
            {reviewedCount} of {draft.clauses.length} clauses reviewed
            {draft.learnedFrom.length > 0 && <> &middot; learned from {draft.learnedFrom.join(', ')}</>}
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <Button variant="ghost" onClick={handleDiscard} disabled={saving}>Discard</Button>
          <Button onClick={onSave} disabled={!canSave || saving} loading={saving}>
            {saveLabel}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        <ClauseRail clauses={draft.clauses} activeId={activeId} onSelect={setActiveId} />

        <div className="overflow-y-auto custom-scrollbar bg-[#111] border border-white/10 rounded-xl p-5">
          {activeClause ? (
            <ClauseEditor
              key={activeClause.id}
              clause={activeClause}
              onKeep={handleKeep}
              onCut={handleCut}
              onAddSuggestion={handleAddSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
            />
          ) : (
            <p className="text-sm text-gray-500 italic">No clauses to review.</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface ClauseEditorProps {
  clause: DraftClause;
  onKeep: (edits: Partial<PlaybookClause>) => void;
  onCut: () => void;
  onAddSuggestion: (text: string) => void;
  onDismissSuggestion: (text: string) => void;
}

/**
 * Local field state, remounted (via `key={clause.id}` on the parent's use of
 * this component) on every clause switch rather than re-synced by an effect
 * — the same pattern `DraftForm` uses for `initialValues`, deliberately: an
 * effect that resets state on a prop change can be clobbered by another
 * effect in the same commit (CLAUDE.md: effects run in declaration order),
 * and a remount sidesteps that class of bug entirely.
 */
function ClauseEditor({ clause, onKeep, onCut, onAddSuggestion, onDismissSuggestion }: ClauseEditorProps) {
  const [extractPrompt, setExtractPrompt] = useState(clause.extractPrompt);
  const [riskCriteria, setRiskCriteria] = useState(clause.riskCriteria ?? '');
  const [positionText, setPositionText] = useState(clause.standardPosition?.text ?? '');

  const handleKeep = () => {
    const edits: Partial<PlaybookClause> = {
      extractPrompt,
      // Normalised back to the original's undefined-vs-string shape: an
      // untouched blank field must read as unedited. `valuesEqual` in
      // `authoringDraft.ts` treats `undefined` and `''` as unequal on
      // purpose (an absent value and an explicitly cleared one are
      // different claims), so submitting a bare '' for a field that started
      // `undefined` would misread as an edit here.
      riskCriteria: riskCriteria.trim() === '' ? undefined : riskCriteria,
    };
    if (clause.standardPosition) {
      edits.standardPosition = { ...clause.standardPosition, text: positionText };
    }
    onKeep(edits);
  };

  const dispositionClass =
    clause.disposition === 'kept'
      ? 'text-emerald-400'
      : clause.disposition === 'cut'
        ? 'text-red-400'
        : 'text-gray-500';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h3 data-active-clause className="text-lg font-bold text-white">{clause.title}</h3>
        <span className={`text-[10px] uppercase font-bold tracking-wide shrink-0 mt-1 ${dispositionClass}`}>
          {DISPOSITION_LABEL[clause.disposition]}
        </span>
      </div>

      <div>
        <label className="block text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1">
          Extraction instructions
        </label>
        <AutoResizeTextarea
          aria-label="Extraction instructions"
          value={extractPrompt}
          onChange={(e) => setExtractPrompt(e.target.value)}
          className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-200 outline-none focus:border-violet-500 min-h-[70px]"
        />
      </div>

      <div>
        <label className="block text-[10px] text-red-400 uppercase tracking-wider font-bold mb-1 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Risk criteria
        </label>
        <AutoResizeTextarea
          aria-label="Risk criteria"
          value={riskCriteria}
          onChange={(e) => setRiskCriteria(e.target.value)}
          placeholder="Leave blank to use the playbook's global risk tolerance."
          className="w-full bg-red-900/10 border border-red-500/10 rounded-lg p-3 text-sm text-gray-200 outline-none focus:border-red-500/50 min-h-[60px]"
        />
      </div>

      {clause.standardPosition && (
        <div className="bg-white/5 border border-white/10 rounded-lg p-3 space-y-2">
          <div className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wide">
            <Scale className="w-3 h-3" aria-hidden="true" /> Standard position
          </div>
          {!clause.standardPosition.reviewedByHuman && (
            <p className="text-[10px] uppercase font-bold text-amber-300">
              Drafted by AI &mdash; not yet reviewed by a person.
            </p>
          )}
          <AutoResizeTextarea
            aria-label="Standard position"
            value={positionText}
            onChange={(e) => setPositionText(e.target.value)}
            className="w-full bg-black/50 border border-white/10 rounded-lg p-2 text-xs text-gray-200 outline-none focus:border-violet-500 min-h-[50px]"
          />
        </div>
      )}

      {clause.suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1 text-[10px] font-bold text-gray-500 uppercase tracking-wide">
            <Sparkles className="w-3 h-3" aria-hidden="true" /> Suggested sub-questions
          </p>
          {clause.suggestions.map((s) => (
            <div
              key={s}
              className="flex items-center justify-between gap-2 bg-white/5 border border-dashed border-white/20 rounded-lg p-2"
            >
              <span className="text-xs text-gray-300 flex-1">{s}</span>
              <button
                onClick={() => onAddSuggestion(s)}
                className="text-[10px] font-semibold text-violet-300 hover:text-violet-200 flex items-center gap-1 shrink-0"
              >
                <Plus className="h-3 w-3" aria-hidden="true" /> Add as clause
              </button>
              <button
                onClick={() => onDismissSuggestion(s)}
                aria-label="Dismiss suggestion"
                className="text-gray-500 hover:text-gray-300 shrink-0"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2 border-t border-white/10">
        <Button variant="danger" onClick={onCut}>Cut</Button>
        <Button onClick={handleKeep}>Keep</Button>
      </div>
    </div>
  );
}
