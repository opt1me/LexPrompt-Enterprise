import type { DocumentFile } from '../types';
import { SCAN_TEXT_THRESHOLD } from './documents';
import { pageSegments } from './pageSegments';

const PAGE_MARKER = /\[Page \d+\]/g;

/**
 * Strips the `[Page N]` markers `lib/documents.ts` inserts unconditionally
 * around every page's extracted text (`parsePdf`), so a fully scanned PDF —
 * whose pages contribute only those markers, no real content — is correctly
 * recognised as having no extractable text. Without stripping them, a
 * multi-page scan's `doc.text` reads as non-empty ("[Page 1]\n\n[Page 2]\n...")
 * even though there is nothing in it a model could actually read.
 */
export function extractableText(doc: DocumentFile): string {
  return doc.text.replace(PAGE_MARKER, '').trim();
}

/**
 * The per-page-aware "does this document actually have usable text" check.
 * Reuses `SCAN_TEXT_THRESHOLD` — the exact same "is this page too sparse to
 * be text" judgement `parsePdf` already made when deciding whether to
 * capture a page image — rather than a bare non-empty check (which let 1-19
 * characters of OCR noise, a watermark, or a stray header count as "has
 * text" and silently skip the page images captured for that very document)
 * or a second, separately-tuned number.
 *
 * Applied per page, not to the document's combined length, on purpose: a
 * mixed document (a typed cover page followed by scanned, unreadable pages)
 * has real text on page 1 and captured images for the rest, and a
 * document-wide character count would let a single readable cover page
 * carry the whole document over the bar.
 *
 * Shared by the chat panel's context builder (`chatContext.ts`) and the
 * review engine's pre-flight guard (`extractClause.ts`) so both apply the
 * identical rule rather than two separately-tuned checks.
 */
export function usableText(doc: DocumentFile): string {
  return pageSegments(doc.text)
    .map(page => page.trim())
    .filter(page => page.length >= SCAN_TEXT_THRESHOLD)
    .join('\n\n');
}

export type DocumentReadability =
  | { kind: 'ok'; text: string; useImages: boolean }
  /** No document contributed text or images — there is nothing to send. */
  | { kind: 'unreadable' }
  /** The document has nothing but page images to offer, and the selected
   *  model can't read images — sending them would waste a request on
   *  content the model is guaranteed not to use. */
  | { kind: 'needs-image-model' };

/**
 * The single-document version of the decision `chatContext.buildChatContext`
 * makes across a whole document set: is there enough here to send to the
 * model at all, and — when the only content is page images — can the
 * selected model actually read them? Both the chat panel and the review
 * engine (`extractClause`) resolve through this one function so a scanned
 * document on a text-only model is declined the same honest way in both
 * places, instead of the review path silently sending an empty prompt and
 * getting back a confident "the agreement is silent on this point."
 */
export function assessDocument(doc: DocumentFile, modelSupportsImages: boolean): DocumentReadability {
  const text = usableText(doc);
  const hasImages = Boolean(doc.pageImages?.length);

  if (text) return { kind: 'ok', text, useImages: hasImages && modelSupportsImages };
  if (hasImages) {
    return modelSupportsImages ? { kind: 'ok', text: '', useImages: true } : { kind: 'needs-image-model' };
  }
  return { kind: 'unreadable' };
}

// A rough, explicit heuristic rather than an unexplained number: English
// legal prose runs close to 4 characters per token for OpenRouter's
// tokenizers, so `contextLength * 4` approximates the model's character
// budget. Half of that is reserved for the system prompt, prior turns/other
// prompt scaffolding and the model's own reply, leaving the other half for
// document context.
const CHARS_PER_TOKEN = 4;
const CONTEXT_RESERVE_FRACTION = 0.5;
// Used only when the model's context length couldn't be looked up (list
// fetch failed, or the selected id isn't in the list) — a mid-sized window
// chosen so a lookup failure degrades to "conservative" rather than either
// "unusably tiny" or "silently unbounded".
const FALLBACK_CONTEXT_LENGTH = 32_000;

/**
 * Shared by the chat panel and the review engine: how many characters of
 * document content is it reasonable to send for a model with this context
 * length. Applying one formula in both places means a review is bounded by
 * the same budget a chat message already is — not truncated by the provider
 * without warning, and not silently unbounded either.
 */
export function contextBudgetChars(contextLength: number | undefined): number {
  const length = contextLength && contextLength > 0 ? contextLength : FALLBACK_CONTEXT_LENGTH;
  return Math.floor(length * CHARS_PER_TOKEN * CONTEXT_RESERVE_FRACTION);
}
