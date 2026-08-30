import { normalizeForMatch } from './citations.ts';
import { pageSegmentsWithNumbers } from './pageSegments.ts';

/** Below this many normalized characters a quote matches too much to pin a
 *  page on — the same floor `findQuoteRects` applies before it will try to
 *  locate a quote at all (its `MIN_QUOTE_LENGTH`). Duplicated as a constant
 *  here rather than imported because the matcher is not to be touched and
 *  does not export it. */
const MIN_QUOTE_LENGTH = 5;

/**
 * The one place a citation's page number is produced.
 *
 * Reads the `[Page N]` markers `parsePdf` writes into a PDF's extracted
 * text — the same text the model was shown and the same text that persists
 * in `DocumentRecord.text`, so this works at extraction time, at migration
 * time, and after a cold reload, without pdfjs and without touching the
 * verified `findQuoteRects` matcher.
 *
 * Normalization is `normalizeForMatch` — the matcher's own — so a quote the
 * viewer will successfully highlight derives the same page the viewer will
 * scroll to. Anything this cannot locate returns `undefined`: a wrong page
 * pin sends a reader to the wrong part of a contract with apparent
 * authority, which is strictly worse than no pin.
 */
export function derivePage(documentText: string, quote: string): number | undefined {
  const needle = normalizeForMatch(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return undefined;

  for (const segment of pageSegmentsWithNumbers(documentText)) {
    if (normalizeForMatch(segment.text).includes(needle)) return segment.page;
  }
  return undefined;
}
