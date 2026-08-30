import type { DocumentFile, DocumentRecord } from '../types';
import { isNotYetRead, notYetReadMessage, pageSegments, SCAN_TEXT_THRESHOLD, uid } from '@lexprompt/core';
import type { PdfPageText } from '@lexprompt/core';
import { debug } from './debug';
import { detectDocxMarkup, markupNoticeFor, MARKUP_UNCHECKED_NOTICE } from './docxMarkup';
// `pageSegments` and `SCAN_TEXT_THRESHOLD` moved to `@lexprompt/core`
// together: the threshold is a per-page rule this module and the review
// engine must apply identically, and the engine now runs on the server,
// where this file's pdf.js and mammoth imports cannot follow.

/**
 * A page with almost no extractable text is a scan; we render it to an
 * image so a vision-capable model can read it instead. Exported so other
 * consumers of a page's extracted text (the chat panel's context builder)
 * apply the exact same "is this page too sparse to be text" judgement
 * `parsePdf` made, rather than a second, separately-tuned number.
 */

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Lazily imports pdfjs-dist and configures its worker exactly once. pdfjs-dist
 * is large enough that a top-level `import` here would pull it into the main
 * bundle even for documents that never touch it (parseFiles handles txt/docx
 * too) — this keeps it out of the initial load, only fetching it the first
 * time a PDF is actually parsed or viewed.
 *
 * `PdfCanvas` (the PDF viewer) funnels through this too, since it previously
 * relied on this module's top-level side effect to configure the worker
 * merely by importing `readArrayBuffer`/`extractPageText` from it. Memoising
 * the import means concurrent `parseFile` calls (parseFiles runs a whole
 * batch in parallel) and the viewer never race to set `workerSrc` twice.
 */
export function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist')
      .then(mod => {
        // Worker resolved through Vite rather than a CDN global. This is what
        // removes the `window['pdfjs-dist/build/pdf']` bug class permanently.
        mod.GlobalWorkerOptions.workerSrc = new URL(
          'pdfjs-dist/build/pdf.worker.mjs',
          import.meta.url,
        ).toString();
        return mod;
      })
      .catch(error => {
        // Only the success case is worth memoising. A failed import (e.g. a
        // stale chunk hash after a redeploy while the tab stayed open) must
        // not poison every future call forever with no way to recover short
        // of a full page refresh — clear the memo so the next PDF gets a
        // fresh attempt, while still failing the caller that hit this one.
        pdfjsPromise = null;
        throw error;
      });
  }
  return pdfjsPromise;
}

/** `File.prototype.arrayBuffer()` is standard in real browsers but is not
 *  implemented by jsdom's Blob/File (used in the test environment), so a
 *  FileReader fallback keeps this working under both. */
export function readArrayBuffer(file: File): Promise<ArrayBuffer> {
  if (typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

function classify(file: File): DocumentFile['kind'] {
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (
    file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    name.endsWith('.docx')
  ) return 'docx';
  return 'txt';
}

type MinimalPdfPage = {
  getViewport: (o: { scale: number }) => { width: number; height: number };
  getTextContent: () => Promise<{ items: unknown[] }>;
  render: (o: { canvas: HTMLCanvasElement; viewport: { width: number; height: number } }) => { promise: Promise<void> };
};

async function renderPageToJpeg(page: MinimalPdfPage): Promise<{ mime: string; data: string } | null> {
  // A canvas problem should cost the page image, never the whole document.
  // Some environments (real jsdom, older browsers without a 2D backend)
  // *throw* out of getContext('2d') rather than returning null, so this
  // whole body is guarded, not just a falsy-context check.
  try {
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    // pdfjs-dist v6's RenderParameters requires `canvas` (canvasContext is now
    // an optional backwards-compat field); we still need a 2D context to be
    // sure the canvas is usable before handing it to render().
    if (!canvas.getContext('2d')) return null;
    await page.render({ canvas, viewport }).promise;
    return { mime: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] };
  } catch (error) {
    debug('renderPageToJpeg failed, continuing without a page image', error);
    return null;
  }
}

async function parsePdf(file: File): Promise<{ text: string; pageImages?: { mime: string; data: string }[] }> {
  const pdfjs = await loadPdfjs();
  // v6's getDocument() takes a DocumentInitParameters object, not a bare
  // ArrayBuffer -- passing the buffer directly does not match the installed
  // .d.ts (`getDocument(src?: DocumentInitParameters)`), so it must be wrapped
  // in `{ data: ... }`.
  const pdf = await pdfjs.getDocument({ data: await readArrayBuffer(file) }).promise;
  let text = '';
  const pageImages: { mime: string; data: string }[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = (await pdf.getPage(i)) as unknown as MinimalPdfPage;
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: unknown) => (item as { str?: string }).str ?? '')
      .join(' ');
    text += `[Page ${i}]\n${pageText}\n\n`;

    if (pageText.trim().length < SCAN_TEXT_THRESHOLD) {
      const image = await renderPageToJpeg(page);
      if (image) pageImages.push(image);
    }
  }

  return { text, pageImages: pageImages.length ? pageImages : undefined };
}

