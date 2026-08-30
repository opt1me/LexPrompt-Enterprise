import React from 'react';
import type { AssignmentView } from '@lexprompt/core';
import type { DispositionAudience } from '../../lib/findingOutcome';

export interface AskedOfYouProps {
  /** The OPEN requests addressed to this browser's own user, in this review.
   *  The caller filters; this component renders what it is given. */
  assignments: AssignmentView[];
  /** How a user id becomes a name (P32). */
  audience?: DispositionAudience;
  /** Takes the reader to the clause. A request nobody can act on from where
   *  it is shown is a badge. */
  onOpenClause?: (findingsKey: string, clauseId: string) => void;
  /** Clause id to its title, so the list says which clause rather than
   *  making the reader decode an id. A clause with no title known renders
   *  its id, which is the honest fallback — never a made-up name. */
  clauseTitles?: Record<string, string>;
  /**
   * THE READ FAILED, and the panel says so instead of rendering nothing.
   *
   * This is the load-path rule this codebase already has everywhere else:
   * *"never fall back to an empty list"*. Nothing rendered and "nobody has
   * asked you anything" are the same pixels, and the cost of confusing them
   * here is a colleague waiting on an answer nobody knows was requested.
   *
   * ON THE PANEL rather than in a toast, deliberately: a toast about this
   * competes with whatever else the screen is trying to say — an expired
   * sign-in, a refused jurisdiction — and it disappears on a timer, which is
   * not somewhere to put a fact a person has to act on.
   */
  error?: string;
  /** Reads it again. A load error with no way out is a dead end. */
  onRetry?: () => void;
}

/**
 * WHAT HAS BEEN ASKED OF YOU, IN THIS REVIEW (§18 item 5, Task 25).
 *
 * §18 item 5 requires that *"an assignment reaches the assignee"*, and a
 * mechanism nobody can see is not a mechanism that reaches anybody — this
 * project has nineteen recorded instances of a correct mechanism with no
 * path to it. So the request arrives over the socket AND has somewhere to
 * land.
 *
 * ## It names the person and carries the message
 *
 * *"A. Trainee asked you to look at this"*, plus what they said. A bare
 * marker makes the assignee open every clause to find out what was wanted,
 * which is the same failure a blank CSV cell is: a surface that looks
 * complete and says nothing.
 *
 * ## It is not a disposition, and it does not offer to become one
 *
 * There is no verify button here. Deciding the clause happens on the card,
 * where the answer and the evidence are — a control that let somebody
 * dispose of a clause from a list of requests would be a judgement made
 * without reading it.
 *
 * ## Nothing renders when nothing has been asked
 *
 * No "0 requests" placeholder. A permanent empty panel is one readers stop
 * seeing, and it would take the non-empty case with it.
 *
 * ## What this deliberately is NOT, and why it is not called that
 *
 * The firm-wide **assigned-to-me** counter, and the assignee **chip** on a
 * card in a list, are Stage 5 (S18): cross-matter aggregations over the
 * mechanism Task 24 built. This is the review-scoped surface Stage 4 owes
 * §18 item 5, and naming the difference is the point.
 *
 * The plan called this file by the Stage 5 name. It is called `AskedOfYou`
 * instead, and not only for tidiness: `stage2DoD.test.ts` and
 * `stage3DoD.test.ts` both forbid that phrase anywhere in `src/`, precisely
 * so the counter cannot arrive quietly — and a component wearing the
 * reserved name would have forced those guards to be relaxed to accommodate
 * a thing that is not the thing they forbid. The heading this renders is
 * "Asked of you", which is what it actually is.
 */
export function AskedOfYou({
  assignments, audience, onOpenClause, clauseTitles, error, onRetry,
}: AskedOfYouProps) {
  if (error) {
    return (
      <section
        data-asked-of-you-error
        aria-label="Asked of you"
        className="border-b border-rule bg-card px-3 py-2 space-y-1"
        // `alert`, NOT `status`. A positional `[role="status"]` query
        // elsewhere in this codebase has already broken once on a second
        // element quietly claiming the same role (`ClauseIndex` says so at
        // length), and the review screen's state chip is exactly such a
        // query -- this panel renders ABOVE the cards, so it would have
        // answered it. `alert` is also the right role: this is a failure a
        // reader has to act on, not a passing status.
        role="alert"
      >
        <p className="font-ui text-ui-sm text-risk-high">{error}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="font-ui text-ui-sm text-accent underline underline-offset-2 hover:text-accent-strong transition-colors"
          >
            Try again
          </button>
        )}
      </section>
    );
  }
  if (assignments.length === 0) return null;

  return (
    <section
      data-asked-of-you
      aria-label="Asked of you"
      className="border-b border-rule bg-draft-tint px-3 py-2 space-y-2"
    >
      <h3 className="font-mono text-chip uppercase text-ink-4">
        {assignments.length === 1 ? 'Asked of you' : `Asked of you (${assignments.length})`}
      </h3>
      <ul className="space-y-2">
        {assignments.map(a => {
          // NEVER an invented name and never a raw id — the rule
          // `dispositionLabel` follows for an actor (P32, R-GP5).
          const asker = audience?.nameOf(a.assignedByUserId)
            ?? 'Someone this workspace does not name';
          return (
            <li key={a.id} className="space-y-1">
              <p className="font-ui text-ui-sm text-ink-2">
                {`${asker} asked you to look at this`}
              </p>
              {a.message && (
                <p className="font-prose text-field text-ink-prose">{a.message}</p>
              )}
              {onOpenClause ? (
                <button
                  type="button"
                  onClick={() => onOpenClause(a.findingsKey, a.clauseId)}
                  className="font-ui text-ui-sm text-accent underline underline-offset-2 hover:text-accent-strong transition-colors"
                >
                  {clauseTitles?.[a.clauseId] ?? a.clauseId}
                </button>
              ) : (
                <span className="font-ui text-ui-sm text-ink-3">
                  {clauseTitles?.[a.clauseId] ?? a.clauseId}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
