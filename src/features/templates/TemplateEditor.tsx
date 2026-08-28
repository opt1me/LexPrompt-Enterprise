import React, { useMemo, useState } from 'react';
import {
  ShieldAlert, Plus, X, UploadCloud, Download, Copy, Save, History, Sparkles, ScanText,
} from 'lucide-react';
import type {
  PlaybookClause, PlaybookDraft, PlaybookVersion, Settings, StandardPosition,
} from '../../types';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';
import { Button } from '../../components/Button';
import { draftFromVersion, newPlaybookDraft } from '../../lib/db/playbooks';
import { positionHealthLabel, type PositionHealth } from '../../lib/positionHealth';
import { StandardPositionField } from './StandardPositionField';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { uid } from '../../lib/uid';
import { isAuthFailure } from '../../lib/model/authFailure';
import { suggestField, FIELD_LABEL, type SuggestableField } from './suggestField';
import { FieldSuggestion } from './FieldSuggestion';
import { suggestMissingClauses } from './suggestMissingClauses';
import { ClauseListRail } from './ClauseListRail';
import { PromptConfigPanel } from './PromptConfigPanel';

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
   *  `isAuthFailure`'s contract) — never render as inline text
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

/** The three fields a clause can carry a suggestion for, in the order they
 *  are rendered. Iterated by the "use all" control below, so that control
 *  can never fall out of step with the boxes it claims to accept. */
const SUGGESTABLE_FIELDS: readonly SuggestableField[] = ['extractPrompt', 'riskCriteria', 'standardPosition'];

/**
 * The clause patch one accepted suggestion produces — the ONE place a
 * suggestion becomes clause content.
 *
 * A single accept and a bulk accept both reduce over this and both hand the
 * result to `updateClause`, the same funnel a hand-typed edit uses. That is
 * the whole point: a bulk control is an explicit act, so it may exist, but
 * it may not be a SECOND write path, because a second path is how the rule
 * "only accepting writes a suggestion into a field" comes to be true of one
 * route and not the other.
 *
 * `origin: 'ai-drafted'` on a position, always: the words came from the
 * model, and only `reviewedByHuman` records that a person then took them.
 * Collapsing those two facts is exactly how an AI draft nobody read comes to
 * be presented as the firm's position.
 */
function suggestionPatch(field: SuggestableField, text: string): Partial<PlaybookClause> {
  if (field === 'extractPrompt') return { extractPrompt: text };
  if (field === 'riskCriteria') return { riskCriteria: text };
  return { standardPosition: { text, origin: 'ai-drafted', reviewedByHuman: true } };
}

/**
 * `positionHealthLabel`'s four kinds, stay four, stay visually distinct
 * (§8.3): `held` accent, `conceded` risk-med, `untested` ink-4, `no-position`
 * ink-5 — deliberately NOT the same ink as `untested`, because "we have no
 * house rule here" and "we have one nothing has tested" are different facts.
 *
 * A literal record, not a template-built class name: Tailwind's compiler
 * only picks up class names it can find as complete strings in source, and
 * `PositionHealth['kind']`'s `no-position` doesn't share a spelling with the
 * `--color-health-none` token it maps to, so `text-health-${kind}` would
 * both silently fail to compile AND read a class that doesn't exist for that
 * one case.
 */
