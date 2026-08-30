import {
  couldNotBeReadMessageFor, failedToRead, isNotYetRead, notYetReadMessage, type DocumentFile,
} from '@lexprompt/core';
import type { DocumentRecord } from '../db/rows.ts';
import { sparsePagesOf } from './parseDocument.ts';
import {
  PageRenderAbortedError, PageRenderTimeoutError, renderPageImages, type PageImage,
} from './pageImages.ts';

/**
 * The two hydrations, server-side — and THE HYDRATION MODE MATTERS AS MUCH
 * AS THE TYPE.
 *
 * `documentFileForViewing` carries no page images. That is correct for a
 * viewer, which renders the PDF itself and needs none.
 * `documentFileForReview` regenerates them for a document whose pages fall
 * below `SCAN_TEXT_THRESHOLD`, and caches them in a byte-bounded in-process
 * LRU for the life of the run.
 *
 * Handing a view-hydrated — or raw-record — document to an extractor reviews
 * a scanned document as though it said nothing. **That is this project's
 * FOUNDING DEFECT**, and it has reopened twice already: once one level up (a
 * collection of records) and once one level sideways (a retry on a reopened
 * review, extracting from `openReview`'s view-hydrated documents). The run
 * worker hydrates FOR REVIEW, and `hydrate.pg.test.ts` is what keeps that
 * true when this file is next refactored.
 *
 * ## Page images are never persisted
 *
 * Nothing here writes to Postgres or to the blob store. Original file bytes
 * come IN; base64 images are held in memory, bounded, and dropped when the
 * run that needed them ends. A page image is roughly a third larger than the
 * bytes it was rendered from, and the README's promise that they are derived
 * data has to be true of the implementation, not only of the copy.
 */

export type PageImages = PageImage[];

/**
 * The cache, bounded by BYTES rather than by document count.
 *
 * The browser bounds its own by count (`PAGE_IMAGE_CACHE_MAX_DOCUMENTS =
 * 10`), which is right for one person's tab and wrong for a shared process:
 * ten documents is a few megabytes of three-page contracts and gigabytes of
 * hundred-page scans. The difference from the browser's rule is deliberate
 * and is the reason this is not simply the browser's `Map`.
 *
 * A `Map` iterates in insertion order, so a hit re-inserts to move an entry
 * to the most-recent end and eviction takes from the oldest.
 */
export interface PageImageCache {
  get(documentId: string): PageImages | undefined;
  set(documentId: string, images: PageImages): void;
  evict(documentId: string): void;
  /** How many bytes are held. Read by the test that proves the bound bites,
   *  which otherwise could only prove the cache exists. */
  bytes(): number;
  size(): number;
}

function sizeOf(images: PageImages): number {
  return images.reduce((n, image) => n + image.data.length, 0);
}

