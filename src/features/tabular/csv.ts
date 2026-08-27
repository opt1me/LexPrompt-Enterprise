import type { DocumentFile, Finding, ReviewRun } from '../../types';
import {
  describeFindingOutcome, exportSummaryLine, verificationLabel, noteLines,
  netPositionLabel, netPositionAmendmentLabel, trailLines,
  collectionExportLabel, safeFileName, truncationLabel,
  positionOutcomeLabel, positionRationaleLines,
} from '../../lib/findingOutcome';
import { findingsKeyFor, isCollectionTarget } from '../../lib/reviewTarget';

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
function cellText(
  finding: Finding | undefined,
  documentNames: Record<string, string>,
): string {
  const outcome = describeFindingOutcome(finding);
  // Task 9: a net position caveat is a SECOND, independent label from the
  // verification one — a collection finding can be unverified AND carry a
  // net position nobody has confirmed, either without the other. Both are
  // bracketed the same way, and in the same order every time, so a
  // spreadsheet reader always meets them before the (possibly truncated)
  // outcome text.
  // mn6: truncation is a fourth, independent caveat — it says the model
  // did not see all of the text, which no verification or confirmation
  // state can express.
  // Task 11: the standard-position outcome is a fifth, independent label —
  // `meets` and an absent position both stay unlabelled (`positionOutcomeLabel`
  // returns null for either), so this never manufactures a caveat where
  // there is none. Last in the bracket list so the human-judgement labels a
  // reader is used to meeting first keep their place.
  const labels = [
    verificationLabel(finding), netPositionLabel(finding), netPositionAmendmentLabel(finding),
    truncationLabel(finding), positionOutcomeLabel(finding),
  ]
    .filter((label): label is string => label !== null);
  const base = labels.length > 0 ? `[${labels.join('] [')}] ${outcome}` : outcome;
  // Important 3 (spec §6: "a flagged finding carries its flag and any
  // note"): notes go at the END here, unlike the label — the label is a
  // caveat that must be seen before a truncated summary, a note is
  // supplementary detail a reader who opens the full cell should still find.
  // The derivation trail (Task 9) is exported the same way, for the same
  // reason: a net position without it is an assertion, not a derivation.
  // The standard-position rationale (Task 11) explains the label above, so
  // it goes first among the extras.
  // `noteLines`/`verificationLabel`/`trailLines`/`positionRationaleLines` are
  // all shared with exportDocx.ts via `findingOutcome.ts` so the two
  // exporters cannot disagree about any of them.
  const extras = [
    ...positionRationaleLines(finding), ...noteLines(finding), ...trailLines(finding, documentNames),
  ];
  return extras.length > 0 ? `${base} | ${extras.join(' | ')}` : base;
}

/**
 * What the Document column says on a collection's single row: the identity
 * of the collection, spelled out as its member documents read together.
 *
 * The wording itself lives in `collectionExportLabel`, beside the other
 * shared export wording — mn4: the DOCX report names the same collection and
 * named it differently, in the round that fixed M1, which was a divergence
 * between these same two exporters. This function is now only the adapter
 * from the documents this exporter holds to the name map that one reads.
 */
function collectionLabel(run: ReviewRun, documents: DocumentFile[]): string {
  return collectionExportLabel(
    run.documentIds,
    Object.fromEntries(documents.map(d => [d.id, d.name])),
  );
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
  // Trail steps name their document rather than its id — see `trailLines`.
  // The documents are already here for the row labels, so this needs no
  // new parameter.
  const documentNames = Object.fromEntries(documents.map(d => [d.id, d.name]));

  // Ruling R-B4: a single-field first row. Excel opens it as a title line
  // above the table, and every export — DOCX and CSV alike — has to say how
  // much of it a human actually stood behind.
  const summary = escapeCsvField(exportSummaryLine(run.findings));
  const header = ['Document', ...clauses.map(c => c.title)].map(escapeCsvField).join(',');

  const clauseCells = (key: string) =>
    clauses.map(c => cellText(run.findings[key]?.[c.id], documentNames));

  const rows = isCollectionTarget(run.target)
    // ONE row for a collection, whatever its member count. A collection
    // review produces one synthesised position per clause however many
    // documents fed it (`findingsKeyFor`), and this used to emit that one
    // position once per member document, under that member's own name in
    // the Document column. `TabularReview` refuses to draw exactly that and
    // gives its reasons in its own doc comment — repeating one synthesised
    // answer under every member's name implies "a per-document disagreement
    // that was never assessed" — and the CSV must not do what its sibling
    // declares unacceptable. It also made the summary line ("5 findings")
    // disagree with the body (10 cells), because the summary counts the
    // collection key once and the body multiplied it by document count.
    //
    // A reader's whole reason to filter or sort this sheet by document is
    // to attribute an answer to a document; a synthesis attributes to none
    // of them individually, so the row says so.
    // mn3: through `findingsKeyFor`, never `run.target.collectionId` in the
    // hand. It returns exactly that for a collection and needs no document
    // id to do it, so reaching past it bought nothing and coupled this
    // branch to the shape of the target union. CLAUDE.md names this precise
    // bypass as the origin of six separate defects in this sub-project —
    // "if you are reading `run.findings[...]`, go through `findingsKeyFor`"
    // — and the sibling branch two lines below already does.
    ? [[collectionLabel(run, documents), ...clauseCells(findingsKeyFor(run.target))]]
    : run.documentIds.map(docId => {
      const doc = documents.find(d => d.id === docId);
      // Same bug `buildReportRows` had (Step 0 of Task 9): resolve the key
      // through `findingsKeyFor` rather than indexing `run.findings` by
      // `docId` directly.
      return [doc?.name ?? docId, ...clauseCells(findingsKeyFor(run.target, docId))];
    });

  const body = rows.map(fields => fields.map(escapeCsvField).join(','));

  return [summary, header, ...body].join('\r\n');
}

/**
 * Builds the CSV and hands it to the browser as a download.
 *
 * Extracted the moment there was a second caller, per this project's rule
 * about doing it then rather than after the third. Two copies of "build a
 * blob, mint an object URL, click a synthetic anchor, revoke" is a
 * `revokeObjectURL` that goes missing in one of them.
 *
 * There are two callers because there have to be. The tabular grid is the
 * natural home for a CSV, but the grid deliberately does not render at all
 * for a collection review (`CollectionNotComparable` — a collection has one
 * position per clause, so there is nothing to compare across rows), and it
 * took the only export control with it. C's spec requires a collection's
 * unconfirmed net position and its derivation to reach the CSV (§3.8, DoD
 * §10.7), so the findings view offers it too, beside the DOCX export — which
 * is also where the two exporters belong relative to each other, given they
 * have silently disagreed once before.
 */
export function downloadTabularCsv(run: ReviewRun, documents: DocumentFile[]): void {
  const csv = buildTabularCsv(run, documents);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // mn5: a template name is free text somebody typed and can contain `/`,
  // `\` and `:` — the same input class the DOCX filename acquired.
  a.download = `${safeFileName(run.templateSnapshot.name, 'tabular-review')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
