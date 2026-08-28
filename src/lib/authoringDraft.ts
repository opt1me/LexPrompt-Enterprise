import type { PlaybookClause, PlaybookDraft } from '../types';

/** Sub-project E — playbook authoring. See
 *  `docs/superpowers/specs/2026-08-27-redesign-e-playbook-authoring.md`.
 *
 *  `AuthoringDraft` is the session-only working object a playbook passes
 *  through on its way to being saved — never `PlaybookDraft` (ruling R-E1):
 *  D already owns that name for the *persisted* working copy on
 *  `Playbook.draft`, and the two have opposite persistence rules. This one
 *  must never reach IndexedDB; it lives in React state and is lost on
 *  reload, on purpose. */

export type ClauseDisposition = 'unreviewed' | 'kept' | 'cut';

export interface DraftClause extends PlaybookClause {
  disposition: ClauseDisposition;
  /** True when the human changed a field before keeping it. R-E5: computed
   *  by comparing values, never set by an onChange firing — "kept as
   *  drafted" and "rewritten then kept" are different claims about how much
   *  a person actually engaged, and this one feeds provenance. */
  edited: boolean;
  /** True when the human changed the STANDARD POSITION before keeping it.
   *
   *  Narrower than `edited`, deliberately. Provenance is a claim about the
   *  position, and rewriting a risk criterion is not evidence that anyone
   *  rewrote the house rule — a provenance line saying "rewritten and
   *  accepted" over a position the person never touched is precisely the
   *  confidently-wrong claim this app exists not to make. Computed by the
   *  same value comparison as `edited` (R-E5) and OR'd with itself the same
   *  way, so a position rewritten, reopened and kept again stays marked. */
  positionEdited: boolean;
  /** Extra sub-questions the model offered, neither added nor dismissed. */
  suggestions: string[];
}

export interface AuthoringDraft {
  contractType: string;
  actingFor?: string;
  context?: string;
  /** Names of the playbooks and matters used as style sources. */
  learnedFrom: string[];
  modelId: string;
  clauses: DraftClause[];
}

/** Neither the AI-draft form nor the by-hand route collects a system/format
 *  prompt — those govern how the *review engine* behaves, not what a clause
 *  asks, so a freshly authored draft gets the same generic starting point
 *  `newPlaybookDraft` (`src/lib/db/playbooks.ts`) gives a brand-new empty
 *  playbook. Duplicated rather than imported: importing from `db/playbooks`
 *  here would pull IndexedDB's connection module into a module this
 *  sub-project deliberately keeps pure (no React, no store, no
 *  persistence). If a third place needs this text, extract it then. */
const DEFAULT_SYSTEM_PROMPT = 'You are an expert legal contract reviewer.';
const DEFAULT_FORMAT_PROMPT = 'Answer strictly from the document text. Quote verbatim.';

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function updateClause(
  draft: AuthoringDraft,
  clauseId: string,
  update: (clause: DraftClause) => DraftClause,
): AuthoringDraft {
  return {
    ...draft,
    clauses: draft.clauses.map((c) => (c.id === clauseId ? update(c) : c)),
  };
}

/** Applies field values to a clause and recomputes its engagement flags.
 *
 *  The one place a `DraftClause`'s fields are written, shared by
 *  `keepClause` (which then decides the clause) and `editClause` (which
 *  does not). Two copies of this loop would be two chances for the flags to
 *  drift from what a person actually did.
 *
 *  `edited` and `positionEdited` are computed by comparing each supplied
 *  value against the clause's current one (R-E5) — an edit typed and
 *  undone, or a field re-submitted unchanged, must not read as engagement —
 *  and are OR'd with the existing flags so a clause edited, reopened and
 *  decided again stays marked. */
