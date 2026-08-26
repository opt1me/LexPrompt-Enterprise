import type { Finding } from '../types';

/**
 * The one place that decides what text represents a clause's outcome when
 * it has to be rendered as plain prose — a CSV cell, a DOCX summary row —
 * rather than a status-aware UI component with its own pending/running/
 * error styling (`FindingCard`, the tabular `Cell`).
 *
 * A clause that is still pending, still running, was cancelled, or failed
 * must never render as an empty string: in a spreadsheet or a report, an
 * empty cell reads as "checked, nothing found," which is a worse failure
 * than an honest "could not be reviewed" notice — the whole reason this
 * app exists is to tell a lawyer what is (and isn't) in a contract.
 *
 * Shared by `csv.ts` and `exportDocx.ts` so the two exporters can't
 * silently disagree about what "not reviewed" reads as; before this was
 * extracted, the DOCX export got this right and the CSV export did not
 * (Critical 3), and the CSV is the one that opens directly in Excel.
 */
export function describeFindingOutcome(finding: Finding | undefined): string {
  if (finding?.status === 'done') return finding.summary ?? '';

  const reason =
    finding?.status === 'error' ? (finding.error ?? 'unknown error') :
    finding?.status === 'cancelled' ? 'the run was cancelled before this clause was reviewed' :
    finding?.status === 'running' ? 'review was still in progress when this was exported' :
    'not yet reviewed';

  return `This clause could not be reviewed: ${reason}`;
}