const HEALTH_INK: Record<PositionHealth['kind'], string> = {
  held: 'text-health-held',
  conceded: 'text-health-conceded',
  untested: 'text-health-untested',
  'no-position': 'text-health-none',
};

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

  /**
   * Which clause the main pane is showing. The editor renders ONE clause at
   * a time (the previous layout expanded all of them at once, three walls of
   * text each); the rail is how a reader moves between them.
   *
   * Resolved by DERIVATION rather than by an effect that syncs state to
   * props. `working` comes from the parent, so a clause this component just
   * asked to add may or may not come back — and an effect correcting the
   * selection afterwards would be one more "runs in declaration order" trap
   * of the kind CLAUDE.md records. An id that no longer names a clause
   * simply falls back to the first one.
   */
  const [activeClauseId, setActiveClauseId] = useState<string | undefined>(undefined);
  const foundIndex = working.clauses.findIndex((c) => c.id === activeClauseId);
  const activeIndex = foundIndex >= 0 ? foundIndex : (working.clauses.length > 0 ? 0 : -1);
  const activeClause = activeIndex >= 0 ? working.clauses[activeIndex] : undefined;

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
        if (isAuthFailure(err)) {
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
   * `FieldSuggestion`'s own doc comment). `updateClause` is the same funnel
   * a hand-typed edit uses — there is no second write path for AI-suggested
   * text, and nothing else in this component reads `fieldSuggestions` into
   * the working copy. Saving the form reads only `working`.
   *
   * Takes a LIST because "use all" and "use this" are the same act at
   * different widths. Batched into one `updateClause` deliberately: calling
   * a single-field accept three times would compute each patch from the
   * same stale `working`, and the last write would silently drop the first
   * two — a bulk control that quietly accepted one of three suggestions
   * while saying it took them all.
   */
  const acceptFieldSuggestions = (index: number, fields: readonly SuggestableField[]) => {
    const clause = working.clauses[index];
    if (!clause) return;
    const taken = fields.filter((f) => fieldSuggestions[suggestionKey(clause.id, f)]?.text !== undefined);
    if (taken.length === 0) return;
    const patch = taken.reduce<Partial<PlaybookClause>>(
      (acc, f) => ({ ...acc, ...suggestionPatch(f, fieldSuggestions[suggestionKey(clause.id, f)]!.text!) }),
      {},
    );
    updateClause(index, patch);
    setFieldSuggestions((prev) => {
      const next = { ...prev };
      for (const f of taken) delete next[suggestionKey(clause.id, f)];
      return next;
    });
  };

  const acceptFieldSuggestion = (index: number, field: SuggestableField) =>
    acceptFieldSuggestions(index, [field]);

  // Part B — "Suggest what I'm missing" (Task 8). Proposals are titles only;
  // each can be added or dismissed on its own, and "Add all" adds every one
  // of them at once. Both routes go through `addMissingClauses` below — the
  // bulk control is an explicit act, not an implicit adoption, and it writes
  // through the same funnel the one-at-a-time control does.
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
        if (isAuthFailure(err)) {
          onAuthError?.();
          return;
        }
        setMissingError(err instanceof Error ? err.message : 'Could not check for missing clauses. Try again.');
      });
  };

  /** One accepted proposal or every one of them — the same act at two
   *  widths, and one write. Appending them one call at a time would compute
   *  each new `clauses` array from the same stale `working` and keep only
   *  the last title, so "Add all 6" would add one clause and say it added
   *  six. */
  const addMissingClauses = (titles: readonly string[]) => {
    const added = titles.map(newDefaultClause);
    if (added.length === 0) return;
    updateDraft({ clauses: [...working.clauses, ...added] });
    setMissingSuggestions((prev) => prev.filter((t) => !titles.includes(t)));
    setActiveClauseId(added[0]!.id);
  };

  const addMissingClause = (title: string) => addMissingClauses([title]);

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

  const addClause = () => {
    const clause = newDefaultClause('New Clause');
    updateDraft({ clauses: [...working.clauses, clause] });
    // The main pane shows one clause; adding one and staying put would look
    // like nothing happened.
    setActiveClauseId(clause.id);
  };

  const deleteClause = (index: number) => {
    updateDraft({ clauses: working.clauses.filter((_, i) => i !== index) });
    const next = working.clauses[index + 1] ?? working.clauses[index - 1];
    setActiveClauseId(next?.id);
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
        className="font-ui text-meta flex items-center gap-1 text-draft hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
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
        {state.error && <p className="font-ui text-meta text-risk-high mb-1">{state.error}</p>}
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


  // Every suggestion currently DISPLAYED for the active clause. The "use
  // all" control below exists only when there is more than one — a "use all"
  // over a single suggestion is noise, and the box's own "Use this" already
  // says it better.
  const showingFields = activeClause
    ? SUGGESTABLE_FIELDS.filter((f) => fieldSuggestions[suggestionKey(activeClause.id, f)]?.text !== undefined)
    : [];

  const activeHealth = activeClause ? health?.[activeClause.id] : undefined;

  return (
    <div
      // `h-full`, not `calc(100vh - 64px)`: the app header's height is
      // content-dependent since it gained `flex-wrap`, and `main` is
      // already sized to whatever it left over. See App.tsx's results
      // wrapper for the failure the hardcoded arithmetic invites.
      className="p-6 max-w-7xl mx-auto h-full flex flex-col bg-paper"
    >
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          <input
            value={working.name}
            onChange={(e) => updateDraft({ name: e.target.value })}
            aria-label="Playbook name"
            className="font-prose text-screen-title font-medium bg-transparent text-ink-1 border-b border-transparent hover:border-rule focus:border-accent outline-none px-1 w-full md:w-auto"
          />
          {version && (
            <span className="font-mono text-chip text-ink-4 border border-rule rounded-chip px-2 py-1">
              v{version.version}
            </span>
          )}
          {/* A version is immutable, so what is on screen is either exactly
             the published version or a draft that has not reached any
             review yet. Saying which is the difference between a reviewer
             running the clauses they just wrote and running the previous
             ones without being told. */}
          {!version ? (
            <span className="font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-control px-2 py-1">
              Not published yet — publish before running a review
            </span>
          ) : hasUnpublishedChanges ? (
            <span className="font-ui text-ui-sm text-risk-med bg-risk-med-tint border border-risk-med-edge rounded-control px-2 py-1">
              Unpublished changes — reviews still run v{version.version}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto justify-end items-center">
          <Button variant="ghost" onClick={onShowMegaPrompt}><Copy className="h-4 w-4" /> DIY Mode</Button>
          {/* Spec §8. Disabled rather than hidden when there is no published
             version: there is genuinely no history to show, and saying so
             is better than the control vanishing without explanation. */}
          <Button
            variant="ghost"
            onClick={onShowVersionHistory}
            disabled={!version}
            title={version ? 'See what each published version said.' : 'Nothing published yet — there is no history.'}
          >
            <History className="h-4 w-4" /> Version history
          </Button>
          <Button variant="ghost" onClick={onExport}><Download className="h-4 w-4" /> Export</Button>
          {/* R-D16. Drafts are persisted on EXPLICIT INTENT — this control
             and the Keep branch of the leave prompt — never per keystroke:
             per-keystroke writes would contradict the in-memory discard
             semantics Task 3's fix round established. Until this existed,
             nothing in the app ever wrote a `Playbook.draft`, so the
             library's "Unpublished changes" badge could not appear. */}
          <Button
            variant="ghost"
            onClick={onPersistDraft}
            disabled={!unsavedChanges || savingDraft}
            loading={savingDraft}
            title={unsavedChanges ? 'Save these edits as a draft you can come back to.' : 'Nothing unsaved — this is what is stored.'}
          >
            {!savingDraft && <Save className="h-4 w-4" />} {savingDraft ? 'Saving…' : 'Save draft'}
          </Button>
          {/* Disabled unless the draft actually SAYS something the published
             version does not: republishing unchanged content produces two
             byte-identical versions minutes apart, which a version history
             cannot explain — a real library already carries one such pair.
             Gating on the draft merely existing left this enabled after an
             edit that was typed and undone (m2). */}
          <Button
            onClick={onPublish}
            disabled={!hasUnpublishedChanges}
            title={hasUnpublishedChanges ? undefined : 'Nothing to publish — this is the published version.'}
          >
            <UploadCloud className="h-4 w-4" /> Publish
          </Button>
          <button onClick={onClose} className="font-ui text-ui-sm text-ink-4 hover:text-ink-1 px-2">Close</button>
        </div>
      </div>

      {/* Set once, rarely revisited, and previously the busiest thing on the
         screen. Its collapsed header still states whether a global risk
         tolerance is set, so R-D1's "no hidden decision" survives the fold. */}
      <PromptConfigPanel
        systemPrompt={working.systemPrompt}
        formatPrompt={working.formatPrompt}
        riskTolerance={working.riskTolerance}
        onSystemPromptChange={(value) => updateDraft({ systemPrompt: value })}
        onFormatPromptChange={(value) => updateDraft({ formatPrompt: value })}
        onRiskToleranceChange={setRiskTolerance}
      />

      {/* Rail + one clause. Below `lg` this collapses to a single column —
         the rail stacks above the clause, in normal document order, with
         nothing hidden. At `lg`+ they sit side by side, each scrolling
         independently within the fixed viewport height; below it there are
         two stacked rows, so `h-full`/forced internal scrolling on either
         child would divide that same height between them and squeeze both
         into cramped scroll boxes. The height/overflow constraints are
         therefore `lg:`-only, and the OUTER grid scrolls the stacked page. */}
      <div className="flex-1 overflow-y-auto lg:overflow-hidden grid grid-cols-1 lg:grid-cols-[288px_1fr] gap-6 pb-2">
        <ClauseListRail
          clauses={working.clauses}
          activeId={activeClause?.id}
          onSelect={setActiveClauseId}
          onReorder={reorderClause}
          footer={
            <>
              <Button onClick={addClause} className="w-full px-3 py-1.5"><Plus className="h-3 w-3" /> Add clause</Button>

              {/* "Suggest what I'm missing" (spec §6, Task 8). Titles only.
                 Each can be added or dismissed on its own, and "Add all"
                 takes every one at once — an explicit act either way; what
                 must never happen is a proposal entering the playbook
                 because something else was saved. */}
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={requestMissingClauses}
                  disabled={missingBusy}
                  className="font-ui text-meta flex items-center gap-1.5 text-draft hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed font-medium"
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  {missingBusy ? 'Checking for gaps…' : "Suggest what I'm missing"}
                </button>
                {missingError && <p className="font-ui text-meta text-risk-high">{missingError}</p>}
                {missingSuggestions.length > 0 && (
                  <>
                    {/* Only for more than one: a "use all" over a single
                       proposal is noise beside its own Add clause. */}
                    {missingSuggestions.length > 1 && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-ui text-meta text-ink-4">
                          {missingSuggestions.length} suggested
                        </span>
                        <button
                          type="button"
                          onClick={() => addMissingClauses(missingSuggestions)}
                          className="font-ui text-meta font-semibold text-accent hover:text-accent-strong flex items-center gap-1"
                        >
                          <Plus className="h-3 w-3" aria-hidden="true" /> Add all {missingSuggestions.length}
                        </button>
                      </div>
                    )}
                    <ul className="space-y-2">
                      {missingSuggestions.map((title) => (
                        <li
                          key={title}
                          className="bg-draft-tint border border-dashed border-draft rounded-card p-2 space-y-1"
                        >
                          <span className="block font-ui text-meta text-ink-2">{title}</span>
                          <span className="flex gap-3">
                            <button
                              type="button"
                              onClick={() => dismissMissingClause(title)}
                              className="font-ui text-meta font-semibold text-ink-3 hover:text-ink-1"
                            >
                              Dismiss
                            </button>
                            <button
                              type="button"
                              onClick={() => addMissingClause(title)}
                              className="font-ui text-meta font-semibold text-accent hover:text-accent-strong flex items-center gap-1"
                            >
                              <Plus className="h-3 w-3" aria-hidden="true" /> Add clause
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            </>
          }
        />

        {/* The one clause being read. */}
        <section className="lg:h-full lg:overflow-y-auto custom-scrollbar space-y-4" aria-label="Clause">
          {/* Instead of the chips, never beside them. A failed scan that
             fell back to an empty map would render every position as having
             no evidence, which reads as a finding about the playbook rather
             than a failure of the app. */}
          {healthError && (
            <LoadErrorPanel message={healthError} onRetry={onRetryHealth} compact />
          )}

          {!activeClause ? (
            <div className="text-center font-ui text-ui text-ink-4 py-10 border border-dashed border-rule rounded-card">
              No clauses defined. Add one to get started.
            </div>
          ) : (
            <div className="bg-card border border-rule rounded-panel p-5 space-y-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-chip uppercase text-ink-4 mb-1">
                    Clause {activeIndex + 1} of {working.clauses.length}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={activeClause.title}
                      onChange={(e) => updateClause(activeIndex, { title: e.target.value })}
                      className="bg-transparent font-prose text-clause font-medium text-ink-1 outline-none min-w-0 flex-1 focus:text-accent transition-colors border-b border-transparent focus:border-accent"
                      placeholder="Clause Title"
                      aria-label="Clause title"
                    />
                    {/* Reuses `PositionChip`'s shape (label in a 1px
                       role-coloured border, transparent fill) so this row and
                       a finding card agree on what that shape means — a house
                       rule exists, or it doesn't. NOT a health chip: a clause
                       with no standard position gets no health verdict at all. */}
                    <span
                      className={`font-mono text-chip uppercase px-1.5 py-0.5 rounded-chip border bg-transparent shrink-0 ${
                        activeClause.standardPosition
                          ? 'text-accent border-accent-edge'
                          : 'text-ink-4 border-rule'
                      }`}
                    >
                      {activeClause.standardPosition ? 'Has standard position' : 'No standard position'}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => deleteClause(activeIndex)}
                  aria-label={`Delete ${activeClause.title}`}
                  className="text-ink-4 hover:text-risk-high transition-colors p-1 shrink-0"
                ><X className="h-4 w-4" aria-hidden="true" /></button>
              </div>

              {/* Part B. One explicit act for every suggestion on this clause
                 — the same `updateClause` funnel, taken deliberately, in one
                 write. It appears only above more than one suggestion, never
                 over a single box that already offers "Use this". */}
              {showingFields.length > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-3 bg-draft-tint border border-dashed border-draft rounded-card px-3 py-2">
                  <p className="font-ui text-meta text-ink-2">
                    {showingFields.length} suggestions are waiting on this clause. None of them is in
                    it until you take it.
                  </p>
                  <button
                    type="button"
                    onClick={() => acceptFieldSuggestions(activeIndex, showingFields)}
                    className="font-ui text-ui-sm font-semibold text-accent hover:text-accent-strong shrink-0"
                  >
                    Use all {showingFields.length}
                  </button>
                </div>
              )}

              {/* EXTRACT, full width and first: it is the only field a clause
                 cannot do without. */}
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <label
                    htmlFor="clause-extract"
                    className="font-mono text-chip uppercase text-ink-4 flex items-center gap-1"
                  ><ScanText className="h-3 w-3" aria-hidden="true" /> Extract</label>
                  {fieldSuggestButton(activeIndex, activeClause, 'extractPrompt')}
                </div>
                <AutoResizeTextarea
                  id="clause-extract"
                  aria-label="Extract"
                  value={activeClause.extractPrompt}
                  onChange={(e) => updateClause(activeIndex, { extractPrompt: e.target.value })}
                  className="w-full p-2.5 min-h-[64px]"
                  placeholder="What to pull out of the document..."
                />
                {fieldSuggestBox(activeIndex, activeClause, 'extractPrompt')}
              </div>

              {/* The pairing the owner asked for: what makes this clause
                 risky, beside what we ask for — one is read against the
                 other. Stacked below `lg`, where two columns would only be
                 two narrow ones. */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6" data-field-pair>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label
                      htmlFor="clause-risky-when"
                      className="font-mono text-chip uppercase text-risk-high flex items-center gap-1"
                    ><ShieldAlert className="h-3 w-3" aria-hidden="true" /> Risky when</label>
                    {fieldSuggestButton(activeIndex, activeClause, 'riskCriteria')}
                  </div>
                  <AutoResizeTextarea
                    id="clause-risky-when"
                    aria-label="Risky when"
                    value={activeClause.riskCriteria || ''}
                    onChange={(e) => updateClause(activeIndex, { riskCriteria: e.target.value })}
                    className="w-full bg-risk-high-tint p-2.5 min-h-[64px]"
                    placeholder="e.g. Must be mutual. Leave blank to use the global risk tolerance."
                  />
                  {fieldSuggestBox(activeIndex, activeClause, 'riskCriteria')}
                </div>

                <div>
                  <div className="flex items-center justify-end mb-1">
                    {fieldSuggestButton(activeIndex, activeClause, 'standardPosition')}
                  </div>
                  <StandardPositionField
                    position={activeClause.standardPosition}
                    onChange={(position) => setPosition(activeIndex, position)}
                  />
                  {fieldSuggestBox(activeIndex, activeClause, 'standardPosition')}
                  {/* Nothing at all when the caller supplied no map, and
                     nothing when the scan failed — the panel above says why.
                     A defaulted `UNTESTED` here would be the app inventing an
                     answer to a question it could not ask. */}
                  {activeHealth && !healthError && (
                    <p className={`mt-2 font-mono text-chip uppercase ${HEALTH_INK[activeHealth.kind]}`}>
                      {positionHealthLabel(activeHealth)}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
