import type { ReviewHistoryEvent } from '@lexprompt/core';
import {
  dispositionHistoryLine, dispositionsAsAtLine, dispositionsMayChangeLine,
  safeFileName, type DispositionAudience,
} from '../../lib/findingOutcome';
import { escapeCsvField } from '../tabular/csv';

/**
 * THE REVIEW'S WHOLE HISTORY, AS A FILE (§6.3.1's fourth requirement).
 *
 * *"Reconstruct what this report would have said on the day it was signed"*
 * is a question a firm will eventually ask of a matter that has been
 * archived, and the answer has to be something they can keep. The card's
 * panel answers it one clause at a time, on a screen.
 *
 * ## It carries the same stamp the other two exports carry
 *
 * A history export is ALSO a point-in-time claim, and for a reason that is
 * easy to miss: the history can grow after this file is taken. A row added
 * tomorrow does not contradict anything here — the record is insert-only —
 * but a reader holding this file has no way to know whether it is still the
 * whole of it. So the same two lines from `findingOutcome.ts`, not a third
 * wording of them.
 *
 * ## One line per event, through `dispositionHistoryLine`
 *
 * The prose column is the SAME sentence the history panel shows, from the
 * same function, so a printed history and the screen cannot describe one
 * event two ways. The structured columns beside it are what a spreadsheet
 * needs to sort and filter; the sentence is what a person reads.
 */
export interface HistoryExportContext {
  /** When these events were read from the server. Same rule as the other
   *  exports: the instant is when the DATA was read, never when the file was
   *  written, and `undefined` is said rather than filled in. */
  readAt: number | undefined;
  timeZone: string;
  audience: DispositionAudience;
  /** The review's own name, for the file and its title row. */
  reviewName: string;
}

export function buildHistoryCsv(
  events: ReviewHistoryEvent[], context: HistoryExportContext,
): string {
  const title = escapeCsvField(
    events.length === 0
      // NOT an empty file, and not a bare header. A history export with no
      // rows and nothing said would read as "nobody ever changed anything",
      // which is a claim; "no changes were recorded" is the fact.
      ? `${context.reviewName}: no disposition changes have been recorded for this review.`
      : `${context.reviewName}: ${events.length} disposition `
        + `${events.length === 1 ? 'change' : 'changes'}.`);
  const asAt = escapeCsvField(dispositionsAsAtLine(context.readAt, context.timeZone));
  const mayChange = escapeCsvField(dispositionsMayChangeLine());
  const header = [
    'Clause', 'Clause id', 'Findings key', 'From', 'To', 'Cause', 'By', 'When', 'Reason',
    'What happened',
  ].map(escapeCsvField).join(',');

  const rows = events.map(event => [
    // A clause the playbook no longer names keeps its row and says so,
    // rather than being dropped or silently blank — the route makes the same
    // decision and this is the reader half of it.
    event.clauseTitle ?? 'A clause this review s playbook no longer names',
    event.clauseId,
    event.findingsKey,
    event.fromState,
    event.toState,
    event.cause,
    // NEVER the raw id: it says nothing to a reader while looking like it
    // should. `actorPhrase`'s three cases, through the audience.
    context.audience.nameOf(event.byUserId) ?? 'someone this workspace does not name',
    context.audience.timeOf(event.at),
    event.reason ?? '',
    // The SAME sentence the panel shows, from the one function that composes
    // it. A second phrasing here is how a printed history and a screen come
    // to describe one event two ways.
    dispositionHistoryLine(event, context.audience),
  ].map(escapeCsvField).join(','));

  return [title, asAt, mayChange, header, ...rows].join('\r\n');
}

/** Builds the CSV and hands it to the browser as a download — the same four
 *  moves `downloadTabularCsv` makes, and deliberately not a fifth copy of
 *  them lifted into a shared helper: the blob type, the name and the revoke
 *  are three lines, and the two exports have different names and different
 *  fallbacks. */
export function downloadHistoryCsv(
  events: ReviewHistoryEvent[], context: HistoryExportContext,
): void {
  const csv = buildHistoryCsv(events, context);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(context.reviewName, 'review')}_History.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
