import React from 'react';
import { findingsKeyFor, type PlaybookVersion } from '@lexprompt/core';
import type { DocumentFile, ReviewRun } from '../../types';
import {
  exportSummaryLine, dispositionsAsAtLine, dispositionsMayChangeLine,
  NO_EXPORT_CONTEXT, type ExportContext,
} from '../../lib/findingOutcome';
import { buildReportRows, type ReportRow } from './exportDocx';

/**
 * A THIRD RENDERER OVER THE SAME ONE FINDINGS MAP (R-G11 discharged).
 *
 * ## Why this discharges R-G11 rather than reopening it
 *
 * R-G11 dropped the tab because *"a `Report` tab advertises a live report
 * view the app does not have, and the handoff never draws one."* The app now
 * has one: `exportDocx.ts` and `csv.ts` produce a report, and every sentence
 * in it comes from `findingOutcome.ts`. So this tab is **a view of the
 * document the export produces** — same data, same functions, same words,
 * before it leaves the building.
 *
 * That is worth having for exactly the reason §19 gives for fearing the
 * export: *"a card is read next to its history; a DOCX is read on a train,
 * six weeks later, by a partner who was not in the review"*. This tab is the
 * last place anyone can look at what the train will carry.
 *
 * ## It declares no display string of its own
 *
 * Every sentence here comes from `findingOutcome.ts`, through
 * `buildReportRows` — the same function the DOCX builds its tables from, so
 * this is the SAME rows rendered differently rather than a second derivation
 * of them. The DOCX and the CSV drifted apart once before over a string of
 * exactly this kind (a CSV wrote unreviewed clauses as blank cells while the
 * DOCX said "could not be reviewed"), and a third surface writing its own
 * wording would be the next instance of that.
 *
 * The only strings this file declares are the short column HEADINGS below,
 * which name a field rather than state a fact. `ReportView.test.tsx` asserts
 * there is no bare text anywhere in the JSX, so a sentence cannot arrive as
 * markup.
 *
 * ## It is the third RENDERER and not a third PIPELINE
 *
 * No fetch, no `lib/api` import, no findings assembly of its own. A report
 * that fetched its own data would be the second pipeline `CLAUDE.md`'s rule
 * exists to forbid, and it would be the one place on the screen showing
 * something the cards beside it do not.
 *
 * Print-friendly by CSS, not by a second component — a separate print
 * renderer would be the fourth copy.
 */
const HEADINGS = {
  summary: 'Summary',
  risk: 'Risk',
  evidence: 'Evidence',
  notes: 'Notes',
  trail: 'How this was derived',
  document: 'Document',
} as const;

export interface ReportViewProps {
  run: ReviewRun;
  documents: DocumentFile[];
  /** What the exporters are handed. `NO_EXPORT_CONTEXT` is the deliberate
   *  loud fallback: it dates nothing and names nobody, so a report built
   *  without one says "Dispositions as at: not recorded" at the top rather
   *  than looking finished. */
  exportContext?: ExportContext;
  /** Resolved by the caller from `run.playbookVersionId` (R-D15). Rendered
   *  only when it has actually resolved, never guessed. */
  playbookVersion?: PlaybookVersion | null | 'error';
}

export function ReportView({
  run, documents, exportContext, playbookVersion,
}: ReportViewProps) {
  const context = exportContext ?? NO_EXPORT_CONTEXT;
  const documentNames = Object.fromEntries(documents.map(d => [d.id, d.name]));
  const version = playbookVersion && playbookVersion !== 'error'
    ? playbookVersion.version : undefined;

  // ONE key per rendered section, through `findingsKeyFor` — a collection
  // review keys its findings by the COLLECTION id however many documents fed
  // it, and keying by a document here would render an empty report for one.
  const sections = run.documentIds.map(docId => ({
    docId,
    name: documentNames[docId] ?? docId,
    key: findingsKeyFor(run.target, docId),
    rows: buildReportRows(run, docId, documentNames, context),
  }));

  return (
    <div
      data-report-view
      className="h-full overflow-y-auto bg-paper px-6 py-5 print:overflow-visible print:px-0"
    >
      <header className="space-y-1 mb-4">
        <h2 className="font-prose text-section text-ink-1">{run.templateSnapshot.name}</h2>
        {version !== undefined && (
          <p data-report-version className="font-mono text-pin uppercase text-ink-4">
            {`v${version}`}
          </p>
        )}
        {/* THE EXPORT'S OWN THREE OPENING LINES, verbatim. A reader looking
            at this is looking at what the DOCX will say. */}
        <p data-report-summary className="font-ui text-ui-sm text-ink-2">
          {exportSummaryLine(run.findings)}
        </p>
        <p data-report-asat className="font-ui text-ui-sm text-ink-2">
          {dispositionsAsAtLine(context.readAt, context.timeZone)}
        </p>
        <p data-report-maychange className="font-ui text-ui-sm text-ink-3">
          {dispositionsMayChangeLine()}
        </p>
      </header>

      {sections.map(section => (
        <section key={section.key} data-report-section={section.key} className="mb-6 space-y-3">
          <h3 className="font-mono text-chip uppercase text-ink-4">
            {`${HEADINGS.document}: ${section.name}`}
          </h3>
          {section.rows.map((row, i) => (
            <Row key={`${section.key}:${i}`} row={row} />
          ))}
        </section>
      ))}
    </div>
  );
}

