import React, { useMemo, useState } from 'react';
import {
  Cpu, FileOutput, ShieldAlert, Plus, ChevronUp, ChevronDown, X, UploadCloud, Download, Copy,
  Settings as SettingsIcon, GripVertical, Save, History, Sparkles,
} from 'lucide-react';
import type {
  PlaybookClause, PlaybookDraft, PlaybookVersion, Settings, StandardPosition,
} from '../../types';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { draftFromVersion, newPlaybookDraft } from '../../lib/db/playbooks';
import { positionHealthLabel, type PositionHealth } from '../../lib/positionHealth';
import { StandardPositionField } from './StandardPositionField';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { uid } from '../../lib/uid';
import { isAuthError } from '../../lib/openrouter';
import { suggestField, FIELD_LABEL, type SuggestableField } from './suggestField';
import { FieldSuggestion } from './FieldSuggestion';
import { suggestMissingClauses } from './suggestMissingClauses';

export interface TemplateEditorProps {
  /** The current published version, or `undefined` for a playbook that has
   *  never been published. Read-only here — editing produces a draft. */
  version?: PlaybookVersion;
  /** The working copy. Absent means there are no unpublished edits yet; the
   *  first edit creates one from `version`. */
  draft?: PlaybookDraft;
  /** Called with the new working copy on EVERY edit. In-memory only — the
   *  editor never persists per keystroke (R-D16), which is why this is
   *  `onDraftChange` and the persisting one below is not. */
  onDraftChange: (draft: PlaybookDraft) => void;
  /** Persists the working copy as `Playbook.draft`. REQUIRED, not optional:
   *  an optional callback is how five draft mechanisms — `saveDraft`,
   *  `Playbook.draft`, the load-time draft preference, publish-consumes-
   *  draft, and the library's "Unpublished changes" badge — came to ship
   *  with no writer at all. */
  onPersistDraft: () => void;
  /** Opens the version history (spec §8's "link to version history").
   *  REQUIRED for the same reason `onPersistDraft` is: an optional
   *  callback is how a control that leads nowhere ships. */
  onShowVersionHistory: () => void;
  /** True when the working copy differs from what is STORED (a different
   *  question from `hasUnpublishedContent`, which compares against the
   *  published version). Disables Save draft when false. */
  unsavedChanges?: boolean;
  /** A save is in flight. */
  savingDraft?: boolean;
  onPublish: () => void;
  onExport: () => void;
  onShowMegaPrompt: () => void;
  onClose: () => void;
  /** Per-clause health, keyed by clause id — computed by the caller via
   *  `positionHealth` (R-D2 keeps that function pure and store-free).
   *  Absent means "the caller did not work it out", which renders as
   *  nothing at all rather than as `UNTESTED`: an unasked question and a
   *  question answered "no evidence" are different facts. */
  health?: Record<string, PositionHealth>;
  /** Set when the cross-matter review scan that feeds `health` FAILED.
   *  Rendered instead of the chips, never alongside an empty map: an empty
   *  scan renders as `UNTESTED`, which is a claim about the firm's
   *  positions, and "we could not read your reviews" is a fact about the
   *  app. CLAUDE.md's rule that every IndexedDB-backed screen distinguishes
   *  "empty" from "broken" applies to a section of a screen too. */
  healthError?: string;
  onRetryHealth?: () => void;
  /** Powers per-field "Draft this for me" suggestions and "Suggest what I'm
   *  missing" (spec §6, Task 8). Required rather than optional for the same
   *  reason `onPersistDraft` and `onShowVersionHistory` are: an optional
   *  dependency is how `suggestField`/`suggestMissingClauses` shipped tested
   *  and wired to nothing for an entire merge. */
  settings: Settings;
  /** A rejected API key (401/403) on either AI trigger below must route to
   *  Settings, exactly as it does for `ChatPanel`/`DraftForm` (spec §7,
   *  `openrouter.ts`'s `isAuthError` contract) — never render as inline text
   *  beside the field, which is not a per-clause problem a retry can fix.
   *  Entering this editor is not gated by `ensureConfigured`, so a user with
   *  no key configured yet meets these controls before anything has asked
   *  them for one. */
  onAuthError?: () => void;
}

