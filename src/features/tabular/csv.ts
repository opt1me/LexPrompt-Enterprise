import type { DocumentFile, Finding, ReviewRun } from '../../types';
import {
  describeFindingOutcome, exportSummaryLine, verificationLabel, noteLines,
  netPositionLabel, netPositionAmendmentLabel, trailLines,
} from '../../lib/findingOutcome';
import { findingsKeyFor } from '../../lib/reviewTarget';

// Characters that Excel/Google Sheets treat as the start of a formula when a
// cell is opened, regardless of the field being quoted — quoting only
// protects column alignment, not formula evaluation.
const FORMULA_LEAD_CHARS = ['=', '+', '-', '@'];

/**
 * RFC 4180 field escaping: every field is wrapped in double quotes and any
 * internal double quote is doubled. Wrapping unconditionally (not only when
 * the field "needs" it) is deliberate — legal summaries routinely contain
 * commas, quotes and newlines, and a conditional quote is exactly the kind
 * of thing that silently regresses when someone "simplifies" it later.
 *
 * Every field here is untrusted, model-generated text, and this export's
 * whole purpose is to be opened in a spreadsheet — exactly the CSV formula
 * injection threat model. A field starting with `=`, `+`, `-` or `@` is
 * prefixed with a leading apostrophe (the standard mitigation) before
 * quoting, which spreadsheet software renders as literal text instead of
 * evaluating as a formula. This is not a hypothetical: a model summarising a
 * clause as e.g. `-1,000 per annum` trips it with no adversarial intent at
 * all.
 */
export function escapeCsvField(value: string): string {
  const safeValue = FORMULA_LEAD_CHARS.includes(value.charAt(0)) ? `'${value}` : value;
  return `"${safeValue.replace(/"/g, '""')}"`;
}

/** One cell's text: the outcome, prefixed with a verification label when
 *  there is one. The prefix goes at the START of the cell because a
 *  spreadsheet truncates cell display at the column width — a caveat at the
 *  end of a long summary is a caveat nobody reads.
 *
 *  Note the prefix is applied BEFORE `escapeCsvField`, so a summary
 *  beginning with `=`, `+`, `-` or `@` is still caught by the formula
 *  guard — the guard inspects the first character of whatever it is
 *  handed, and a verified cell (no prefix) is exactly the unprefixed case
 *  it was written for. */
function cellText(finding: Finding | undefined): string {
  const outcome = describeFindingOutcome(finding);
  // Task 9: a net position caveat is a SECOND, independent label from the
  // verification one — a collection finding can be unverified AND carry a
  // net position nobody has confirmed, either without the other. Both are
  // bracketed the same way, and in the same order every time, so a
  // spreadsheet reader always meets them before the (possibly truncated)
  // outcome text.
  const labels = [verificationLabel(finding), netPositionLabel(finding), netPositionAmendmentLabel(finding)]
    .filter((label): label is string => label !== null);
  const base = labels.length > 0 ? `[${labels.join('] [')}] ${outcome}` : outcome;
  // Important 3 (spec §6: "a flagged finding carries its flag and any
  // note"): notes go at the END here, unlike the label — the label is a
  // caveat that must be seen before a truncated summary, a note is
  // supplementary detail a reader who opens the full cell should still find.
  // The derivation trail (Task 9) is exported the same way, for the same
  // reason: a net position without it is an assertion, not a derivation.
  // `noteLines`/`verificationLabel`/`trailLines` are all shared with
  // exportDocx.ts via `findingOutcome.ts` so the two exporters cannot
  // disagree about any of them.
  const extras = [...noteLines(finding), ...trailLines(finding)];
  return extras.length > 0 ? `${base} | ${extras.join(' | ')}` : base;
}

/**
 * Row 0 is a single-field verification summary (Ruling R-B4); row 1 is the
 * header of clause titles; one row per document follows, one column per
 * clause (in template order). A clause that is pending, running, cancelled
 * or errored — not just missing — renders as an honest "This clause could
 * not be reviewed: …" cell via `describeFindingOutcome`, never an empty
 * field: in a spreadsheet an empty cell reads as "checked, nothing found,"
 * which is exactly the confident-wrong-answer failure this app exists to
 * avoid (Critical 3 — `exportDocx.ts` already got this right for the DOCX
 * report; this keeps the CSV from disagreeing with it). Every cell also
 * carries a verification label (`cellText`) so a spreadsheet reader can't
 * mistake an unverified AI answer for one a human has stood behind. Rows
 * are joined with CRLF per RFC 4180, which is what most spreadsheet
 * software expects for CSV.
 */
export function buildTabularCsv(run: ReviewRun, documents: DocumentFile[]): string {
  const clauses = run.templateSnapshot.clauses;

  // Ruling R-B4: a single-field first row. Excel opens it as a title line
  // above the table, and every export — DOCX and CSV alike — has to say how
  // much of it a human actually stood behind.
  const summary = escapeCsvField(exportSummaryLine(run.findings));
  const header = ['Document', ...clauses.map(c => c.title)].map(escapeCsvField).join(',');

  const rows = run.documentIds.map(docId => {
    const doc = documents.find(d => d.id === docId);
    // Same bug `buildReportRows` had (Step 0 of Task 9): a collection
    // review's findings live under the COLLECTION id, not each document's
    // own id, so every document row must resolve through `findingsKeyFor`
    // rather than indexing `run.findings` by `docId` directly.
    const key = findingsKeyFor(run.target, docId);
    const fields = [
      doc?.name ?? docId,
      ...clauses.map(c => cellText(run.findings[key]?.[c.id])),
    ];
    return fields.map(escapeCsvField).join(',');
  });

  return [summary, header, ...rows].join('\r\n');
}