/**
 * The provenance caveat for a `.docx`, or `undefined` when there is nothing
 * to say. Never throws: a document whose package cannot be inspected is
 * still perfectly readable (mammoth got its text), so the failure must not
 * become the file's `parseError` and block a review that can legitimately
 * run — but it must not pass in silence either, because silence here reads
 * as "checked, clean". It becomes `MARKUP_UNCHECKED_NOTICE` instead.
 *
 * The `try` covers `detectDocxMarkup` whole, which includes its own lazy
 * import of jszip — so a chunk that fails to load (a stale hash after a
 * redeploy, an offline tab) reports "could not check" like any other
 * failure to look, rather than escaping as an unhandled rejection.
 */
async function docxMarkupNotice(bytes: ArrayBuffer, name: string): Promise<string | undefined> {
  try {
    return markupNoticeFor(await detectDocxMarkup(bytes));
  } catch (error) {
    debug('could not check for tracked changes', name, error);
    return MARKUP_UNCHECKED_NOTICE;
  }
}

export async function parseFile(file: File): Promise<DocumentFile> {
  const kind = classify(file);
  const base: DocumentFile = { id: uid(), name: file.name, text: '', file, kind };

  try {
    if (kind === 'pdf') {
      const { text, pageImages } = await parsePdf(file);
      return { ...base, text, pageImages };
    }
    if (kind === 'docx') {
      const bytes = await readArrayBuffer(file);
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ arrayBuffer: bytes });
      const markupNotice = await docxMarkupNotice(bytes, file.name);
      // Spread conditionally rather than writing `markupNotice: undefined`:
      // `structuredClone` (how every record reaches IndexedDB) preserves an
      // undefined-valued key, and a stored `markupNotice: undefined` is not
      // the same thing as a document with nothing to disclose.
      return { ...base, text: result.value ?? '', ...(markupNotice ? { markupNotice } : {}) };
    }
    return { ...base, text: await file.text() };
  } catch (error) {
    // A bad file is reported against itself; the rest of a batch still runs.
    const message = error instanceof Error ? error.message : String(error);
    debug('parseFile failed', file.name, message);
    return { ...base, parseError: message };
  }
}

export async function parseFiles(files: File[]): Promise<DocumentFile[]> {
  return Promise.all(files.map(parseFile));
}

/** Converts a parsed, in-memory `DocumentFile` into the pair
 *  `src/lib/db/documents.ts`'s `addDocument` needs to persist it: a durable
 *  `DocumentRecord` (metadata + extracted text, no live handles) and the
 *  original file bytes as a `Blob`.
 *
 *  Deliberately drops `pageImages` — LexPrompt persists source bytes, never
 *  derived page images. A page image is a base64 string roughly a third
 *  larger than the bytes it was rendered from, and given the original file
 *  it can always be regenerated by the same rendering path that produced it
 *  here (`parsePdf`/`renderPageToJpeg`). Persisting both would be the
 *  largest storage cost in the app for no benefit. */
export function toDocumentRecord(
  doc: DocumentFile,
  matterId: string,
  userId: string,
): { record: DocumentRecord; bytes: Blob } {
  return {
    record: {
      id: doc.id,
      matterId,
      name: doc.name,
      kind: doc.kind,
      text: doc.text,
      parseError: doc.parseError,
      // Conditional, unlike `parseError` above, so a document with nothing
      // to disclose stores no key at all: `structuredClone` preserves an
      // `undefined`-valued key, and a record written with
      // `markupNotice: undefined` is indistinguishable, on read, from one
      // that was checked and found clean — while a record with the key
      // genuinely absent is exactly what a pre-existing document looks
      // like (never checked; see the README's known limitations).
      ...(doc.markupNotice ? { markupNotice: doc.markupNotice } : {}),
      byteSize: doc.file.size,
      addedAt: Date.now(),
      addedByUserId: userId,
      // Every newly-added document starts standalone; it only becomes
      // 'base'/'varies' when a human explicitly groups it into a
      // collection (App.tsx's handleCreateCollection), never at ingest.
      role: 'standalone',
    },
    bytes: doc.file,
  };
}