export function makePageImageCache(maxBytes: number): PageImageCache {
  const entries = new Map<string, PageImages>();
  let held = 0;

  const drop = (documentId: string): void => {
    const existing = entries.get(documentId);
    if (existing === undefined) return;
    held -= sizeOf(existing);
    entries.delete(documentId);
  };

  return {
    get(documentId) {
      const hit = entries.get(documentId);
      if (hit === undefined) return undefined;
      entries.delete(documentId);
      entries.set(documentId, hit);
      return hit;
    },
    set(documentId, images) {
      drop(documentId);
      // An entry larger than the whole budget is NOT cached, and is not an
      // error either: the caller already has the images it needs for this
      // cell, and admitting it would evict everything else to hold one
      // document that will itself be evicted by the next.
      const bytes = sizeOf(images);
      if (bytes > maxBytes) return;
      entries.set(documentId, images);
      held += bytes;
      while (held > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },
    evict: drop,
    bytes: () => held,
    size: () => entries.size,
  };
}

export interface HydrationDeps {
  cache: PageImageCache;
  /** `API_PAGE_RENDER_TIMEOUT_MS` — a HARD budget. Exceeding it throws, and
   *  this module turns that into a `parseError` rather than returning a
   *  half-rendered scan. */
  pageRenderTimeoutMs: number;
  /** `API_PAGE_IMAGE_MAX_PAGES` — a SOFT cap, reported as
   *  `renderedPages < totalPages` and named in the refusal below. */
  pageImageMaxPages: number;
  /** `API_RUN_IMAGE_BYTES_MAX` — the wire ceiling. See `config.ts` for why
   *  exceeding it is a refusal rather than a batch. */
  runImageBytesMax: number;
  /**
   * The cell's abort, passed straight to the renderer.
   *
   * `runOneStep`'s `AbortController` is the only enforcement of
   * `API_RUN_CELL_TIMEOUT_MS` and the only thing a cancel can reach. It used
   * to stop at the model call, and hydration happens BEFORE that call, in
   * the same `await` — so the timeout fired into nothing while a page render
   * held the slot. Optional, because the parse worker and the viewer paths
   * have no cell to be cancelled with.
   */
  signal?: AbortSignal;
}

export const BLOB_UNAVAILABLE_MESSAGE =
  'The original file for this document is no longer available.';

function fileFor(record: DocumentRecord, bytes: Buffer | null, mime: string): File {
  // The extractors never read `doc.file` — they read `text`, `pageImages`,
  // `name`, `id` and `parseError`. It is on `DocumentFile` for the browser's
  // viewer, and is populated faithfully here rather than left undefined so
  // the server's hydration produces the same SHAPE the browser's does.
  return bytes
    ? new File([bytes], record.name, { type: mime })
    : new File([], record.name);
}

/**
 * For the VIEWER. No page images, deliberately — see the module note.
 *
 * A missing blob degrades to a placeholder rather than throwing: the
 * document's metadata and extracted text are still real and still shown,
 * and only the original file is unavailable (§9).
 *
 * A record the parse worker has not reached yet (`parseState: 'pending'`)
 * carries `text: ''` and NO `parseError`, so before this branch existed it
 * came back cleanly as a document that says nothing. `routes/runs.ts` knew
 * the difference and guarded one entry point; every other reader — this one
 * included — did not. The sentence is `@lexprompt/core`'s, shared with the
 * browser's two hydrations and with the run route's refusal.
 */
export function documentFileForViewing(
  record: DocumentRecord, bytes: Buffer | null, mime: string,
): DocumentFile {
  return {
    id: record.id,
    name: record.name,
    text: record.text,
    file: fileFor(record, bytes, mime),
    kind: record.kind,
    parseError: isNotYetRead(record)
      ? notYetReadMessage(record.name)
      : (record.parseError ?? (bytes ? undefined : BLOB_UNAVAILABLE_MESSAGE)),
    ...(record.markupNotice ? { markupNotice: record.markupNotice } : {}),
  };
}

/**
 * For the ENGINE. Regenerates page images for a scan, and only for a scan.
 *
 * `readBytes` is a THUNK, not a `Buffer`. See the long note inside: the bytes
 * are pulled out of Blob Storage only for a document whose pages fall below
 * `SCAN_TEXT_THRESHOLD`, which is the only case that needs them — a
 * forty-cell run over three documents would otherwise fetch every file a
 * hundred and twenty times.
 *
 * Every failure comes back as `parseError` rather than as a throw, because
 * `extractClause` reads `parseError` first and answers *"Could not read
 * X: …"* — a sentence a reviewer can act on. A throw here would kill the
 * cell with a stack trace, and §9's whole shape is that one bad document
 * costs one cell.
 */
export async function documentFileForReview(
  record: DocumentRecord,
  readBytes: () => Promise<Buffer | null>,
  mime: string,
  deps: HydrationDeps,
): Promise<DocumentFile> {
  const base: DocumentFile = {
    id: record.id,
    name: record.name,
    text: record.text,
    // An empty placeholder unless the bytes are actually read below. The
    // extractors never touch `doc.file` — they read `text`, `pageImages`,
    // `name`, `id` and `parseError` — and `DocumentFile` requires the field
    // because the browser's viewer renders from it.
    file: new File([], record.name),
    kind: record.kind,
    ...(record.markupNotice ? { markupNotice: record.markupNotice } : {}),
  };

  // NOT YET READ comes first, and it is not a failure. A `pending` record
  // has `text: ''` and no `parseError`, so every check below it would pass
  // it through as a document that genuinely says nothing — and the
  // extractor would then answer "it may have failed to parse, or be a scan
  // with no extractable content" for a document nothing had read yet.
  if (isNotYetRead(record)) return { ...base, parseError: notYetReadMessage(record.name) };

  /*
   * A document already marked failed is not re-parsed: re-running a parse
   * that failed once is unlikely to succeed differently and would discard
   * the original message, which is the one thing the reviewer can act on.
   *
   * `failedToRead` AS WELL AS `parseError`, and the second half is the point
   * (final review m3). This branched on the MESSAGE alone, so a row with
   * `parse_state = 'failed'` and an empty `parse_error` fell through — past
   * the sparse-pages check, which is skipped for anything that is not a PDF
   * — and came back with `text: ''` and NO `parseError` at all. That is this
   * project's founding defect exactly: a document the extractor then reports
   * as *"the agreement is silent on this point"* for every clause, when what
   * actually happened is that nothing could read it.
   *
   * Not reachable today — `parseWorker.fail` always writes a message, and
   * `refuseUnparsedDocuments` blocks a `failed` document at run creation —
   * and that is why it is minor rather than live. But this module presents
   * itself as the last line before the engine, `failedToRead` exists in
   * `@lexprompt/core` for precisely this state and had no server-side reader
   * at all, and "not reachable today" is a property of two callers rather
   * than of this function.
   *
   * The message falls back to `couldNotBeReadMessageFor`, the same sentence
   * the run route's refusal uses, rather than to a new one written here.
   */
  if (record.parseError || failedToRead(record)) {
    return {
      ...base,
      parseError: record.parseError || couldNotBeReadMessageFor([record.name]),
    };
  }

  // PER PAGE. A document-wide text check lets one typed cover page carry a
  // scanned body over the bar; that blind spot has had to be fixed three
  // times, and this is the server's copy of the same rule, through the same
  // shared threshold.
  const sparse = record.kind === 'pdf' ? sparsePagesOf(record.text) : [];

  // THE BYTES ARE READ LAZILY, and only for a document that needs images.
  //
  // The browser reads its blob unconditionally because it already holds it;
  // this is a server, and a forty-cell run over three documents would
  // otherwise pull every document's bytes out of Blob Storage a hundred and
  // twenty times to produce nothing. It is also the honest rule: a document
  // whose text layer is healthy has everything an extractor reads, and
  // refusing to review it because its ORIGINAL FILE has gone missing would
  // withhold an answer this system can give perfectly well.
  //
  // A SCAN is the opposite case and the important one. Its text is not
  // enough by definition, so missing bytes there mean the pages cannot be
  // rendered and the document genuinely cannot be read — reported as a
  // `parseError`, never as a review of the sparse text it does have.
  if (sparse.length === 0) return base;

  const cached = deps.cache.get(record.id);
  if (cached) return withImages(base, cached, record, deps);

  let bytes: Buffer | null;
  try {
    bytes = await readBytes();
  } catch (error) {
    return {
      ...base,
      parseError: `LexPrompt could not reach the file store to read ${record.name} `
        + `(${error instanceof Error ? error.message : String(error)}). It is a scan, so its `
        + 'pages have to be rendered from the original file before a model can read them.',
    };
  }
  if (!bytes) {
    return {
      ...base,
      parseError: `${BLOB_UNAVAILABLE_MESSAGE} ${record.name} is a scan, so its pages have to be `
        + 'rendered from that file before a model can read them — the text on record is not '
        + 'enough, and reviewing it would report every clause as absent.',
    };
  }

  let rendered;
  try {
    rendered = await renderPageImages(bytes, {
      maxPages: deps.pageImageMaxPages,
      timeoutMs: deps.pageRenderTimeoutMs,
      pages: sparse,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (error) {
    // `PageRenderTimeoutError` already says how many pages of how many were
    // rendered and that the document has NOT been reviewed, and
    // `PageRenderAbortedError` says the cell that wanted them stopped.
    // Anything else gets its own message. Either way this is a `parseError`,
    // not silence.
    return {
      ...base,
      parseError: error instanceof PageRenderTimeoutError
        || error instanceof PageRenderAbortedError
        ? error.message
        : `The pages of ${record.name} could not be rendered for review `
          + `(${error instanceof Error ? error.message : String(error)}).`,
    };
  }

  // The SOFT cap, reported rather than absorbed. `renderedPages` short of
  // the pages we asked for is a partially-read document, and returning it as
  // a whole one is the founding defect wearing a successful return value.
  if (rendered.renderedPages < sparse.length) {
    return {
      ...base,
      parseError: `${record.name} needs an image of ${sparse.length} page(s) to be readable and `
        + `only ${rendered.renderedPages} could be rendered (the limit is `
        + `${deps.pageImageMaxPages}, set by API_PAGE_IMAGE_MAX_PAGES). Reviewing it with the `
        + 'rest missing would read as "the agreement is silent on this point" for everything '
        + 'those pages say.',
    };
  }

  deps.cache.set(record.id, rendered.images);
  return withImages(base, rendered.images, record, deps);
}

/**
 * The WIRE ceiling, applied last — Spike 1's finding that the real limit is
 * not the renderer.
 *
 * A 100-page scan is roughly 31 MB of base64, already over
 * `API_MAX_BODY_BYTES`. Refused by name here, before the call, rather than
 * sent as a partial set: a partly-sent scan reads to a model as a document
 * silent on everything the missing pages said. The refusal names the
 * document, its page count and the two keys an operator can move.
 */
function withImages(
  base: DocumentFile, images: PageImages, record: DocumentRecord, deps: HydrationDeps,
): DocumentFile {
  const bytes = sizeOf(images);
  if (bytes > deps.runImageBytesMax) {
    return { ...base, parseError: imageCeilingMessage(record.name, images.length, bytes, deps.runImageBytesMax) };
  }
  return { ...base, pageImages: images };
}

/**
 * The refusal itself, in ONE place, because the ceiling has to be applied at
 * TWO scales and the sentence must not be written twice.
 *
 * `config.ts` calls `runImageBytesMax` "the wire ceiling on **one clause's**
 * page images", but `withImages` runs once per DOCUMENT — and
 * `extractCollectionClause` builds its body from
 * `present.flatMap(p => p.document.pageImages ?? [])`. Three scanned members
 * at 70% of the budget each passed three per-document checks and sent 210%
 * of the ceiling, and what the operator then got was a raw 413 from nginx
 * or the gateway instead of the sentence this function exists to say. 413 is
 * loud — it is not retryable, so it lands as an error finding rather than
 * being retried forever — but a status code names neither the documents, nor
 * their page counts, nor the two keys to move.
 */
export function imageCeilingMessage(
  subject: string, pages: number, bytes: number, max: number,
): string {
  return `${subject} needs an image of ${pages} scanned page(s), about `
    + `${bytes} bytes — more than one model call may carry `
    + `(${max}, set by API_RUN_IMAGE_BYTES_MAX). LexPrompt will not send `
    + 'part of a scan: the pages left out would read back as clauses the document is silent '
    + 'on. Review it in smaller pieces, or ask an administrator to raise '
    + 'API_RUN_IMAGE_BYTES_MAX and API_MAX_BODY_BYTES together.';
}

/**
 * The CELL's total, across every member of a collection — the scale the
 * ceiling was documented at and had never been applied at.
 *
 * Returns the refusal, or `undefined` when the whole cell fits. A member
 * that already carries a `parseError` contributes no images and is not
 * counted: it is refused for its own reason and its pages are not in the
 * body.
 */
export function cellImagesRefusal(
  documents: (DocumentFile | null)[], runImageBytesMax: number,
): string | undefined {
  const withPages = documents.filter((d): d is DocumentFile => !!d && !d.parseError
    && (d.pageImages?.length ?? 0) > 0);
  if (withPages.length === 0) return undefined;
  const pages = withPages.reduce((n, d) => n + (d.pageImages?.length ?? 0), 0);
  const bytes = withPages.reduce(
    (n, d) => n + (d.pageImages ?? []).reduce((m, i) => m + i.data.length, 0), 0);
  if (bytes <= runImageBytesMax) return undefined;
  // Named by DOCUMENT, because "review it in smaller pieces" is only
  // actionable if the reader knows which pieces.
  return imageCeilingMessage(
    `This clause reads ${withPages.map(d => d.name).join(', ')} together, and between them it`,
    pages, bytes, runImageBytesMax);
}
