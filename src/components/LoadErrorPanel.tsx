import React from 'react';

export interface LoadErrorPanelProps {
  message: string;
  /** Omitted only when the caller genuinely has nothing to retry. The
   *  message is rendered either way: every caller that had `error && onRetry`
   *  as its render condition fell back to its EMPTY state when a retry was
   *  missing, which is the "nothing published yet" over four real versions
   *  that CLAUDE.md's empty-versus-broken rule exists to prevent. Deciding
   *  that here, once, is what stops each call site from re-deriving it. */
  onRetry?: () => void;
  /** `false` (default) renders the full centred block used when this panel
   *  replaces an entire screen (the matters list, the library, a matter, a
   *  review, a playbook). `true` renders a smaller inline block sized to sit
   *  inside a section of an otherwise-populated screen (a matter home's
   *  documents/reviews sections, a modal). Same contract either way — a
   *  message plus a working Retry — so the three panels this project's
   *  review history flagged as having drifted apart (a full-screen panel, a
   *  dashed-border section block, and a bare paragraph with no retry at all)
   *  converge on one component instead of three hand-rolled idioms. The
   *  message is the invariant part; the Retry appears whenever there is
   *  something to retry, which is every call site in the app today. */
  compact?: boolean;
}

/** A dedicated load-error panel, rendered INSTEAD OF the content it
 *  replaces — never alongside it, never falling back to an empty list or
 *  section. The one shared component for every load failure in the app
 *  (the matters list, the playbook library, a single matter, its documents
 *  and reviews sections, a review, a playbook, and the "run a review"
 *  playbook picker) so the pattern can't drift between call sites the way it
 *  had before this consolidation. */
export function LoadErrorPanel({ message, onRetry, compact = false }: LoadErrorPanelProps) {
  if (compact) {
    return (
      <div className="p-6 text-center space-y-3 border border-dashed border-red-500/30 rounded-xl bg-red-950/10">
        <p className="text-red-400 text-sm">{message}</p>
        {onRetry && (
          <button
            onClick={onRetry}
            className="px-3 py-1.5 rounded-md bg-violet-600 text-white text-sm hover:bg-violet-500"
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="p-8 max-w-md mx-auto text-center space-y-4">
      <p className="text-red-400">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded-md bg-violet-600 text-white hover:bg-violet-500"
        >
          Retry
        </button>
      )}
    </div>
  );
}