/** The message shown wherever a persisted document's original bytes cannot
 *  be found — a missing `blobs` entry for a `DocumentRecord` that still
 *  exists (spec §9: "renders as unavailable with its metadata intact",
 *  never a blank viewer). Shared so the wording is identical whether the
 *  cause is opening a matter's documents for review or reopening a past
 *  review whose document blob has since gone missing. */
export const BLOB_UNAVAILABLE_MESSAGE = 'The original file for this document is no longer available.';



/**
 * The stored provenance caveat, spread onto every `DocumentFile` rebuilt
 * from a record — for viewing and for review alike.
 *
 * The person reading a review is often not the person who uploaded the
 * file, and may be reading it weeks later in a different session, so a
 * notice that existed only on the in-memory `DocumentFile` at upload time
 * would be gone exactly when it matters. Spread (rather than assigned) so a
 * record with no notice yields a `DocumentFile` with no key, not one with
 * `markupNotice: undefined`.
 */
function carriedMarkupNotice(record: DocumentRecord): { markupNotice?: string } {
  return record.markupNotice ? { markupNotice: record.markupNotice } : {};
}

/** Rebuilds a `DocumentFile` for VIEWING a persisted document: wraps the
 *  stored blob back into a `File` and reuses the text already extracted at
 *  ingest time, without re-parsing. No re-parse is needed here because the
 *  viewer (`DocumentViewer`/`PdfCanvas`) renders straight from `file` and
 *  never touches `pageImages` — that field only matters when *running* a
 *  new review over the document — the server hydrates for review now.
 *
 *  `blob === null` (the document's bytes could not be found — see
 *  `getDocumentBlob`) degrades to a viewer-less placeholder rather than
 *  throwing: the document's metadata (name, kind, extracted text) is still
 *  real and still shown, only the original file is unavailable.
 *
 *  A record the server has not finished reading (`parseState: 'pending'`)
 *  carries `text: ''`, and BOTH hydrations say so rather than handing back
 *  a document that appears to be silent. Before this, the upload's own
 *  blanked row was the browser's only copy of a document's text after a
 *  reload, and every clause of a review over it came back *"It may have
 *  failed to parse, or be a scan with no extractable content"* — false in
 *  both branches, for a document that simply had not been read yet. */
export function documentFileForViewing(record: DocumentRecord, blob: Blob | null): DocumentFile {
  return {
    id: record.id,
    name: record.name,
    text: record.text,
    file: blob ? new File([blob], record.name, { type: blob.type }) : new File([], record.name),
    kind: record.kind,
    // The not-yet-read sentence wins over the missing-blob one: a document
    // still being read is on its way to working, and "add the file again"
    // is the wrong instruction for it.
    parseError: isNotYetRead(record)
      ? notYetReadMessage(record.name)
      : (record.parseError ?? (blob ? undefined : BLOB_UNAVAILABLE_MESSAGE)),
    ...carriedMarkupNotice(record),
  };
}

/**
 * TASK 20: `documentFileForReview`, THE PAGE-IMAGE CACHE AND
 * `evictPageImages` ARE GONE — with the last browser caller that needed
 * them.
 *
 * They existed because the browser handed documents to the extractor: a
 * scan's page images are derived data, never persisted, and had to be
 * regenerated on demand before a review could read one. Nothing in `src/`
 * runs an extractor any more. A run is a POST and a retry is a POST, and
 * the server hydrates for review itself.
 *
 * The RULE they carried has not gone anywhere — it moved to where the
 * extraction now happens, which is the only place it can be true:
 * `apps/api/src/parse/hydrate.ts`'s own `documentFileForReview`, with the
 * per-page `SCAN_TEXT_THRESHOLD` check, the byte-bounded cache, the
 * still-being-read refusal and the missing-bytes refusal, all proved
 * against a real Postgres in `hydrate.pg.test.ts`. Keeping a second copy
 * here — reachable from nothing — is the sibling drift this project has six
 * findings about, in the form where one copy is dead and nobody notices it
 * has stopped agreeing with the live one.
 *
 * `documentFileForViewing` stays. It is the hydration the VIEWER wants and
 * it carries no page images by design: `PdfCanvas` renders the PDF itself.
 */

/** Builds the per-page text-item index the citation matcher needs. */
export async function extractPageText(pdf: {
  numPages: number;
  getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
}): Promise<PdfPageText[]> {
  const pages: PdfPageText[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push({ pageNum: i, items: content.items as PdfPageText['items'] });
  }
  return pages;
}
