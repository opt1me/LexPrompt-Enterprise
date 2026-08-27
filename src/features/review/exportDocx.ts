import type { Citation, ReviewRun, RiskLevel } from '../../types';
import {
  describeFindingOutcome, exportSummaryLine, verificationLabel, noteLines,
  netPositionLabel, netPositionAmendmentLabel, trailLines,
  collectionExportLabel, safeFileName, truncationLabel,
} from '../../lib/findingOutcome';
import { findingsKeyFor, isCollectionTarget } from '../../lib/reviewTarget';

export interface ReportRow {
  title: string;
  summary: string;
  riskLevel?: RiskLevel;
  riskAnalysis?: string;
  citations: Citation[];
  verificationLabel: string | null;
  /** Important 3 (spec §6: "a flagged finding carries its flag and any
   *  note"): one formatted, attributed line per note. Shared with the CSV
   *  exporter via `findingOutcome.ts`'s `noteLines` so the two cannot
   *  disagree about what a note looks like once it leaves the app. */
  notes: string[];
  /** Task 9: a caveat independent of `verificationLabel` — a collection
   *  finding has BOTH a verification (has a human checked this AI output)
   *  and a net position confirmation (has a human accepted THIS synthesis).
   *  `null` for a standalone finding, a confirmed position, or a finding
   *  with no net position at all — see `netPositionLabel`'s own doc comment
   *  for why those last two both return `null` for different reasons. */
  netPositionLabel: string | null;
  /** Positive provenance, not a caveat: says a PERSON rewrote the position
   *  text (`row.summary`), for exactly the case `netPositionLabel` cannot
   *  say (a confirmed position is unlabelled either way it was confirmed).
   *  `null` unless the position was amended. */
  netPositionAmendmentLabel: string | null;
  /** The derivation behind a net position — one line per contributing
   *  document, in effect order. Empty for anything without a net position.
   *  A conclusion exported without this is an assertion, not a derivation. */
  trail: string[];
  /** mn6: says the model did not see all of the text this row is drawn
   *  from, naming the documents that were cut short. A fourth caveat,
   *  independent of the three above — no verification or confirmation state
   *  can express "the source was incomplete". `null` when the whole text
   *  fit, or when the row has no settled answer to qualify. */
  truncationLabel: string | null;
}

/**
 * Derives the report's row data from a run, independent of the docx
 * document construction below. This is the part where the row-level
 * decisions live — most importantly, that a clause whose extraction failed
 * still gets a row that says so, rather than being silently dropped. A
 * report that omits a failed clause reads as "checked, nothing found",
 * which is worse than an honest failure notice.
 */
export function buildReportRows(
  run: ReviewRun,
  docId: string,
  documentNames: Record<string, string> = {},
): ReportRow[] {
  // A collection review's findings live under the COLLECTION id, not the
  // document id — `findingsKeyFor` resolves that (and is a no-op for an
  // ordinary document review, where it just returns `docId` back). Keying
  // directly by `docId` here used to make a collection review's export
  // silently empty (Step 0 of this task).
  const findings = run.findings[findingsKeyFor(run.target, docId)];
  if (!findings) return [];

  return run.templateSnapshot.clauses.map(clause => {
    const finding = findings[clause.id];

    // `describeFindingOutcome` is the one place that decides what text
    // represents a finding's outcome — including, since Task 9, preferring
    // a net position's text (a collection finding's `summary` is always
    // undefined) over the plain `finding.summary` this used to read
    // directly. Calling it unconditionally, rather than only for the
    // not-done branch below, is what keeps a `done` collection finding from
    // exporting as the empty string it did before.
    const summary = describeFindingOutcome(finding);

    if (!finding || finding.status !== 'done') {
      return {
        title: clause.title,
        summary,
        citations: [],
        verificationLabel: verificationLabel(finding),
        notes: noteLines(finding),
        netPositionLabel: netPositionLabel(finding),
        netPositionAmendmentLabel: netPositionAmendmentLabel(finding),
        trail: trailLines(finding, documentNames),
        truncationLabel: truncationLabel(finding),
      };
    }

    return {
      title: clause.title,
      summary,
      riskLevel: finding.riskLevel,
      riskAnalysis: finding.riskAnalysis,
      citations: finding.citations,
      verificationLabel: verificationLabel(finding),
      notes: noteLines(finding),
      netPositionLabel: netPositionLabel(finding),
      netPositionAmendmentLabel: netPositionAmendmentLabel(finding),
      trail: trailLines(finding, documentNames),
      truncationLabel: truncationLabel(finding),
    };
  });
}

