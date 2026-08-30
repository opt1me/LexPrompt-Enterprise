import React, { useEffect, useState } from 'react';
import type { DispositionEventView } from '@lexprompt/core';
import { Modal } from '../../components/Modal';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { describeLoadError } from '../../lib/loadError';
import { dispositionHistoryLine, type DispositionAudience } from '../../lib/findingOutcome';
import { getDispositionHistory } from '../../lib/api/findings';

export interface DispositionHistoryProps {
  reviewId: string;
  findingsKey: string;
  clauseId: string;
  /** How each row turns a user id into a name and an instant into a time —
   *  the same object the card beneath this panel was rendered with, so the
   *  two cannot name one person two ways. */
  audience: DispositionAudience;
  onClose: () => void;
}

/**
 * WHO CHANGED THIS FINDING'S DISPOSITION, WHEN, AND WHAT FROM — newest
 * first.
 *
 * §6.3: *"the card shows that fact inline and makes the history reachable in
 * one action"*. The card's line says what the disposition is now; this says
 * how it got there, which is the difference between a settled clause and a
 * contested one and is the only place a withdrawn judgement survives at all.
 *
 * ## It reads the route Stage 3 shipped
 *
 * `GET /v1/reviews/:id/findings/:findingsKey/:clauseId/history` is tested,
 * workspace-scoped and ordered, and had no caller by design (P28). A second
 * route would be a second definition of what an event is, over a table
 * exactly one module writes.
 *
 * ## Three load states, and none of them is an empty list
 *
 * A failed fetch renders as a FAILURE. An empty history under a disposition
 * somebody moved is indistinguishable from a change that failed to record
 * itself — the ambiguity §6.4's one-transaction rule exists to make
 * impossible — and a network error rendering as "no changes" would
 * manufacture it. A genuinely empty history is a SENTENCE, not a blank
 * panel: an empty list styled as a list is the blank-CSV-cell defect in a
 * modal.
 */
export function DispositionHistory({
  reviewId, findingsKey, clauseId, audience, onClose,
}: DispositionHistoryProps) {
  const [events, setEvents] = useState<DispositionEventView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    // BOTH cleared before the read, so a retry after a failure does not
    // render the old error beside the new answer — and so a second cell's
    // history cannot appear under the first's heading for a frame.
    setEvents(null);
    setError(null);
    getDispositionHistory(reviewId, findingsKey, clauseId)
      .then(page => { if (live) setEvents(page.events); })
      .catch((e: unknown) => {
        if (!live) return;
        setError(describeLoadError(
          e,
          'This clause\'s history could not be read. It is on the server, not in this '
          + 'browser, so nothing has been lost — but what you are looking at is not the '
          + 'record.'));
      });
    return () => { live = false; };
  }, [reviewId, findingsKey, clauseId, attempt]);

  return (
    <Modal isOpen title="What changed, and who changed it" onClose={onClose} size="lg">
      {error !== null ? (
        // INSTEAD OF the content, never beside it, and never falling back to
        // an empty list — `describeLoadError`/`LoadErrorPanel` are the one
        // shared shape for this, and the retry re-reads rather than
        // re-rendering what failed.
        <div data-load-error>
          <LoadErrorPanel message={error} onRetry={() => setAttempt(n => n + 1)} compact />
        </div>
      ) : events === null ? (
        <p className="font-ui text-ui-sm text-ink-4" aria-live="polite">Reading the history…</p>
      ) : events.length === 0 ? (
        // A SENTENCE, not a blank panel. "No changes" would also be true but
        // says nothing about why: this says what the record actually holds.
        <p className="font-ui text-ui text-ink-2">
          This finding has not been changed since the review ran.
        </p>
      ) : (
        <ol className="space-y-2">
          {events.map(event => (
            <li
              key={event.id}
              data-history-line
              className="font-ui text-ui-sm text-ink-2 border-l-2 border-rule pl-3"
            >
              {/* `dispositionHistoryLine`, never a string composed here. The
                 card and this panel describe one event through one function
                 precisely so they cannot describe it two ways — the drift
                 the DOCX and the CSV already paid for once. */}
              {dispositionHistoryLine(event, audience)}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}