function applyEdits(clause: DraftClause, edits?: Partial<PlaybookClause>): DraftClause {
  const next: DraftClause = { ...clause };
  if (!edits) return next;
  let changed = false;
  let positionChanged = false;
  for (const key of Object.keys(edits) as (keyof PlaybookClause)[]) {
    const newValue = edits[key];
    if (!valuesEqual(clause[key], newValue)) {
      changed = true;
      if (key === 'standardPosition') positionChanged = true;
    }
    // Deleted, not assigned `undefined`: `structuredClone` (how
    // IndexedDB writes every record, once this draft is published)
    // PRESERVES an `undefined`-valued key, so an explicit `undefined`
    // here — e.g. `DraftReview` clearing a blanked `standardPosition`,
    // Minor 1 — must remove the key entirely, the same rule
    // `TemplateEditor`'s own `setPosition` documents and applies.
    if (newValue === undefined) {
      delete (next as unknown as Record<string, unknown>)[key];
    } else {
      (next as unknown as Record<string, unknown>)[key] = newValue;
    }
  }
  next.edited = clause.edited || changed;
  next.positionEdited = clause.positionEdited || positionChanged;
  return next;
}

/** True when applying `edits` would change any of the clause's values. */
function editsChangeAnything(clause: DraftClause, edits: Partial<PlaybookClause>): boolean {
  return (Object.keys(edits) as (keyof PlaybookClause)[])
    .some((key) => !valuesEqual(clause[key], edits[key]));
}

/** Marks a clause kept, optionally applying edited field values first. */
export function keepClause(
  draft: AuthoringDraft,
  clauseId: string,
  edits?: Partial<PlaybookClause>,
): AuthoringDraft {
  return updateClause(draft, clauseId, (clause) => ({
    ...applyEdits(clause, edits),
    disposition: 'kept',
  }));
}

/**
 * Folds field values into a clause WITHOUT deciding it — the same write
 * `keepClause` performs, minus the disposition.
 *
 * Integrity review (D/E), Major 6. `ClauseEditor`'s fields are local state
 * remounted on every clause switch, so before this existed only `Keep`
 * drained them: moving to another clause silently discarded whatever had
 * been typed, and a clause already marked `Kept` went on saying so over the
 * superseded wording. The buffer's lifetime, not a warning, is the fix —
 * `DraftReview` commits through here on every route out of a clause.
 *
 * Returns the SAME draft object when nothing would change, so a caller can
 * tell "there was nothing to commit" by identity and avoid an `onChange`
 * that would record engagement nobody performed (R-E5).
 */
export function editClause(
  draft: AuthoringDraft,
  clauseId: string,
  edits: Partial<PlaybookClause>,
): AuthoringDraft {
  const clause = draft.clauses.find((c) => c.id === clauseId);
  if (!clause || !editsChangeAnything(clause, edits)) return draft;
  return updateClause(draft, clauseId, (c) => applyEdits(c, edits));
}

/** Marks a clause cut. Cutting is not engagement with the clause's content —
 *  it never sets `edited`. */
export function cutClause(draft: AuthoringDraft, clauseId: string): AuthoringDraft {
  return updateClause(draft, clauseId, (clause) => ({ ...clause, disposition: 'cut' }));
}

export function unreviewedCount(draft: AuthoringDraft): number {
  return draft.clauses.filter((c) => c.disposition === 'unreviewed').length;
}

/** The save gate. `unreviewedCount === 0` alone is vacuously true for a
 *  draft with no clauses, or one where every clause was cut — neither is a
 *  playbook anyone reviewed, so `some(kept)` is required too. This is the
 *  whole feature (spec Risk §10); do not weaken either half. */
export function canSaveDraft(draft: AuthoringDraft): boolean {
  return unreviewedCount(draft) === 0 && draft.clauses.some((c) => c.disposition === 'kept');
}

/** What the save button says. Never inertly grey — it names how many
 *  clauses stand between the draft and a save. */
export function saveGateLabel(draft: AuthoringDraft): string {
  const remaining = unreviewedCount(draft);
  if (remaining === 0) return 'Save as v1';
  return `${remaining} clause${remaining === 1 ? '' : 's'} left to review`;
}

