/**
 * Splits a PDF's page-marked text back into the per-page segments
 * `parsePdf` (`documents.ts`) concatenated it as — each page written as
 * `[Page N]\n<pageText>\n\n`. A document with no such markers (docx, txt,
 * or anything `parsePdf` never touched) comes back as one segment, so a
 * per-page threshold check still applies to it.
 *
 * A dependency-free leaf module on purpose: `src/lib/documents.ts` (which
 * defines the `[Page N]` marker convention and needs this to decide whether
 * a persisted record needs its page images regenerated) and `modelContext.ts`
 * (which needs it for `usableText`) both depend on it, and `documents.ts`
 * imports pdf.js and mammoth — so a module either of them could reach back
 * into would drag a PDF parser wherever it went. It has no imports of its
 * own, which is what lets the browser and the server share one
 * implementation of the page split AND of the threshold below.
 */
/**
 * Below this many characters, a page is treated as having no usable text —
 * a scan, or a page whose OCR produced only noise.
 *
 * APPLIED PER PAGE, never to a document's combined length. A document-wide
 * check lets one typed cover page carry a scanned body over the bar, and
 * that blind spot has had to be fixed three times (CLAUDE.md). Every reader
 * of this constant splits with `pageSegments` first.
 *
 * It lived in `src/lib/documents.ts` — a browser module that imports pdf.js
 * and mammoth — which is why it moved: `modelContext.ts` needs it and now
 * runs on the server too, and importing it from there would have dragged a
 * PDF parser into the worker. It belongs beside the page split it is always
 * applied through, which is here.
 */
export const SCAN_TEXT_THRESHOLD = 20;

const PAGE_MARKER = /\[Page (\d+)\]\n/g;

/**
 * The same split as `pageSegments`, but keeping the page number each segment
 * was labelled with. `parsePdf` (`documents.ts`) writes each page as
 * `[Page N]\n<pageText>\n\n`, so N is the real page number — read it rather
 * than counting segments, because a document whose first page produced no
 * text still gets its marker, and an ordinal would then be off by one for
 * everything after it.
 *
 * Returns `[]` — not one unnumbered segment — for text with no markers
 * (docx, txt). A caller that needs a page number must be able to tell "this
 * document has no page information" apart from "page 1", and inventing a
 * page is the one thing citation pinning must never do.
 */
export function pageSegmentsWithNumbers(text: string): { page: number; text: string }[] {
  const markers = [...text.matchAll(PAGE_MARKER)];
  if (markers.length === 0) return [];

  return markers.map((match, i) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = i + 1 < markers.length ? (markers[i + 1].index ?? text.length) : text.length;
    return { page: Number(match[1]), text: text.slice(start, end) };
  });
}

export function pageSegments(text: string): string[] {
  const numbered = pageSegmentsWithNumbers(text);
  return numbered.length > 0 ? numbered.map(s => s.text) : [text];
}
