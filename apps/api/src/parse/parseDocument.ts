import { SCAN_TEXT_THRESHOLD, pageSegmentsWithNumbers } from '@lexprompt/core';

/**
 * The server's half of §9's "who writes `parse_state`, and nothing else
 * does" (P12).
 *
 * Stage 2 stored `parse_state` from the browser's own parse and said *"Stage
 * 3 changes only who writes it."* This is that change: the upload stores the
 * bytes and returns, and a parse worker reads them here.
 *
 * ## Two parsers, one text — and the marker rule is why
 *
 * The browser keeps `parseFile` (`src/lib/documents.ts`) because the viewer
 * needs pdf.js in the tab anyway, for `findQuoteRects`. So this is a second
 * implementation of one thing, deliberately, and the part that must not
 * drift is the `[Page N]` markers: `derivePage` reads them to decide every
 * citation's page, and a marker that moved would send a reader to the wrong
 * part of a contract with apparent authority.
 *
 * `PAGE_MARKER`/`pageBlock` below are the shared shape of that rule, and
 * `parseDocument.test.ts` asserts the exact bytes against the browser's own
 * formatting. What is NOT extracted to `packages/core` is the loop around
 * them, and that is a judgement worth recording rather than a shortcut:
 *
 *  - The browser's loop interleaves TEXT extraction with CANVAS rendering,
 *    because it has the page open and rendering it a second time costs a
 *    reader a visible pause. The server's does not: rendering happens later,
 *    only for the pages that need it, only for a document that reaches a
 *    review, through `parse/pageImages.ts` (Spike 1) — and never at upload,
 *    where it would put a 100-page scan's render in front of the response.
 *  - The two IO shells share no type. `parseFile` takes a `File` and reaches
 *    for `document.createElement`; this takes bytes and reaches for
 *    `@napi-rs/canvas`, from a module that must not import a DOM lib
 *    (`apps/api`'s tsconfig has none).
 *
 * Extracting a "thin algorithm" over those would leave one function with a
 * page callback in it and two shells that are still most of the code, which
 * is a shape that reads as shared and is not. The FORMAT is what has to be
 * one thing, and it is.
 */

/** `[Page 1]` — the marker `derivePage` and `pageSegments` both read. */
export function pageMarker(n: number): string {
  return `[Page ${n}]`;
}

/**
 * One page's contribution to a document's text, byte for byte as the
 * browser's `parsePdf` writes it: the marker, a newline, the page's text, and
 * a BLANK LINE.
 *
 * The trailing blank line is load-bearing, not cosmetic. `pageSegments`
 * splits on the marker, and `usableText` drops a page whose text is sparse;
 * a document assembled without it would still parse, but every page's text
 * would run into the next page's marker and the last page would lose its
 * terminator — which changes what `derivePage` locates a quote in.
 */
export function pageBlock(n: number, text: string): string {
  return `${pageMarker(n)}\n${text}\n\n`;
}

export interface ParsedDocument {
  text: string;
  /** How many pages the source has. `1` for a docx or a txt: they have no
   *  page structure this parser can see, and pretending to a page count
   *  would put a number on a citation that means nothing. */
  pageCount: number;
  /** The 1-based numbers of the pages whose extracted text falls below
   *  `SCAN_TEXT_THRESHOLD` — the pages a vision model has to be shown as
   *  images. Empty for a document with a healthy text layer throughout. */
  sparsePages: number[];
  /** Set when the parse FAILED. The document is then `parse_state =
   *  'failed'` and is refused as a review target — never `'parsed'` with
   *  empty text, which is "the founding defect wearing a database column"
   *  (005's own words). */
  parseError?: string;
}

/**
 * PER PAGE, never over the document's total.
 *
 * A document-wide check lets one typed cover page carry a scanned body over
 * the bar, and **this blind spot has had to be fixed three times**
 * (`CLAUDE.md`). A ten-page document with one typed page and nine scanned
 * ones has plenty of text in total and is unreadable without images.
 */
