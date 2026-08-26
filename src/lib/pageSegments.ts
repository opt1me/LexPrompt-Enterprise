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
export function pageSegments(text: string): string[] {
  if (!/\[Page \d+\]\n/.test(text)) return [text];
  return text.split(/\[Page \d+\]\n/g).slice(1);
}
