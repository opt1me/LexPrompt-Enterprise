import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { DispositionWithHistory, VerificationChange } from '@lexprompt/core';
import { Button } from '../../components/Button';
import {
  conflictReapplyLabel, dispositionConflictLine, type DispositionAudience,
} from '../../lib/findingOutcome';

/**
 * A refused change and the row that refused it, as the cell it belongs to.
 *
 * Declared here, beside the only component that renders one, and carried
 * verbatim through `ResultsView`/`TabularReview`/`CellDetail` — keyed by
 * `findingsKey` and never by a document id, for `findingsKeyFor`'s reason:
 * a collection review produces one disposition per clause however many
 * documents fed it, and keying by document would put the notice on a card
 * chosen arbitrarily.
 */
export interface VerificationConflict {
  findingsKey: string;
  clauseId: string;
  current: DispositionWithHistory;
  attempted: VerificationChange;
}

export interface ConflictNoticeProps {
  /** The row as it stands NOW — what the server sent back in the act of
   *  refusing, never anything this browser composed. */
  current: DispositionWithHistory;
  /** What this person tried to do, kept so the control can offer exactly
   *  that again rather than something adjacent to it. */
  attempted: VerificationChange;
  audience: DispositionAudience;
  /** Offers the change again, against the version that won. A PERSON calls
   *  this. Nothing here calls it for them. */
  onReapply: () => void;
  onDismiss: () => void;
  /** True while the re-apply is in flight. */
  busy?: boolean;
}

/**
 * The sentence a person sees when someone else moved a judgement out from
 * under them, and the one control that resolves it.
 *
 * §6.3 writes the sentence out and `dispositionConflictLine` is the only
 * place it exists; this component is what puts it beside the card it is
 * about. What this file must keep true:
 *
 *  - **IT OFFERS THE CHANGE AGAIN, and never takes it.** P25: a
 *    human-authored write NEVER auto-retries. There is no `useEffect` here,
 *    and `ConflictNotice.test.tsx` asserts that absence rather than assuming
 *    it — because the pressure to add one automatic re-apply is permanent
 *    (the click is annoying, the fix is one line) and it would re-create
 *    last-write-wins with a history row saying a person decided it.
 *  - **It does NOT offer "keep mine" or "merge".** There is nothing to
 *    merge: a disposition is one of four words, and "keep mine" IS the
 *    re-apply.
 *  - **Dismiss is a real exit.** A reviewer who reads "R. Okafor rejected
 *    this" and agrees has finished; making the only way out a second write
 *    would be an app insisting they disagree.
 *
 * The card behind it does not move. `handleVerify` applies nothing on the
 * failure path (await-then-apply holds on refusals too) — what changes is
 * the browser's record of what the SERVER says is there, which this notice
 * is the visible half of.
 */
export function ConflictNotice({
  current, attempted, audience, onReapply, onDismiss, busy = false,
}: ConflictNoticeProps) {
  return (
    <div
      data-conflict-notice
      role="alert"
      className="flex items-start gap-2 p-3 bg-risk-med-tint border border-risk-med-edge rounded-inset"
    >
      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-risk-med" aria-hidden="true" />
      <div className="space-y-2 min-w-0">
        <p className="font-ui text-ui-sm text-ink-2 leading-relaxed">
          {dispositionConflictLine(current, audience)}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button variant="ghost" data-action="reapply" onClick={onReapply} loading={busy}>
            {conflictReapplyLabel(attempted)}
          </Button>
          <Button variant="ghost" data-action="dismiss-conflict" onClick={onDismiss} disabled={busy}>
            Leave theirs
          </Button>
        </div>
      </div>
    </div>
  );
}