export function sparsePagesOf(text: string): number[] {
  // `pageSegmentsWithNumbers`, not `pageSegments`: it reads the number each
  // segment was LABELLED with rather than counting segments, and a page that
  // produced no text still gets its marker — so an ordinal would be off by
  // one for everything after the first blank page, and the renderer would be
  // handed the wrong pages of a scan. It also returns `[]` for text with no
  // markers at all, which is the honest answer for a docx: no page
  // information, rather than one page called 1.
  return pageSegmentsWithNumbers(text)
    .filter(p => p.text.trim().length < SCAN_TEXT_THRESHOLD)
    .map(p => p.page);
}

/**
 * `pdfjs-dist/legacy/build/pdf.mjs`, and the path is not interchangeable
 * with the bare specifier — `import('pdfjs-dist')` throws `DOMMatrix is not
 * defined` under Node. Spike 1 found this and `parse/pageImages.ts` records
 * it at length; memoised here for the same reason it is memoised there.
 */
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>;
  return pdfjsPromise;
}

export type DocumentKind = 'pdf' | 'docx' | 'txt';

/**
 * `mime` decides, with the name as the tiebreak — the same order
 * `classify` uses in the browser, so a `.docx` uploaded with a generic
 * `application/octet-stream` is still read as one.
 */
export function classifyDocument(mime: string, name: string): DocumentKind {
  const lower = name.toLowerCase();
  if (mime === 'application/pdf' || lower.endsWith('.pdf')) return 'pdf';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || lower.endsWith('.docx')) return 'docx';
  return 'txt';
}

async function parsePdfBytes(bytes: Uint8Array): Promise<{ text: string; pageCount: number }> {
  const pdfjs = await loadPdfjs();
  // `data` is a COPY: pdf.js TRANSFERS the buffer it is handed to its worker
  // port, which DETACHES the caller's array — every later read sees length
  // 0, and the parse worker reads the same bytes again to render pages.
  // `pageImages.ts` records the `DataCloneError` this produced.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const pdf = await task.promise;
  try {
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      try {
        const content = await page.getTextContent();
        // `.join(' ')` over `item.str`, exactly as the browser does it. A
        // different separator here would change every quote's whitespace and
        // therefore whether `findQuoteRects` can locate it at all.
        const pageText = content.items
          .map((item: unknown) => (item as { str?: string }).str ?? '')
          .join(' ');
        text += pageBlock(i, pageText);
      } finally {
        page.cleanup();
      }
    }
    return { text, pageCount: pdf.numPages };
  } finally {
    // In pdf.js v6 `destroy()` lives on the LOADING TASK; the document proxy
    // has only `cleanup()`. Calling `pdf.destroy()` throws at the end of a
    // parse that had otherwise just succeeded.
    await task.destroy();
  }
}

/**
 * A document's text, from its bytes.
 *
 * NEVER REJECTS for a bad file: a parse that throws comes back as
 * `parseError`, and the caller writes `parse_state = 'failed'` with the
 * message. That is the same posture `extractClause` has — one bad document
 * must not take a batch with it — and it is why the failure is a value here
 * rather than an exception.
 */
export async function parseDocument(
  bytes: Uint8Array, mime: string, name: string,
): Promise<ParsedDocument> {
  const kind = classifyDocument(mime, name);
  try {
    if (kind === 'pdf') {
      const { text, pageCount } = await parsePdfBytes(bytes);
      return { text, pageCount, sparsePages: sparsePagesOf(text) };
    }
    if (kind === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({
        // A fresh `ArrayBuffer` of exactly this document's bytes. A
        // `Uint8Array` view into a larger pooled buffer — which is what
        // `Buffer.concat` and every stream reader hand back — would give
        // mammoth the whole pool, and it would read somebody else's upload
        // off the end of this one.
        arrayBuffer: bytes.buffer.slice(
          bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      });
      const text = result.value ?? '';
      return { text, pageCount: 1, sparsePages: [] };
    }
    const text = new TextDecoder().decode(bytes);
    return { text, pageCount: 1, sparsePages: [] };
  } catch (error) {
    return {
      text: '',
      pageCount: 0,
      sparsePages: [],
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}