/** One in-flight or completed "draft this for me" for one field of one
 *  clause. `text` is the suggestion, never written into the clause by
 *  anything but an explicit Accept (`FieldSuggestion`'s own rule) — saving
 *  the form reads only `working`, which this state never touches. */
interface FieldSuggestionState {
  text?: string;
  busy: boolean;
  error?: string;
}

function suggestionKey(clauseId: string, field: SuggestableField): string {
  return `${clauseId}:${field}`;
}

/** The one place a brand-new clause's defaults are built — `addClause` and
 *  `addMissingClause` both add a clause with nothing filled in but its
 *  title, and CLAUDE.md's rule is to extract a second copy of a literal
 *  rather than wait for a third. `uid()`, not `Date.now().toString()`: two
 *  clauses added inside one millisecond would otherwise share an id, and
 *  both `run.findings[key][clauseId]` and the position-health map are keyed
 *  by it — one finding would answer for two clauses. */
function newDefaultClause(title: string): PlaybookClause {
  return { id: uid(), title, extractPrompt: 'Instruction...', riskCriteria: '' };
}

/**
 * What the editor is actually showing: the draft when there are unpublished
 * edits, otherwise a fresh editable COPY of the published version.
 *
 * Exported because `App` needs the same answer for Export and DIY mode, and
 * a second copy of this coalesce is exactly the sibling drift that has
 * produced six separate defects in this project. The copy matters: a
 * published version is immutable, and handing its own `clauses` array to an
 * editor is all it takes for a reorder to rewrite history in place.
 */
export function workingContent(version?: PlaybookVersion, draft?: PlaybookDraft): PlaybookDraft {
  if (draft) return draft;
  if (version) return draftFromVersion(version);
  return newPlaybookDraft('');
}

/**
 * Whether `draft` says anything the published version does not.
 *
 * Compared as SERIALISED CONTENT rather than field by field, deliberately.
 * A field-by-field comparison that forgets a field added later would report
 * "no changes" over a real edit and leave Publish disabled with no
 * explanation — the user could not publish at all. Any difference at all,
 * including one this function does not understand, has to fall on the
 * "changed" side, and stringifying both through `draftFromVersion` (the one
 * function that produces an editable copy) does exactly that: two drafts
 * that came from the same producer share key order, and anything else
 * differs and so counts as an edit.
 */
export function hasUnpublishedContent(version?: PlaybookVersion, draft?: PlaybookDraft): boolean {
  if (draft === undefined) return false;
  // Never published: everything in the draft is unpublished by definition.
  if (version === undefined) return true;
  return JSON.stringify(draft) !== JSON.stringify(draftFromVersion(version));
}

