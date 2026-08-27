import type { DocumentFile, DocumentRecord } from '../types';
import type { PdfPageText } from './citations';
import { debug } from './debug';
import { pageSegments } from './pageSegments';
import { uid } from './uid';

/**
 * A page with almost no extractable text is a scan; we render it to an
 * image so a vision-capable model can read it instead. Exported so other
 * consumers of a page's extracted text (the chat panel's context builder)
 * apply the exact same "is this page too sparse to be text" judgement
 * `parsePdf` made, rather than a second, separately-tuned number.
 */
export const SCAN_TEXT_THRESHOLD = 20;

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

export async function parseFile(file: File): Promise<DocumentFile> {
  const kind = classify(file);
  const base: DocumentFile = { id: uid(), name: file.name, text: '', file, kind };

  try {
    if (kind === 'pdf') {
      const { text, pageImages } = await parsePdf(file);
      return { ...base, text, pageImages };
    }
    if (kind === 'docx') {
      const mammoth = (await import('mammoth')).default;
      const result = await mammoth.extractRawText({ arrayBuffer: await readArrayBuffer(file) });
      return { ...base, text: result.value ?? '' };
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
 * Whether a persisted document needs its page images regenerated before a
 * review can use them: a PDF with at least one page whose extracted text
 * falls below `SCAN_TEXT_THRESHOLD`.
 *
 * Applied PER PAGE, not to the document's combined text length — the same
 * granularity `parsePdf` itself uses when deciding which pages to render
 * (and that `modelContext.ts`'s `usableText` uses for the identical reason
 * on the chat/review-context side). A document-wide character count would
 * let a single readable page carry an entire scanned document over the
 * threshold: a typed cover page followed by fifteen scanned signature pages
 * has plenty of text *in total*, but the body still needs page images for a
 * vision-capable model to read it. Checking per page is what catches that
 * mixed case; a whole-document check would silently skip regenerating
 * images for it.
 *
 * Non-PDF documents (docx, txt) never have page images to regenerate.
 */
function documentNeedsPageImages(record: DocumentRecord): boolean {
  if (record.kind !== 'pdf') return false;
  return pageSegments(record.text).some(page => page.trim().length < SCAN_TEXT_THRESHOLD);
}

type PageImages = NonNullable<DocumentFile['pageImages']>;

/**
 * Session-only cache of regenerated page images, keyed by document id, so a
 * second review of the same document in the same tab doesn't re-render a
 * multi-page scan it already rendered once. Deliberately never persisted —
 * that would reintroduce exactly the storage cost R2 (page images are
 * derived data, not stored) exists to avoid. A plain module-level `Map` is
 * enough: it lives only as long as this module instance (i.e. this page
 * load), and a reload starts over with a fresh, empty one automatically.
 *
 * An empty array is a valid cached value — it means "this document needed
 * images, regeneration ran, and every qualifying page's canvas render
 * failed" (see `renderPageToJpeg`'s per-page tolerance) — and must still
 * short-circuit a later review rather than retrying a render already known
 * to fail.
 *
 * Bounded, not unbounded: page images are the largest objects this app
 * holds in memory (a base64 JPEG per page, roughly a third larger than the
 * bytes it was rendered from), so a session that reviews many scanned
 * documents back to back must not grow this map forever — that would
 * reproduce, in memory instead of on disk, exactly the storage-cost problem
 * that motivated never persisting page images in the first place. Evicted
 * least-recently-used via `pageImageCache`'s own iteration order (a `Map`
 * iterates in insertion order, so `cacheGet` re-inserts on a hit to move an
 * entry to the "most recent" end, and `cacheSet` evicts from the "oldest"
 * end — `.keys().next().value` — once the cap is exceeded).
 *
 * Capped at `PAGE_IMAGE_CACHE_MAX_DOCUMENTS` documents (not bytes): a
 * reviewer works through one matter's documents at a time, and a matter
 * rarely has more than a handful of scans in flight in a single sitting —
 * ten is generous headroom for that real usage pattern while still bounding
 * the worst case (many separate matters' scans reviewed back to back in one
 * long session) to a fixed, small number of documents' worth of images
 * rather than letting it climb indefinitely.
 */
export const PAGE_IMAGE_CACHE_MAX_DOCUMENTS = 10;
const pageImageCache = new Map<string, PageImages>();

function cachedPageImages(documentId: string): PageImages | undefined {
  const hit = pageImageCache.get(documentId);
  if (hit) {
    // Move to the most-recently-used end so eviction below takes the
    // actual least-recently-used entry, not just the least-recently-added.
    pageImageCache.delete(documentId);
    pageImageCache.set(documentId, hit);
  }
  return hit;
}

function setCachedPageImages(documentId: string, images: PageImages): void {
  pageImageCache.delete(documentId);
  pageImageCache.set(documentId, images);
  if (pageImageCache.size > PAGE_IMAGE_CACHE_MAX_DOCUMENTS) {
    const oldest = pageImageCache.keys().next().value;
    if (oldest !== undefined) pageImageCache.delete(oldest);
  }
}

/**
 * Removes one document's regenerated page images from the session cache —
 * for a caller to invoke once a document is deleted from its matter
 * (`deleteDocument`), so a removed document's images don't linger in memory
 * for the rest of the session with nothing left that can ever request them
 * again. Exported rather than wired in here: the call site is
 * `handleRemoveMatterDocument` in `App.tsx`, which another change is
 * currently editing — safe to call any time, including for a document id
 * that was never cached (a no-op `Map.delete` on a missing key).
 */
export function evictPageImages(documentId: string): void {
  pageImageCache.delete(documentId);
}

/** Rebuilds a `DocumentFile` for VIEWING a persisted document: wraps the
 *  stored blob back into a `File` and reuses the text already extracted at
 *  ingest time, without re-parsing. No re-parse is needed here because the
 *  viewer (`DocumentViewer`/`PdfCanvas`) renders straight from `file` and
 *  never touches `pageImages` — that field only matters when *running* a
 *  new review over the document (see `documentFileForReview` below).
 *
 *  `blob === null` (the document's bytes could not be found — see
 *  `getDocumentBlob`) degrades to a viewer-less placeholder rather than
 *  throwing: the document's metadata (name, kind, extracted text) is still
 *  real and still shown, only the original file is unavailable. */
export function documentFileForViewing(record: DocumentRecord, blob: Blob | null): DocumentFile {
  return {
    id: record.id,
    name: record.name,
    text: record.text,
    file: blob ? new File([blob], record.name, { type: blob.type }) : new File([], record.name),
    kind: record.kind,
    parseError: record.parseError ?? (blob ? undefined : BLOB_UNAVAILABLE_MESSAGE),
  };
}

/** Rebuilds a `DocumentFile` for RUNNING a new review over a persisted
 *  document. Unlike `documentFileForViewing`, this re-derives `pageImages`
 *  from the restored file through `parseFile` — but ONLY when the document
 *  actually needs them (`documentNeedsPageImages`: a PDF with at least one
 *  page below `SCAN_TEXT_THRESHOLD`) and doesn't already have a
 *  session-cached copy (`pageImageCache`). A document with a healthy text
 *  layer throughout is returned with its persisted text untouched — no
 *  re-parse at all — exactly like `documentFileForViewing`, since
 *  re-running pdfjs over the whole file to regenerate images nothing needs
 *  would be the very cost this design (page images are never persisted,
 *  only regenerated on demand "by the same code that produced them at
 *  ingest") exists to cut.
 *
 *  A document already marked `parseError` at ingest is not re-parsed —
 *  re-running a parse that failed once is unlikely to succeed differently
 *  and would discard the original error message — its record is carried
 *  through as-is instead. A missing blob (`blob === null`) degrades the
 *  same way `documentFileForViewing` does, rather than throwing: the
 *  document simply cannot be reviewed until its file is re-added, but the
 *  rest of the run is not blocked by it.
 *
 *  If regeneration *is* attempted and fails (`parseFile` catches internally
 *  and reports it as `parseError`), that failure is returned as-is rather
 *  than silently falling back to "no images needed" — a caller checking
 *  `pageImages` alone cannot tell an unreadable scan from a document that
 *  never needed images, so it must check `parseError` too. */
export async function documentFileForReview(record: DocumentRecord, blob: Blob | null): Promise<DocumentFile> {
  if (!blob) {
    return {
      id: record.id,
      name: record.name,
      text: record.text,
      file: new File([], record.name),
      kind: record.kind,
      parseError: record.parseError ?? BLOB_UNAVAILABLE_MESSAGE,
    };
  }
  const file = new File([blob], record.name, { type: blob.type });
  if (record.parseError) {
    return { id: record.id, name: record.name, text: record.text, file, kind: record.kind, parseError: record.parseError };
  }

  if (!documentNeedsPageImages(record)) {
    return { id: record.id, name: record.name, text: record.text, file, kind: record.kind };
  }

  const cached = cachedPageImages(record.id);
  if (cached) {
    return {
      id: record.id,
      name: record.name,
      text: record.text,
      file,
      kind: record.kind,
      pageImages: cached.length ? cached : undefined,
    };
  }

  const reparsed = await parseFile(file);
  // Cache only a successful regeneration. A failed one (parseError set)
  // is left uncached deliberately: it's surfaced to the caller below like
  // any other unreadable document rather than remembered as a permanent
  // "this document has no images" verdict, in case the failure was
  // transient (e.g. a corrupt-looking read that succeeds on a retry).
  if (!reparsed.parseError) {
    setCachedPageImages(record.id, reparsed.pageImages ?? []);
  }
  // parseFile mints its own fresh id (it has no notion of a persisted
  // document); overridden here so the returned DocumentFile keeps the
  // DocumentRecord's real id — the id a review's `documentIds` and
  // `findings` map must key against for this document.
  return { ...reparsed, id: record.id, name: record.name };
}

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
