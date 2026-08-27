import type { Finding, Review } from '../types';

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

/**
 * How an export names what a human concluded about a finding — the only
 * place that wording exists, so the DOCX report and the CSV can never
 * disagree about it. They disagreed once before, over exactly this kind of
 * thing (a CSV wrote unreviewed clauses as blank cells while the DOCX said
 * "could not be reviewed"), and the CSV is the one that opens straight into
 * Excel.
 *
 * `null` means "no label" and is returned for exactly one case: a verified
 * finding. Everything else — including a finding that is simply missing —
 * is labelled, because an unlabelled export row reads as checked, and the
 * spec's rule is that nothing leaves the app claiming to be checked when it
 * isn't.
 *
 * Export is never blocked by any of these. A rejected finding is exported
 * WITH its reason: silently dropping it would hide a human judgement from
 * whoever reads the report.
 */
export function verificationLabel(finding: Finding | undefined): string | null {
  const state = finding?.verification?.state ?? 'unchecked';

  if (state === 'verified') return null;
  if (state === 'flagged') return 'FLAGGED';
  if (state === 'rejected') {
    const reason = finding?.verification?.reason?.trim();
    // A rejection whose reason went missing (a record written before the
    // requirement existed, or repaired by the migration) still says it was
    // rejected. Silence here would be the worst of both: a rejected finding
    // exported as though nobody had objected.
    return `REJECTED: ${reason && reason !== '' ? reason : 'no reason recorded'}`;
  }
  return 'UNVERIFIED AI OUTPUT';
}

export interface VerificationCounts {
  total: number;
  verified: number;
  unchecked: number;
  flagged: number;
  rejected: number;
}

/** Counts findings by verification state across every document in a review.
 *  Shared by both exporters' header summary so a DOCX report and a CSV
 *  export of the same run can never quote different numbers. */
export function verificationCounts(findings: Review['findings']): VerificationCounts {
  const counts: VerificationCounts = { total: 0, verified: 0, unchecked: 0, flagged: 0, rejected: 0 };
  for (const byClause of Object.values(findings ?? {})) {
    for (const finding of Object.values(byClause ?? {})) {
      counts.total++;
      counts[finding?.verification?.state ?? 'unchecked']++;
    }
  }
  return counts;
}

/** The one-line header every export carries. Reading it should be enough to
 *  know how much of the report a human has actually stood behind.
 *
 *  Deliberately ASCII-only. This same string goes into the CSV, which is
 *  written with no byte-order mark, and Excel's default import on Windows
 *  reads a BOM-less file as ANSI — so an em-dash here would arrive as
 *  mojibake in the first thing a reader sees. The line has to survive its
 *  most fragile consumer, and typography is not worth a garbled export. */
export function exportSummaryLine(findings: Review['findings']): string {
  const c = verificationCounts(findings);
  return `${c.total} findings: ${c.verified} verified, ${c.unchecked} unverified, ${c.flagged} flagged, ${c.rejected} rejected.`;
}
