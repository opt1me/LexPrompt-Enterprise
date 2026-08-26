import type { DocumentFile, ReviewRun } from '../../types';

/**
 * RFC 4180 field escaping: every field is wrapped in double quotes and any
 * internal double quote is doubled. Wrapping unconditionally (not only when
 * the field "needs" it) is deliberate — legal summaries routinely contain
 * commas, quotes and newlines, and a conditional quote is exactly the kind
 * of thing that silently regresses when someone "simplifies" it later.
 */
export function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * One row per document, one column per clause (in template order), cells
 * holding the finding's summary. A missing finding (still pending, or an
 * error with no summary) renders as an empty field rather than throwing.
 * Rows are joined with CRLF per RFC 4180, which is what most spreadsheet
 * software expects for CSV.
 */
export function buildTabularCsv(run: ReviewRun, documents: DocumentFile[]): string {
  const clauses = run.templateSnapshot.clauses;
  const header = ['Document', ...clauses.map(c => c.title)].map(escapeCsvField).join(',');

  const rows = run.documentIds.map(docId => {
    const doc = documents.find(d => d.id === docId);
    const fields = [
      doc?.name ?? docId,
      ...clauses.map(c => run.findings[docId]?.[c.id]?.summary ?? ''),
    ];
    return fields.map(escapeCsvField).join(',');
  });

  return [header, ...rows].join('\r\n');
}