/**
 * The provenance sentence stamped onto a standard position when the draft is
 * published — `StandardPosition.provenance`, the field E's spec §8 and DoD 5
 * require to "honestly reflect how it got there".
 *
 * It is the ONLY place this wording is composed, for the reason
 * `verificationLabel` is the only place export wording lives: provenance is
 * shown in the editor and travels into every export of the playbook, and two
 * copies of it would drift into two different claims about the same
 * position.
 *
 * Everything it can say is something the draft actually recorded: the model
 * that drafted it (`AuthoringDraft.modelId`), the sources it learned from
 * (`learnedFrom`, already filtered by `usedFewShotSources` to sources that
 * genuinely contributed), and whether a person rewrote the position before
 * keeping it (`positionEdited`, computed by comparison — R-E5). It never
 * claims a model for a position a person wrote.
 */
export function positionProvenance(draft: AuthoringDraft, clause: DraftClause): string | undefined {
  const position = clause.standardPosition;
  if (!position) return undefined;
  // "Accepted unchanged" is a real and useful claim — it says a person saw
  // this and let it stand — but it must never be confused with "a person
  // wrote this", which is what the `authored` branch below says instead.
  const engagement = clause.positionEdited
    ? 'rewritten and accepted by a person in the draft review'
    : 'accepted unchanged by a person in the draft review';
  const sources = draft.learnedFrom.join(', ');
  switch (position.origin) {
    case 'ai-drafted':
      return `Drafted by ${draft.modelId || 'an AI model'}` +
        `${sources ? `, learning from ${sources}` : ''}; ${engagement}.`;
    case 'learned':
      return `Learned from ${sources || "the firm's prior work"}; ${engagement}.`;
    case 'authored':
      // No model, no sources, no "accepted": a person wrote every word, and
      // that is the whole claim.
      return 'Written by a person.';
  }
}

/** Converts a fully-reviewed draft into D's `PlaybookDraft`, ready for
 *  `publishVersion`. Cut clauses are genuinely absent, not merely hidden.
 *  Authoring-only fields are stripped by destructuring rather than deleted
 *  or set `undefined` — an `undefined`-valued key survives `structuredClone`
 *  (how IndexedDB writes every record) and would still be there on reload.
 *  A kept clause's `standardPosition`, if any, is marked `reviewedByHuman:
 *  true` — a human just read it — without touching `origin`: an AI-drafted
 *  position a person edited is still `ai-drafted`, because rewriting the
 *  origin would erase where it came from. It also gains the `provenance`
 *  sentence `positionProvenance` composes (E spec §8, DoD 5). */
export function toPlaybookDraft(draft: AuthoringDraft, name: string): PlaybookDraft {
  const clauses: PlaybookClause[] = draft.clauses
    .filter((c) => c.disposition === 'kept')
    .map((c) => {
      const {
        disposition: _disposition, edited: _edited, positionEdited: _positionEdited,
        suggestions: _suggestions, ...rest
      } = c;
      const clause: PlaybookClause = { ...rest };
      if (clause.standardPosition) {
        // The authoring-only facts (`modelId`, `learnedFrom`, `edited`,
        // `positionEdited`) reach the persisted record HERE or nowhere:
        // `AuthoringDraft` dies with the session (R-E1), and this is the one
        // seam where what happened to a position can still be written down.
        const provenance = positionProvenance(draft, c);
        clause.standardPosition = {
          ...clause.standardPosition,
          reviewedByHuman: true,
          // Omitted, never assigned `undefined` — `structuredClone` (how
          // IndexedDB writes every record) preserves an `undefined`-valued
          // key, so an `in` check would say a provenance is there when there
          // is none. Same rule as `migratePosition`'s own spread.
          ...(provenance ? { provenance } : {}),
        };
      }
      return clause;
    });

  return {
    name,
    contractType: draft.contractType,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    formatPrompt: DEFAULT_FORMAT_PROMPT,
    clauses,
    // v1 is exempt from D's required-change-summary rule; publishVersion
    // accepts an empty string here.
    changeSummary: '',
  };
}
