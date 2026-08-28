import React from 'react';
import { Sparkles } from 'lucide-react';

export interface FieldSuggestionProps {
  /** The suggested text, not yet written into the field. */
  text: string;
  /** Adopts the suggestion into the field. The ONLY thing that ever writes
   *  it there — saving the form must never do this on its own behalf. */
  onAccept: () => void;
  onRegenerate: () => void;
  /** Discards the suggestion without touching the field. */
  onDismiss: () => void;
  /** A regenerate call is in flight; disables the controls without hiding
   *  the currently-displayed suggestion. */
  busy?: boolean;
}

/**
 * One AI suggestion for one field, rendered visibly unaccepted (spec: this
 * sub-project's entire purpose is that nothing the model produced becomes
 * the firm's until a person says so). The dashed border matches the
 * existing "AI suggestion, not yet taken" styling used for a drafted
 * clause's sub-questions in `DraftReview`'s `ClauseEditor` — the same idea,
 * one level down, and drift between the two would be exactly the kind of
 * sibling-drift CLAUDE.md warns about, so this reuses the pattern rather
 * than inventing a second one.
 */
export function FieldSuggestion({ text, onAccept, onRegenerate, onDismiss, busy = false }: FieldSuggestionProps) {
  return (
    <div className="bg-draft-tint border border-dashed border-draft rounded-card p-3 space-y-2">
      {/* The words stay exactly "AI suggestion — not accepted": two tests
         outside this task's declared file (`FieldSuggestion.test.tsx` and
         `TemplateEditor.suggestions.test.tsx`) match on "suggestion" and on
         "not accepted" respectively, and a restyle may not edit them. */}
      <p className="flex items-center gap-1 font-mono text-chip uppercase text-draft">
        <Sparkles className="h-3 w-3" aria-hidden="true" /> AI suggestion &mdash; not accepted
      </p>
      <p className="font-prose text-field text-ink-prose whitespace-pre-wrap">{text}</p>
      <div className="flex justify-end gap-3 pt-1">
        <button
          onClick={onDismiss}
          disabled={busy}
          className="font-ui text-ui-sm font-semibold text-ink-3 hover:text-ink-1 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          I&rsquo;ll write it myself
        </button>
        <button
          onClick={onRegenerate}
          disabled={busy}
          className="font-ui text-ui-sm font-semibold text-draft hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Try again
        </button>
        <button
          onClick={onAccept}
          disabled={busy}
          className="font-ui text-ui-sm font-semibold text-accent hover:text-accent-strong disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Use this
        </button>
      </div>
    </div>
  );
}
