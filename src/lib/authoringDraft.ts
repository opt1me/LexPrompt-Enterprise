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

/** Marks a clause kept, optionally applying edited field values first.
 *  `edited` is computed by comparing each supplied value against the
 *  clause's current one (R-E5) — an edit typed and undone, or a field
 *  re-submitted unchanged, must not read as engagement — and is OR'd with
 *  any existing `edited` so a clause edited, reopened and kept again stays
 *  marked edited. */
export function keepClause(
  draft: AuthoringDraft,
  clauseId: string,
  edits?: Partial<PlaybookClause>,
): AuthoringDraft {
  return updateClause(draft, clauseId, (clause) => {
    let changed = false;
    const next: DraftClause = { ...clause };
    if (edits) {
      for (const key of Object.keys(edits) as (keyof PlaybookClause)[]) {
        const newValue = edits[key];
        if (!valuesEqual(clause[key], newValue)) changed = true;
        (next as unknown as Record<string, unknown>)[key] = newValue;
      }
    }
    next.disposition = 'kept';
    next.edited = clause.edited || changed;
    return next;
  });
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

/** Converts a fully-reviewed draft into D's `PlaybookDraft`, ready for
 *  `publishVersion`. Cut clauses are genuinely absent, not merely hidden.
 *  Authoring-only fields are stripped by destructuring rather than deleted
 *  or set `undefined` — an `undefined`-valued key survives `structuredClone`
 *  (how IndexedDB writes every record) and would still be there on reload.
 *  A kept clause's `standardPosition`, if any, is marked `reviewedByHuman:
 *  true` — a human just read it — without touching `origin`: an AI-drafted
 *  position a person edited is still `ai-drafted`, because rewriting the
 *  provenance would erase where it came from. */
export function toPlaybookDraft(draft: AuthoringDraft, name: string): PlaybookDraft {
  const clauses: PlaybookClause[] = draft.clauses
    .filter((c) => c.disposition === 'kept')
    .map((c) => {
      const { disposition: _disposition, edited: _edited, suggestions: _suggestions, ...rest } = c;
      const clause: PlaybookClause = { ...rest };
      if (clause.standardPosition) {
        clause.standardPosition = { ...clause.standardPosition, reviewedByHuman: true };
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
