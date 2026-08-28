import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert, Scale, Sparkles, Plus, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { ClauseRail, DISPOSITION_LABEL } from './ClauseRail';
import {
  canSaveDraft,
  saveGateLabel,
  keepClause,
  cutClause,
  editClause,
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

  /**
   * What is currently typed into the clause editor, and which clause it
   * belongs to.
   *
   * Integrity review (D/E), Major 6. `ClauseEditor`'s fields are local state
   * remounted on every clause switch (see its docstring - the remount is
   * deliberate), which made them a buffer only `Keep` ever drained: moving
   * via the rail threw away what had been typed, and a clause already marked
   * `Kept` went on reading `Kept` over the superseded wording. Widening the
   * buffer's LIFETIME is the fix - it is reported up here on every change
   * and folded into the draft on every route out of the clause.
   *
   * A ref, not state, because nothing renders from it: writing it on every
   * keystroke through `useState` would re-render the screen for no visible
   * change. The clause id travels with it so a commit can never land the
   * wrong clause's text.
   */
  const pendingRef = useRef<{ clauseId: string; edits: Partial<PlaybookClause> } | null>(null);

  /** The draft with whatever is typed folded in. `editClause` returns the
   *  SAME object when nothing differs, so an untouched clause commits
   *  nothing and records no engagement (R-E5). */
  const withPendingEdits = (current: AuthoringDraft): AuthoringDraft => {
    const pending = pendingRef.current;
    if (!pending) return current;
    return editClause(current, pending.clauseId, pending.edits);
  };

  /** Folds the buffer into the draft and reports it. */
  const commitPendingEdits = (): AuthoringDraft => {
    const next = withPendingEdits(draft);
    if (next !== draft) onChange(next);
    return next;
  };

  /** Every route out of a clause goes through here, so a route added later
   *  cannot forget to drain the buffer. */
  const goToClause = (clauseId: string) => {
    if (clauseId === activeId) return;
    commitPendingEdits();
    setActiveId(clauseId);
  };

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
        goToClause(draft.clauses[nextIndex].id);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // Re-bound every render rather than on [draft.clauses, activeId]:
    // `goToClause` closes over `onChange` and the current `draft`, and a
    // listener held over from an earlier render would commit the buffer
    // onto a stale draft. Rebinding a single window listener per render is
    // cheap; a stale closure that silently drops an edit is not.
  });

  const activeClause = draft.clauses.find((c) => c.id === activeId);
  const canSave = canSaveDraft(draft);
  const saveLabel = saveGateLabel(draft);
  const reviewedCount = draft.clauses.filter((c) => c.disposition !== 'unreviewed').length;

  const handleKeep = (edits: Partial<PlaybookClause>) => {
    if (!activeClause) return;
    // The buffer holds exactly these edits for exactly this clause, so
    // there is nothing separate to commit: `keepClause` applies them and
    // computes the flags by the same comparison.
    pendingRef.current = null;
    onChange(keepClause(draft, activeClause.id, edits));
  };

  /** Cutting is not a reason to lose what was typed: a cut clause can be
   *  kept again from this same pane, and it would come back carrying the
   *  superseded wording. */
  const handleCut = () => {
    if (!activeClause) return;
    onChange(cutClause(withPendingEdits(draft), activeClause.id));
    pendingRef.current = null;
  };

  /** Major 4: the publish must see what the screen holds NOW, buffer
   *  included. `App`'s handler reads back the draft this reports rather
   *  than the one its own render closed over. */
  const handleSave = () => {
    commitPendingEdits();
    onSave();
  };

  const handleAddSuggestion = (text: string) => {
    if (!activeClause) return;
    const newClause: DraftClause = {
      id: uid(),
      title: text,
      extractPrompt: text,
      disposition: 'unreviewed',
      edited: false,
      positionEdited: false,
      suggestions: [],
    };
    const current = withPendingEdits(draft);
    onChange({
      ...current,
      clauses: current.clauses.flatMap((c) =>
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
    const current = withPendingEdits(draft);
    onChange({
      ...current,
      clauses: current.clauses.map((c) =>
        c.id === activeClause.id ? { ...c, suggestions: c.suggestions.filter((s) => s !== text) } : c,
      ),
    });
  };

  return (
    <div
      // `h-full`, not `calc(100vh - 64px)`: the app header's height is
      // content-dependent since it gained `flex-wrap`, and `main` is
      // already sized to whatever it left over. See App.tsx's results
      // wrapper for the failure the hardcoded arithmetic invites.
      className="p-6 max-w-7xl mx-auto h-full flex flex-col bg-paper"
    >
      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6 shrink-0">
        <div>
          <span className="inline-block font-mono text-chip uppercase text-draft border border-draft rounded-chip px-1.5 py-0.5">
            Unsaved draft
          </span>
          <h2 className="font-prose text-screen-title text-ink-1 mt-2">{draft.contractType}</h2>
          <p className="font-ui text-meta text-ink-4 mt-1">
            {reviewedCount} of {draft.clauses.length} clauses reviewed
            {draft.learnedFrom.length > 0 && <> &middot; learned from {draft.learnedFrom.join(', ')}</>}
          </p>
        </div>
        <div className="flex gap-3 shrink-0">
          <Button variant="ghost" onClick={handleDiscard} disabled={saving}>Discard</Button>
          <Button onClick={handleSave} disabled={!canSave || saving} loading={saving}>
            {saveLabel}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-hidden grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
        <ClauseRail
          clauses={draft.clauses} activeId={activeId} onSelect={goToClause} disabled={saving}
        />

        <div className="overflow-y-auto custom-scrollbar bg-card border border-rule rounded-card p-5">
          {activeClause ? (
            <ClauseEditor
              key={activeClause.id}
              clause={activeClause}
              onKeep={handleKeep}
              onCut={handleCut}
              onPendingChange={(edits) => {
                pendingRef.current = { clauseId: activeClause.id, edits };
              }}
              onAddSuggestion={handleAddSuggestion}
              onDismissSuggestion={handleDismissSuggestion}
              saving={saving}
            />
          ) : (
            <p className="font-ui text-meta text-ink-4 italic">No clauses to review.</p>
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
  /** Reports the current field values on every change, so the parent can
   *  fold them into the draft when this component is about to be replaced.
   *  The parent writes them to a ref, so this re-renders nothing. */
  onPendingChange: (edits: Partial<PlaybookClause>) => void;
  onAddSuggestion: (text: string) => void;
  onDismissSuggestion: (text: string) => void;
  /** Every control that can mutate the draft is dead while a publish is in
   *  flight: a control that responds normally but cannot reach the version
   *  being written is worse than a disabled one (Major 4). Re-review N2:
   *  Major 4's fix threaded this into Keep, Cut and the textareas but left
   *  the two suggestion buttons live — "Add as clause" could insert an
   *  `unreviewed` clause into the ref mid-`saveDraftAsV1`, either failing a
   *  publish that had already started or being silently discarded along
   *  with the whole draft. Both suggestion buttons take `saving` now too. */
  saving?: boolean;
}

/**
 * Local field state, remounted (via `key={clause.id}` on the parent's use of
 * this component) on every clause switch rather than re-synced by an effect
 * — the same pattern `DraftForm` uses for `initialValues`, deliberately: an
 * effect that resets state on a prop change can be clobbered by another
 * effect in the same commit (CLAUDE.md: effects run in declaration order),
 * and a remount sidesteps that class of bug entirely.
 */
function ClauseEditor({
  clause, onKeep, onCut, onPendingChange, onAddSuggestion, onDismissSuggestion, saving = false,
}: ClauseEditorProps) {
  const [extractPrompt, setExtractPrompt] = useState(clause.extractPrompt);
  const [riskCriteria, setRiskCriteria] = useState(clause.riskCriteria ?? '');
  const [positionText, setPositionText] = useState(clause.standardPosition?.text ?? '');

  /** ONE reading of the fields, shared by Keep and by the report to the
   *  parent. Two would be two normalisations to keep in step, and the
   *  normalisation is what stops an untouched blank field reading as an
   *  edit. */
  const currentEdits = (): Partial<PlaybookClause> => {
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
      // Minor 1 (final honesty review): blanking the textarea REMOVES the
      // position rather than saving `{ text: '' }` — mirrors
      // `StandardPositionField`'s guard (`src/features/templates/
      // StandardPositionField.tsx`) for the exact reason stated there: a
      // position with no text reads as a house rule ("We ask for ") until
      // something looks at it, and it would be published into an immutable
      // version this way rather than dropped, unlike `migratePosition`'s
      // read-time repair. Explicit `undefined` in the edits object, not an
      // omitted key: `keepClause` spreads `edits` onto the clause, and only
      // an explicit `undefined` here clears an existing `standardPosition`.
      edits.standardPosition = positionText.trim() === ''
        ? undefined
        : { ...clause.standardPosition, text: positionText };
    }
    return edits;
  };

  // Reported from an effect rather than from each field's `onChange`, so a
  // field added later cannot be wired up without it. It also fires on
  // mount, which is correct and free: those values equal the clause's, and
  // `editClause` returns the draft unchanged for that.
  useEffect(() => {
    onPendingChange(currentEdits());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractPrompt, riskCriteria, positionText]);

  const handleKeep = () => onKeep(currentEdits());

  const dispositionClass =
    clause.disposition === 'kept'
      ? 'text-accent'
      : clause.disposition === 'cut'
        ? 'text-risk-high'
        : 'text-ink-4';

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <h3 data-active-clause className="font-prose text-clause text-ink-1">{clause.title}</h3>
        <span className={`font-mono text-chip uppercase shrink-0 mt-1 ${dispositionClass}`}>
          {DISPOSITION_LABEL[clause.disposition]}
        </span>
      </div>

      <div>
        <label className="block font-mono text-label text-ink-4 uppercase mb-1">
          Extraction instructions
        </label>
        <AutoResizeTextarea
          aria-label="Extraction instructions"
          disabled={saving}
          value={extractPrompt}
          onChange={(e) => setExtractPrompt(e.target.value)}
          className="w-full bg-paper border border-rule rounded-control p-3 text-sm text-ink-2 outline-none focus:border-accent min-h-[70px]"
        />
      </div>

      <div>
        <label className="block font-mono text-label text-risk-high uppercase mb-1 flex items-center gap-1">
          <ShieldAlert className="h-3 w-3" aria-hidden="true" /> Risk criteria
        </label>
        <AutoResizeTextarea
          aria-label="Risk criteria"
          disabled={saving}
          value={riskCriteria}
          onChange={(e) => setRiskCriteria(e.target.value)}
          placeholder="Leave blank to use the playbook's global risk tolerance."
          className="w-full bg-risk-high-tint border border-risk-high-edge rounded-control p-3 text-sm text-ink-2 outline-none focus:border-risk-high min-h-[60px]"
        />
      </div>

      {clause.standardPosition && (
        <div className="bg-chip-fill border border-rule rounded-inset p-3 space-y-2">
          <div className="flex items-center gap-1 font-mono text-label text-ink-4 uppercase">
            <Scale className="w-3 h-3" aria-hidden="true" /> Standard position
          </div>
          {!clause.standardPosition.reviewedByHuman && (
            <p className="font-mono text-label uppercase text-risk-med">
              Drafted by AI &mdash; not yet reviewed by a person.
            </p>
          )}
          <AutoResizeTextarea
            aria-label="Standard position"
          disabled={saving}
            value={positionText}
            onChange={(e) => setPositionText(e.target.value)}
            className="w-full bg-paper border border-rule rounded-control p-2 text-xs text-ink-2 outline-none focus:border-accent min-h-[50px]"
          />
        </div>
      )}

      {clause.suggestions.length > 0 && (
        <div className="space-y-2">
          <p className="flex items-center gap-1 font-mono text-label text-ink-4 uppercase">
            <Sparkles className="w-3 h-3" aria-hidden="true" /> Suggested sub-questions
          </p>
          {clause.suggestions.map((s) => (
            <div
              key={s}
              className="flex items-center justify-between gap-2 bg-chip-fill border border-dashed border-rule-strong rounded-inset p-2"
            >
              <span className="text-xs text-ink-2 flex-1">{s}</span>
              <button
                onClick={() => onAddSuggestion(s)}
                disabled={saving}
                className="text-[10px] font-semibold text-accent hover:text-accent-strong flex items-center gap-1 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Plus className="h-3 w-3" aria-hidden="true" /> Add as clause
              </button>
              <button
                onClick={() => onDismissSuggestion(s)}
                disabled={saving}
                aria-label="Dismiss suggestion"
                className="text-ink-4 hover:text-ink-2 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-3 pt-2 border-t border-rule">
        <Button variant="danger" onClick={onCut} disabled={saving}>Cut</Button>
        <Button onClick={handleKeep} disabled={saving}>Keep</Button>
      </div>
    </div>
  );
}
