// src/lib/citations.ts
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height?: number;
}

export interface PdfPageText {
  pageNum: number;
  items: PdfTextItem[];
}

export interface QuoteRect {
  pageNum: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_QUOTE_LENGTH = 5;
const FUZZY_MIN_LENGTH = 30;
const FUZZY_AFFIX = 15;

// Below this many total extracted characters across the whole document, a
// PDF is treated as having no usable text layer at all (a handful of stray
// characters — a stamp, a page number — isn't a text layer `findQuoteRects`
// could ever locate a real quote in).
const NO_TEXT_LAYER_THRESHOLD = 20;

/**
 * True when a PDF's total extractable text is negligible — the signature of
 * a scan with no OCR text layer, where `findQuoteRects` can never locate a
 * citation no matter how the quote is phrased. Extraction itself may still
 * work fine on such a document via a page-image fallback elsewhere; this is
 * purely about whether a citation can ever be scrolled to in the viewer.
 */
export function hasNoTextLayer(pages: PdfPageText[]): boolean {
  const totalLength = pages.reduce(
    (sum, page) => sum + page.items.reduce((s, item) => s + item.str.trim().length, 0),
    0,
  );
  return totalLength < NO_TEXT_LAYER_THRESHOLD;
}

/** Strips everything but letters and digits, lowercased, so a quote survives
 *  differences in punctuation, spacing and line breaking between the model's
 *  output and the PDF text layer. */
export function normalizeForMatch(text: string): string {
  return text.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/** Flattens one page's text items into a single normalized string plus a
 *  lookup from each character position back to the item that produced it. */
function flattenPage(items: PdfTextItem[]): { pageStr: string; charToItem: number[] } {
  let pageStr = '';
  const charToItem: number[] = [];
  items.forEach((item, itemIdx) => {
    const clean = normalizeForMatch(item.str);
    for (let c = 0; c < clean.length; c++) charToItem.push(itemIdx);
    pageStr += clean;
  });
  return { pageStr, charToItem };
}

/** Locates the next match at or after `from`, falling back to a prefix/suffix
 *  match for long quotes whose interior the model may have paraphrased.
 *  Returns null when no further match exists. */
function nextMatch(
  pageStr: string,
  needle: string,
  from: number,
): { index: number; length: number } | null {
  const exact = pageStr.indexOf(needle, from);
  if (exact !== -1) return { index: exact, length: needle.length };

  if (needle.length <= FUZZY_MIN_LENGTH) return null;

  const prefix = needle.slice(0, FUZZY_AFFIX);
  const suffix = needle.slice(-FUZZY_AFFIX);
  const pIdx = pageStr.indexOf(prefix, from);
  if (pIdx === -1) return null;

  const sIdx = pageStr.indexOf(suffix, pIdx + FUZZY_AFFIX);
  if (sIdx === -1) return null;
  if (sIdx - pIdx >= needle.length * 1.5) return null;

  return { index: pIdx, length: sIdx + FUZZY_AFFIX - pIdx };
}

export function findQuoteRects(pages: PdfPageText[], quotes: string[]): QuoteRect[] {
  const rects: QuoteRect[] = [];

  for (const quote of quotes) {
    if (!quote) continue;
    const needle = normalizeForMatch(quote);
    if (needle.length < MIN_QUOTE_LENGTH) continue;

    for (const { pageNum, items } of pages) {
      const { pageStr, charToItem } = flattenPage(items);
      let cursor = 0;

      while (cursor < pageStr.length) {
        const match = nextMatch(pageStr, needle, cursor);
        if (!match) break;

        const startItem = charToItem[match.index];
        const endItem = charToItem[match.index + match.length - 1];

        if (startItem !== undefined && endItem !== undefined) {
          for (const item of items.slice(startItem, endItem + 1)) {
            if (item.str.trim().length === 0) continue;
            rects.push({
              pageNum,
              x: item.transform[4],
              y: item.transform[5],
              w: item.width,
              h: item.height || 12,
            });
          }
        }
        cursor = match.index + 1;
      }
    }
  }

  return rects;
}