export function TemplateEditor({
  version, draft, onDraftChange, onPersistDraft, onShowVersionHistory,
  unsavedChanges = false, savingDraft = false,
  onPublish, onExport, onShowMegaPrompt, onClose, health, healthError, onRetryHealth,
  settings, onAuthError,
}: TemplateEditorProps) {
  // Memoised: without it this re-CLONES the published version on every
  // render for as long as there is no draft, and the editor's copy drifts
  // from `App`'s `editorContent` as a second, structurally-equal object.
  const working = useMemo(() => workingContent(version, draft), [version, draft]);
  const hasUnpublishedChanges = hasUnpublishedContent(version, draft);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Part A — per-field suggestions. Keyed by `${clauseId}:${field}` so
  // accepting, regenerating or dismissing one field's suggestion can never
  // disturb another's, whether that's a different field on the same clause
  // or the same field on a different one.
  const [fieldSuggestions, setFieldSuggestions] = useState<Record<string, FieldSuggestionState>>({});

  const requestFieldSuggestion = (clause: PlaybookClause, field: SuggestableField) => {
    const key = suggestionKey(clause.id, field);
    setFieldSuggestions((prev) => ({ ...prev, [key]: { text: prev[key]?.text, busy: true, error: undefined } }));
    suggestField(field, clause, working.contractType, settings)
      .then((text) => {
        setFieldSuggestions((prev) => ({ ...prev, [key]: { text, busy: false } }));
      })
      .catch((err: unknown) => {
        // A rejected key is not a per-clause problem a retry can fix, and
        // showing it as inline text next to the field tells the user to fix
        // the wrong thing — route it to Settings instead, exactly as
        // ChatPanel/DraftForm do.
        if (isAuthError(err)) {
          setFieldSuggestions((prev) => ({ ...prev, [key]: { text: prev[key]?.text, busy: false } }));
          onAuthError?.();
          return;
        }
        // Any other failure leaves whatever was already displayed (nothing,
        // on a first attempt; the prior suggestion, on a failed regenerate)
        // and says so — it never touches the clause's actual field.
        setFieldSuggestions((prev) => ({
          ...prev,
          [key]: {
            text: prev[key]?.text,
            busy: false,
            error: err instanceof Error ? err.message : 'Could not draft a suggestion. Try again.',
          },
        }));
      });
  };

  const dismissFieldSuggestion = (clauseId: string, field: SuggestableField) => {
    setFieldSuggestions((prev) => {
      const next = { ...prev };
      delete next[suggestionKey(clauseId, field)];
      return next;
    });
  };

  /**
   * THE only place a suggestion is written into a clause (mirrors
   * `FieldSuggestion`'s own doc comment). `updateClause`/`setPosition` below
   * are the same funnels a hand-typed edit uses — there is no second write
   * path for AI-suggested text.
   */
  const acceptFieldSuggestion = (index: number, field: SuggestableField) => {
    const clause = working.clauses[index];
    if (!clause) return;
    const key = suggestionKey(clause.id, field);
    const text = fieldSuggestions[key]?.text;
    if (text === undefined) return;
    if (field === 'extractPrompt') updateClause(index, { extractPrompt: text });
    else if (field === 'riskCriteria') updateClause(index, { riskCriteria: text });
    else setPosition(index, { text, origin: 'ai-drafted', reviewedByHuman: true });
    dismissFieldSuggestion(clause.id, field);
  };

  // Part B — "Suggest what I'm missing" (Task 8). Proposals are titles only,
  // each added or dismissed on its own — there is deliberately no "add all".
  const [missingSuggestions, setMissingSuggestions] = useState<string[]>([]);
  const [missingBusy, setMissingBusy] = useState(false);
  const [missingError, setMissingError] = useState<string | undefined>();

  const requestMissingClauses = () => {
    setMissingBusy(true);
    setMissingError(undefined);
    suggestMissingClauses(working.clauses.map((c) => c.title), working.contractType, settings)
      .then((titles) => {
        setMissingSuggestions(titles);
        setMissingBusy(false);
      })
      .catch((err: unknown) => {
        setMissingBusy(false);
        // Same auth routing as `requestFieldSuggestion` above — a rejected
        // key routes to Settings rather than rendering here.
        if (isAuthError(err)) {
          onAuthError?.();
          return;
        }
        setMissingError(err instanceof Error ? err.message : 'Could not check for missing clauses. Try again.');
      });
  };

  const addMissingClause = (title: string) => {
    updateDraft({
      clauses: [...working.clauses, newDefaultClause(title)],
    });
    setMissingSuggestions((prev) => prev.filter((t) => t !== title));
  };

  const dismissMissingClause = (title: string) => {
    setMissingSuggestions((prev) => prev.filter((t) => t !== title));
  };

  /**
   * THE single funnel for every edit in this editor.
   *
   * `version` is never touched: it is spread into a new object, never
   * assigned into. That is the whole immutability rule, and keeping it in
   * one place is what makes it checkable — see the mutation test in
   * `TemplateEditor.test.tsx`.
   */
  const updateDraft = (patch: Partial<PlaybookDraft>) => {
    onDraftChange({ ...working, ...patch });
  };

  /** The ONE reordering path. Both affordances go through it — the chevrons
   *  (keyboard-reachable, which a drag handle is not) and the drag handle —
   *  so there is no second implementation to drift. */
  const reorderClause = (from: number, to: number) => {
    const count = working.clauses.length;
    if (from === to || from < 0 || to < 0 || from >= count || to >= count) return;
    const next = [...working.clauses];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    updateDraft({ clauses: next });
  };

  const moveClause = (index: number, direction: 'up' | 'down') =>
    reorderClause(index, direction === 'up' ? index - 1 : index + 1);

  const addClause = () => {
    updateDraft({
      clauses: [...working.clauses, newDefaultClause('New Clause')],
    });
  };

  const deleteClause = (index: number) => {
    updateDraft({ clauses: working.clauses.filter((_, i) => i !== index) });
  };

  const updateClause = (index: number, patch: Partial<PlaybookClause>) => {
    updateDraft({
      clauses: working.clauses.map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  };

  /**
   * Minor 5 (integrity review). `''` and an omitted `riskTolerance` are the
   * same fact to every reader — `riskBlock.ts` treats them identically, and
   * `migrateDraft` reads a stored `''` back as absent — but
   * `hasUnpublishedContent`'s JSON-string comparison cannot tell them apart
   * from a genuine edit: typing into this box and deleting it again left
   * Publish enabled over a draft that reviews identically to what is already
   * published, and minted a byte-identical version. `updateDraft`'s merge
   * can only ASSIGN a key, never delete one, so an empty value is built
   * here directly and the key is deleted — the same rule `setPosition`
   * below applies to `standardPosition`, for the same reason.
   */
  const setRiskTolerance = (value: string) => {
    const next: PlaybookDraft = { ...working };
    if (value === '') delete next.riskTolerance;
    else next.riskTolerance = value;
    onDraftChange(next);
  };

  /** Separate from `updateClause` because clearing a position must DELETE
   *  the key, not set it to `undefined`: `structuredClone` — how IndexedDB
   *  writes every record — preserves an `undefined`-valued key, and
   *  `'standardPosition' in clause` is how "does this clause have a house
   *  rule" gets asked. */
  const setPosition = (index: number, position: StandardPosition | undefined) => {
    updateDraft({
      clauses: working.clauses.map((c, i) => {
        if (i !== index) return c;
        const next: PlaybookClause = { ...c };
        if (position) next.standardPosition = position;
        else delete next.standardPosition;
        return next;
      }),
    });
  };

  /** The "Draft this for me" trigger for one field of one clause. Rendered
   *  next to that field's own label, never a shared control for the whole
   *  clause — spec §5's "per field, a 'draft this for me'". */
  const fieldSuggestButton = (idx: number, clause: PlaybookClause, field: SuggestableField) => {
    const state = fieldSuggestions[suggestionKey(clause.id, field)];
    return (
      <button
        type="button"
        onClick={() => requestFieldSuggestion(clause, field)}
        disabled={state?.busy}
        aria-label={`Draft the ${FIELD_LABEL[field]} for ${clause.title}`}
        title={`Draft the ${FIELD_LABEL[field]} with AI`}
        className="text-[10px] flex items-center gap-1 text-violet-300 hover:text-violet-200 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
      >
        <Sparkles className="h-3 w-3" aria-hidden="true" /> {state?.busy ? 'Drafting…' : 'Draft this for me'}
      </button>
    );
  };

  /** The suggestion itself, rendered visibly unaccepted via `FieldSuggestion`
   *  — nothing here writes into the clause; only `acceptFieldSuggestion`
   *  (wired to `onAccept`) does. */
  const fieldSuggestBox = (idx: number, clause: PlaybookClause, field: SuggestableField) => {
    const state = fieldSuggestions[suggestionKey(clause.id, field)];
    if (!state) return null;
    return (
      <div className="mt-1">
        {state.error && <p className="text-[11px] text-red-400 mb-1">{state.error}</p>}
        {state.text !== undefined && (
          <FieldSuggestion
            text={state.text}
            busy={state.busy}
            onAccept={() => acceptFieldSuggestion(idx, field)}
            onRegenerate={() => requestFieldSuggestion(clause, field)}
            onDismiss={() => dismissFieldSuggestion(clause.id, field)}
          />
        )}
      </div>
    );
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <input
            value={working.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            aria-label="Playbook name"
            className="text-2xl font-bold bg-transparent text-white border-b border-transparent hover:border-white/20 focus:border-violet-500 outline-none px-1 w-full md:w-auto"
          />
          {version && (
            <span className="text-xs font-mono text-gray-500 border border-white/10 rounded px-2 py-1">
              v{version.version}
            </span>
          )}
          {/* A version is immutable, so what is on screen is either exactly
             the published version or a draft that has not reached any
             review yet. Saying which is the difference between a reviewer
             running the clauses they just wrote and running the previous
             ones without being told. */}
          {!version ? (
            <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              Not published yet — publish before running a review
            </span>
          ) : hasUnpublishedChanges ? (
            <span className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
              Unpublished changes — reviews still run v{version.version}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto justify-end items-center">
          <button onClick={onShowMegaPrompt} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors border border-blue-500/30 text-xs md:text-sm"><Copy className="h-4 w-4" /> DIY Mode</button>
          {/* Spec §8. Disabled rather than hidden when there is no published
             version: there is genuinely no history to show, and saying so
             is better than the control vanishing without explanation. */}
          <button
            onClick={onShowVersionHistory}
            disabled={!version}
            title={version ? 'See what each published version said.' : 'Nothing published yet — there is no history.'}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors border border-white/10 text-xs md:text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <History className="h-4 w-4" /> Version history
          </button>
          <button onClick={onExport} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors border border-white/10 text-xs md:text-sm"><Download className="h-4 w-4" /> Export</button>
          {/* R-D16. Drafts are persisted on EXPLICIT INTENT — this control
             and the Keep branch of the leave prompt — never per keystroke:
             per-keystroke writes would contradict the in-memory discard
             semantics Task 3's fix round established. Until this existed,
             nothing in the app ever wrote a `Playbook.draft`, so the
             library's "Unpublished changes" badge could not appear. */}
          <button
            onClick={onPersistDraft}
            disabled={!unsavedChanges || savingDraft}
            title={unsavedChanges ? 'Save these edits as a draft you can come back to.' : 'Nothing unsaved — this is what is stored.'}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors border border-white/10 text-xs md:text-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Save className="h-4 w-4" /> {savingDraft ? 'Saving…' : 'Save draft'}
          </button>
          {/* Disabled unless the draft actually SAYS something the published
             version does not: republishing unchanged content produces two
             byte-identical versions minutes apart, which a version history
             cannot explain — a real library already carries one such pair.
             Gating on the draft merely existing left this enabled after an
             edit that was typed and undone (m2). */}
          <button
            onClick={onPublish}
            disabled={!hasUnpublishedChanges}
            title={hasUnpublishedChanges ? undefined : 'Nothing to publish — this is the published version.'}
            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors border border-green-500/30 text-xs md:text-sm font-bold disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <UploadCloud className="h-4 w-4" /> Publish
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-white px-2">Close</button>
        </div>
      </div>

      {/* Grid Layout */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-3 gap-6 pb-2">
        {/* Left Column: Global Settings */}
        <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar">
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><Cpu className="h-4 w-4" /> System Persona</label>
            <AutoResizeTextarea
              value={working.systemPrompt}
              onChange={(e) => updateDraft({ systemPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><FileOutput className="h-4 w-4" /> Format & Rules</label>
            <AutoResizeTextarea
              value={working.formatPrompt}
              onChange={(e) => updateDraft({ formatPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          {/* R-D1: always visible. The Standard/Risk toggle that used to hide
              this is gone, and what decides whether a review assesses risk is
              now whether this field (or a clause's own criteria) has anything
              in it — so a hidden field would be a hidden decision. */}
          <div className="bg-red-900/10 border border-red-500/30 rounded-xl p-5">
            <label className="block text-sm font-medium text-red-300 mb-2 flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Global Risk Tolerance</label>
            <AutoResizeTextarea
              value={working.riskTolerance || ''}
              onChange={(e) => setRiskTolerance(e.target.value)}
              placeholder="e.g. We are risk-averse regarding uncapped liability..."
              className="w-full bg-black/50 border border-red-500/20 rounded-lg p-3 text-sm text-gray-300 focus:border-red-500 outline-none min-h-[100px]"
            />
            <p className="mt-2 text-[11px] text-gray-500">
              Applies to every clause that has no criteria of its own. There is no risk mode any
              more: what is written here and in each clause's Risk Scorer is what decides. Leave
              them all empty and no risk criteria are sent at all.
            </p>
          </div>
        </div>

        {/* Right Column: Clauses (Spans 2 cols on large screens) */}
        <div className="lg:col-span-2 flex flex-col h-full bg-[#111] border border-white/10 rounded-xl overflow-hidden shadow-lg">
          <div className="p-4 border-b border-white/10 bg-[#161616] flex justify-between items-center shrink-0">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2"><SettingsIcon className="h-4 w-4 text-violet-500" /> Extraction Clauses ({working.clauses.length})</h3>
            <button onClick={addClause} className="text-xs flex items-center gap-1 bg-violet-600 px-3 py-1.5 rounded hover:bg-violet-500 text-white transition-colors font-medium"><Plus className="h-3 w-3" /> Add Clause</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {/* Instead of the chips, never beside them. A failed scan that
               fell back to an empty map would render every position as
               having no evidence, which reads as a finding about the
               playbook rather than a failure of the app. */}
            {healthError && (
              <LoadErrorPanel message={healthError} onRetry={onRetryHealth} compact />
            )}
            {working.clauses.map((clause, idx) => {
              const clauseHealth = health?.[clause.id];
              return (
                <div
                  key={clause.id}
                  onDragOver={(e) => { if (dragIndex !== null) e.preventDefault(); }}
                  onDrop={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    reorderClause(dragIndex, idx);
                    setDragIndex(null);
                  }}
                  className={`group relative p-0.5 rounded-xl bg-gradient-to-r transition-all duration-300 ${dragIndex === idx ? 'from-violet-500/40 to-violet-500/20' : 'from-white/5 to-white/10'}`}
                >
                  <div className="bg-[#0a0a0a] p-4 rounded-[10px] flex flex-col md:flex-row gap-4 items-start relative border border-white/5">
                    {/* Reordering Controls. The chevrons are the accessible
                       path and stay: a drag handle cannot be reached from a
                       keyboard. The handle below is a second affordance over
                       the same `reorderClause`, hidden from assistive tech
                       because it would announce a duplicate of what the
                       chevrons already offer. */}
                    <div className="flex flex-col items-center gap-1 pt-1 md:border-r md:border-white/10 md:pr-4">
                      <button
                        onClick={() => moveClause(idx, 'up')}
                        disabled={idx === 0}
                        aria-label={`Move ${clause.title} up`}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"
                      ><ChevronUp className="h-4 w-4" /></button>
                      <span className="text-[10px] text-gray-600 font-mono font-bold">{idx + 1}</span>
                      <button
                        onClick={() => moveClause(idx, 'down')}
                        disabled={idx === working.clauses.length - 1}
                        aria-label={`Move ${clause.title} down`}
                        className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"
                      ><ChevronDown className="h-4 w-4" /></button>
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
                        className="mt-1 cursor-grab active:cursor-grabbing text-gray-700 hover:text-gray-400"
                      ><GripVertical className="h-4 w-4" /></span>
                    </div>

                    {/* Content */}
                    <div className="flex-1 w-full space-y-3">
                      <div className="flex justify-between items-start">
                        <input
                          value={clause.title}
                          onChange={(e) => updateClause(idx, { title: e.target.value })}
                          className="bg-transparent font-bold text-white outline-none w-[90%] focus:text-violet-400 transition-colors text-sm md:text-base border-b border-transparent focus:border-violet-500/50"
                          placeholder="Clause Title"
                          aria-label="Clause title"
                        />
                        <button onClick={() => deleteClause(idx)} aria-label={`Delete ${clause.title}`} className="text-gray-600 hover:text-red-400 transition-colors p-1 opacity-0 group-hover:opacity-100"><X className="h-4 w-4" /></button>
                      </div>
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <label className="text-[10px] text-gray-500 uppercase tracking-wider font-bold block">Extraction Instruction</label>
                          {fieldSuggestButton(idx, clause, 'extractPrompt')}
                        </div>
                        <AutoResizeTextarea
                          value={clause.extractPrompt}
                          onChange={(e) => updateClause(idx, { extractPrompt: e.target.value })}
                          className="w-full bg-white/5 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:ring-1 focus:ring-violet-500/50 border border-transparent focus:border-violet-500/30"
                          placeholder="What to extract..."
                        />
                        {fieldSuggestBox(idx, clause, 'extractPrompt')}
                      </div>
                      <div>
                        <div className="flex items-center justify-end mb-1">
                          {fieldSuggestButton(idx, clause, 'standardPosition')}
                        </div>
                        <StandardPositionField
                          position={clause.standardPosition}
                          onChange={(position) => setPosition(idx, position)}
                        />
                        {fieldSuggestBox(idx, clause, 'standardPosition')}
                      </div>
                      {/* Nothing at all when the caller supplied no map,
                         and nothing when the scan failed — the panel above
                         says why. A defaulted `UNTESTED` here would be the
                         app inventing an answer to a question it could not
                         ask. */}
                      {clauseHealth && !healthError && (
                        <p className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
                          {positionHealthLabel(clauseHealth)}
                        </p>
                      )}
                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <label className="text-[10px] text-red-400 uppercase tracking-wider flex items-center gap-1 font-bold"><ShieldAlert className="h-3 w-3" /> Risk Scorer</label>
                          {fieldSuggestButton(idx, clause, 'riskCriteria')}
                        </div>
                        <AutoResizeTextarea
                          value={clause.riskCriteria || ''}
                          onChange={(e) => updateClause(idx, { riskCriteria: e.target.value })}
                          className="w-full bg-red-900/10 border border-red-500/10 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:border-red-500/50"
                          placeholder="Specific criteria (e.g., 'Must be mutual'). Leave blank to use Global Risk."
                        />
                        {fieldSuggestBox(idx, clause, 'riskCriteria')}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            {working.clauses.length === 0 && <div className="text-center text-gray-500 py-10 border border-dashed border-white/10 rounded-xl">No clauses defined. Add one to get started.</div>}

            {/* "Suggest what I'm missing" (spec §6, Task 8). Titles only —
               each proposal is added or dismissed on its own; there is no
               "add all", because every clause entering a playbook is meant
               to be a decision, not a batch import. */}
            <div className="pt-3 mt-2 border-t border-white/10 space-y-2">
              <button
                type="button"
                onClick={requestMissingClauses}
                disabled={missingBusy}
                className="text-xs flex items-center gap-1.5 text-violet-300 hover:text-violet-200 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                {missingBusy ? 'Checking for gaps…' : "Suggest what I'm missing"}
              </button>
              {missingError && <p className="text-xs text-red-400">{missingError}</p>}
              {missingSuggestions.length > 0 && (
                <ul className="space-y-2">
                  {missingSuggestions.map((title) => (
                    <li
                      key={title}
                      className="flex items-center justify-between gap-2 bg-violet-500/5 border border-dashed border-violet-500/40 rounded-lg p-2"
                    >
                      <span className="text-xs text-gray-200">{title}</span>
                      <span className="flex gap-3 shrink-0">
                        <button
                          type="button"
                          onClick={() => dismissMissingClause(title)}
                          className="text-[10px] font-semibold text-gray-400 hover:text-gray-200"
                        >
                          Dismiss
                        </button>
                        <button
                          type="button"
                          onClick={() => addMissingClause(title)}
                          className="text-[10px] font-semibold text-violet-300 hover:text-violet-200 flex items-center gap-1"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" /> Add clause
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
