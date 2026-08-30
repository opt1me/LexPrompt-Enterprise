import { derivePage } from './citationPage.ts';
import type { Citation } from './types.ts';

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Normalises anything into a valid `Citation[]`, and is the ONLY place that
 * conversion happens. Two callers need it and they must never disagree:
 * `extractClause` (fresh model output, which is `string[]` under the JSON
 * schema but arrives unvalidated from models that ignore the schema) and
 * `migrateReviewRecord` (a stored review written before sub-project B, whose
 * citations are `string[]`).
 *
 * Repair, never delete — the storage posture this project settled on in
 * sub-project A. A citation object missing its `documentId` gets the
 * document it was found under; a stored `page` that is not a finite number
 * is re-derived rather than carried forward; a `page` that cannot be derived
 * is simply absent. The only thing discarded is an entry with no usable
 * quote at all, because a citation with no quote cites nothing: it cannot be
 * displayed, cannot be matched by `findQuoteRects`, and cannot be pinned.
 *
 * `documentText` is optional so a caller with no text to hand (a review
 * whose document was deleted from the matter) still gets valid citations —
 * just without pages.
 */
export function repairCitations(
  raw: unknown,
  documentId: string,
  documentText?: string,
): Citation[] {
  if (!Array.isArray(raw)) return [];

  const out: Citation[] = [];

  for (const entry of raw) {
    const quote = typeof entry === 'string'
      ? asString(entry)
      : asString((entry as { quote?: unknown } | null)?.quote);
    if (!quote) continue;

    const source = (typeof entry === 'object' && entry !== null ? entry : {}) as Partial<Citation>;

    const citation: Citation = {
      quote,
      documentId: asString(source.documentId) ?? documentId,
    };

    // A stored page is trusted only when it is a finite number. Anything
    // else is re-derived from the text, and stays absent if it cannot be.
    const storedPage = typeof source.page === 'number' && Number.isFinite(source.page)
      ? source.page
      : undefined;
    const page = storedPage ?? (documentText ? derivePage(documentText, quote) : undefined);
    if (page !== undefined) citation.page = page;

    const clauseRef = asString(source.clauseRef);
    if (clauseRef) citation.clauseRef = clauseRef;

    out.push(citation);
  }

  return out;
}