/** Maps a risk level to the same pastel cell-shading colours the original
 *  report used. Anything without a recognised level (including the "could
 *  not be reviewed" rows, which carry no riskLevel) gets no risk row at all. */
function riskFill(level: RiskLevel): string {
  if (level === 'High') return 'FFCCCC';
  if (level === 'Medium') return 'FFF4CC';
  if (level === 'Low') return 'CCFFCC';
  return 'FFFFFF';
}

function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '');
}

/**
 * Builds the `docx` `Document` object for a report: one bordered table per
 * clause, matching the structure of the original (deleted) ResultsView's
 * exporter — a header row, a labelled row for anything a human hasn't
 * verified, a summary row, an optional risk row (shaded by level), an
 * evidence header, and one numbered row per citation (or a "no reference
 * found" placeholder when there are none).
 *
 * Split out from `exportDocx` so the document construction — including
 * whether the verification label actually reaches the table, which
 * `buildReportRows` alone cannot prove — is exercised directly in tests via
 * `Packer.toBuffer` and a zip read of `word/document.xml`, rather than only
 * asserting on the intermediate `ReportRow[]` data.
 *
 * `docx` is dynamically imported so it never enters the app's entry chunk —
 * most sessions never export a report, and the library is large enough that
 * a top-level import would make every user pay for it on first load.
 */
