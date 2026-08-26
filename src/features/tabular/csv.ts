import type { DocumentFile, ReviewRun } from '../../types';

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
