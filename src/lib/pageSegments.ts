/**
 * Splits a PDF's page-marked text back into the per-page segments
 * `parsePdf` (`documents.ts`) concatenated it as — each page written as
 * `[Page N]\n<pageText>\n\n`. A document with no such markers (docx, txt,
 * or anything `parsePdf` never touched) comes back as one segment, so a
 * per-page threshold check still applies to it.
 *
 * A dependency-free leaf module on purpose: both `documents.ts` (which
 * defines the `[Page N]` marker convention and needs this to decide whether
 * a persisted record needs its page images regenerated) and `modelContext.ts`
 * (which needs it for `usableText`) depend on this function, and
 * `modelContext.ts` already imports `SCAN_TEXT_THRESHOLD` from
 * `documents.ts` — so `documents.ts` importing anything back from
 * `modelContext.ts` would cycle. Living here, with no imports of its own,
 * lets both sides share one implementation without that cycle.
 */
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