/** One clause, in the order the export writes it. Every line is a value from
 *  `buildReportRows`; nothing here composes one. */
function Row({ row }: { row: ReportRow }) {
  return (
    <article
      data-report-row
      className="border border-rule rounded-card bg-card px-4 py-3 space-y-2 break-inside-avoid"
    >
      <h4 className="font-ui text-ui text-ink-1 font-semibold">{row.title}</h4>

      {/* THE CAVEATS FIRST, exactly as the DOCX writes them: a reader must
          meet "could not be reviewed" before the text it qualifies. */}
      {row.verificationLabel && (
        <p data-report-verification className="font-ui text-ui-sm text-risk-med">
          {row.verificationLabel}
        </p>
      )}
      {row.dispositionLine && (
        <p data-report-disposition className="font-ui text-ui-sm text-ink-3">
          {row.dispositionLine}
        </p>
      )}
      {row.netPositionLabel && (
        <p className="font-ui text-ui-sm text-risk-med">{row.netPositionLabel}</p>
      )}
      {row.netPositionAmendmentLabel && (
        <p className="font-ui text-ui-sm text-ink-3">{row.netPositionAmendmentLabel}</p>
      )}
      {row.truncationLabel && (
        <p data-report-truncation className="font-ui text-ui-sm text-risk-med">
          {row.truncationLabel}
        </p>
      )}
      {row.positionOutcomeLabel && (
        <p data-report-position className="font-ui text-ui-sm text-ink-2">
          {row.positionOutcomeLabel}
        </p>
      )}
      {row.positionRationale.map((line, i) => (
        <p key={`rationale:${i}`} className="font-prose text-field text-ink-prose">{line}</p>
      ))}

      <div className="space-y-1">
        <h5 className="font-mono text-chip uppercase text-ink-4">{HEADINGS.summary}</h5>
        <p className="font-prose text-field text-ink-prose">{row.summary}</p>
      </div>

      {row.riskAnalysis && (
        <div className="space-y-1">
          <h5 className="font-mono text-chip uppercase text-ink-4">{HEADINGS.risk}</h5>
          <p className="font-prose text-field text-ink-prose">
            {row.riskLevel ? `${row.riskLevel}: ${row.riskAnalysis}` : row.riskAnalysis}
          </p>
        </div>
      )}

      {row.citations.length > 0 && (
        <div className="space-y-1">
          <h5 className="font-mono text-chip uppercase text-ink-4">{HEADINGS.evidence}</h5>
          <ul className="space-y-1">
            {row.citations.map((c, i) => (
              <li
                key={`cite:${i}`}
                data-report-citation
                className="font-prose text-field text-ink-quote border-l-2 border-rule pl-2"
              >
                {c.quote}
              </li>
            ))}
          </ul>
        </div>
      )}

      {row.notes.length > 0 && (
        <div className="space-y-1">
          <h5 className="font-mono text-chip uppercase text-ink-4">{HEADINGS.notes}</h5>
          {row.notes.map((line, i) => (
            <p key={`note:${i}`} className="font-prose text-field text-ink-prose">{line}</p>
          ))}
        </div>
      )}

      {row.trail.length > 0 && (
        <div className="space-y-1">
          <h5 className="font-mono text-chip uppercase text-ink-4">{HEADINGS.trail}</h5>
          {row.trail.map((line, i) => (
            <p key={`trail:${i}`} className="font-ui text-ui-sm text-ink-3">{line}</p>
          ))}
        </div>
      )}
    </article>
  );
}

export { HEADINGS as REPORT_HEADINGS };