export async function buildReportDocument(rows: ReportRow[], docName: string, summaryLine: string) {
  const {
    Document, Paragraph, TextRun, HeadingLevel, AlignmentType,
    Table, TableRow, TableCell, WidthType, BorderStyle,
  } = await import('docx');

  const children: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [
    new Paragraph({
      text: `Review Report: ${docName}`,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
    }),
    new Paragraph({
      text: `Generated by LexPrompt on ${new Date().toLocaleDateString()}`,
      alignment: AlignmentType.CENTER,
      spacing: { after: 500 },
    }),
    new Paragraph({
      children: [new TextRun({ text: summaryLine, bold: true })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
    }),
  ];

  const cellMargins = { top: 100, bottom: 100, left: 100, right: 100 };

  for (const row of rows) {
    const tableRows = [];

    // Header
    tableRows.push(new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: row.title, bold: true, color: 'FFFFFF' })] })],
          columnSpan: 2,
          shading: { fill: '333333' },
          margins: cellMargins,
        }),
      ],
    }));

    // A labelled row for anything a human has not verified. Placed above the
    // summary, not below the evidence, because a reader skimming the report
    // must meet the caveat before they read the claim.
    if (row.verificationLabel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row.verificationLabel, bold: true })] })],
            columnSpan: 2,
            shading: { fill: 'FFF4CC' },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // mn6: the source text itself was incomplete. Above the net-position
    // caveat and the summary, because it qualifies everything below it —
    // a reader must not reach a confident synthesis before learning that the
    // model was only shown part of the deed it was drawn from.
    if (row.truncationLabel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row.truncationLabel, bold: true })] })],
            columnSpan: 2,
            shading: { fill: 'FFE4CC' },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // A second, independent caveat (Task 9): a collection finding can be
    // unverified AND carry a net position nobody has confirmed — either can
    // apply without the other, so this is its own row, not folded into
    // `verificationLabel`'s.
    if (row.netPositionLabel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row.netPositionLabel, bold: true })] })],
            columnSpan: 2,
            shading: { fill: 'EDE4FF' },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // Positive provenance, not a caveat (Task 9): says a person rewrote the
    // summary above, for the one case a `null` `netPositionLabel` cannot
    // distinguish from "the model's synthesis, merely accepted as written."
    if (row.netPositionAmendmentLabel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: row.netPositionAmendmentLabel, italics: true })] })],
            columnSpan: 2,
            shading: { fill: 'EEF2FF' },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // Notes (Important 3 — spec §6): each one its own row, right after the
    // verification caveat and before the summary, for the same reason the
    // label sits there — a reader skimming must meet a human's own comment
    // before the AI-authored claim.
    for (const note of row.notes) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: note })] })],
            columnSpan: 2,
            shading: { fill: 'EEF2FF' },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // Summary
    tableRows.push(new TableRow({
      children: [
        new TableCell({
          children: [
            new Paragraph({ children: [new TextRun({ text: 'Summary', bold: true })] }),
            new Paragraph({ text: row.summary }),
          ],
          columnSpan: 2,
          margins: cellMargins,
        }),
      ],
    }));

    // Risk (only when the clause actually carries a risk level)
    if (row.riskLevel) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'RISK RATING', bold: true })] }),
              new Paragraph({ children: [new TextRun({ text: row.riskLevel.toUpperCase(), bold: true })] }),
            ],
            width: { size: 20, type: WidthType.PERCENTAGE },
            shading: { fill: riskFill(row.riskLevel) },
            verticalAlign: 'center',
            margins: cellMargins,
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Risk Analysis', bold: true })] }),
              new Paragraph({ text: row.riskAnalysis || 'No specific analysis provided.' }),
            ],
            width: { size: 80, type: WidthType.PERCENTAGE },
            margins: cellMargins,
          }),
        ],
      }));
    }

    // Evidence header
    tableRows.push(new TableRow({
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Evidence', bold: true })] })],
          columnSpan: 2,
          shading: { fill: 'EEEEEE' },
          margins: { top: 50, bottom: 50, left: 100, right: 100 },
        }),
      ],
    }));

    // Citations, numbered — or an honest placeholder when there are none.
    if (row.citations.length > 0) {
      row.citations.forEach((cite, idx) => {
        tableRows.push(new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: `Ref ${idx + 1}`, bold: true })] })],
              width: { size: 15, type: WidthType.PERCENTAGE },
              margins: { top: 50, bottom: 50, left: 50, right: 50 },
            }),
            new TableCell({
              children: [new Paragraph({
                children: [
                  new TextRun({ text: `"${cite.quote}"`, italics: true }),
                  ...(cite.page !== undefined
                    ? [new TextRun({ text: `  (p. ${cite.page})`, italics: false, color: '666666' })]
                    : []),
                ],
              })],
              width: { size: 85, type: WidthType.PERCENTAGE },
              margins: { top: 50, bottom: 50, left: 50, right: 50 },
            }),
          ],
        }));
      });
    } else {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ text: '-' })],
            width: { size: 15, type: WidthType.PERCENTAGE },
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'No Relevant Reference Found', italics: true })] })],
            width: { size: 85, type: WidthType.PERCENTAGE },
          }),
        ],
      }));
    }

    // Derivation (Task 9): the argument behind a net position, one row per
    // contributing document. Only present when `trail` is non-empty — a
    // standalone finding, or one with no net position, has none. A
    // conclusion exported without this is an assertion, not a derivation.
    if (row.trail.length > 0) {
      tableRows.push(new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: 'Derivation', bold: true })] })],
            columnSpan: 2,
            shading: { fill: 'EEEEEE' },
            margins: { top: 50, bottom: 50, left: 100, right: 100 },
          }),
        ],
      }));
      row.trail.forEach((line, idx) => {
        tableRows.push(new TableRow({
          children: [
            new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: `Step ${idx + 1}`, bold: true })] })],
              width: { size: 15, type: WidthType.PERCENTAGE },
              margins: { top: 50, bottom: 50, left: 50, right: 50 },
            }),
            new TableCell({
              children: [new Paragraph({ text: line })],
              width: { size: 85, type: WidthType.PERCENTAGE },
              margins: { top: 50, bottom: 50, left: 50, right: 50 },
            }),
          ],
        }));
      });
    }

    children.push(new Table({
      rows: tableRows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
        bottom: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
        left: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
        right: { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
        insideVertical: { style: BorderStyle.SINGLE, size: 1, color: 'EEEEEE' },
      },
    }));
    children.push(new Paragraph({ text: '', spacing: { after: 300 } }));
  }

  return new Document({ sections: [{ properties: {}, children }] });
}

/**
 * Builds and downloads a .docx report for one document in a run. See
 * `buildReportRows` for the row-level decisions and `buildReportDocument`
 * for how those rows become the actual `docx` document.
 */
export async function exportDocx(
  run: ReviewRun,
  docId: string,
  docName: string,
  /** documentId → display name, so a derivation trail names the document
   *  that varied a clause rather than printing its internal id. Optional so
   *  the existing tests and any caller without the map still compile;
   *  `trailLines` falls back to the id when a name is genuinely missing. */
  documentNames: Record<string, string> = {},
): Promise<void> {
  const rows = buildReportRows(run, docId, documentNames);
  // A collection is not one of its members. `docName` is whichever document
  // the viewer happened to be showing, and titling a collection's report
  // after it — in the heading, the filename and the no-findings error —
  // asserts that a synthesis drawn across every member belongs to that one
  // document. Same shape as the CSV defect that emitted one identical row
  // per member (M1): the report covers the collection, so it is named after
  // the collection's review, not after a member of it.
  //
  // mn4: through `collectionExportLabel`, which is where the CSV gets the
  // same words. The first version of this named the TEMPLATE — two
  // collections in one matter under one playbook produced the same title and
  // the same filename — and counted `run.documentIds` blind, announcing "3
  // linked documents" when one was gone. Two exporters naming one object two
  // ways is the drift that produced M1 between these same two files.
  const isCollection = isCollectionTarget(run.target);
  const reportName = isCollection
    ? collectionExportLabel(run.documentIds, documentNames)
    : docName;
  // Fail-loudly rule, applied to the surface where the whole app's founding
  // defect was first learned (CLAUDE.md): a review that genuinely has no
  // findings for this document/collection must say so, rather than handing
  // back a technically-valid .docx with a title and a summary line but zero
  // clause tables — a document a lawyer could send without ever noticing it
  // says nothing.
  if (rows.length === 0) {
    throw new Error(`No findings to export for ${reportName}. This review has no results to report yet.`);
  }
  // Important 4: this report covers ONE document (`buildReportRows(run,
  // docId)` above), so its header summary must count only that document's
  // findings — not `exportSummaryLine(run.findings)`, which counts the
  // whole run. The CSV export (`buildTabularCsv`) genuinely does cover every
  // document, so its whole-run summary is correct as-is; scoping only
  // belongs here, at the one place that reports on a single document.
  const docSummary = exportSummaryLine({ [docId]: run.findings[findingsKeyFor(run.target, docId)] ?? {} });
  const doc = await buildReportDocument(rows, reportName, docSummary);

  const { Packer } = await import('docx');
  const blob = await Packer.toBlob(doc);

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // The same label, built from names with their extensions already stripped
  // — one naming rule, two inputs, rather than a second rule for filenames.
  // mn5: sanitised, because this is no longer always a filename. `docName`
  // was; a collection label assembled from user-authored text can carry `/`,
  // `\` and `:`.
  const fileStem = isCollection
    ? collectionExportLabel(
      run.documentIds,
      Object.fromEntries(Object.entries(documentNames).map(([id, name]) => [id, stripExtension(name)])),
    )
    : stripExtension(docName);
  a.download = `${safeFileName(fileStem, 'Review')}_Report.docx`;
  a.click();
  URL.revokeObjectURL(url);
}
