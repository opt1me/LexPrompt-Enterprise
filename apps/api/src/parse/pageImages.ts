/**
 * Spike 1 (§15, §19): can this server render a PDF page to an image?
 *
 * The answer is yes, and this file is the worked example. See
 * `.superpowers/sdd/2026-08-30-lexprompt-server-stage-3-engine/spike-1-report.md`
 * for the timing it was answered with.
 *
 * WHY THE ANSWER MATTERS MORE THAN THE CODE. This project's founding defect
 * is a scanned PDF reviewed by a text-only model returning "the agreement is
 * silent on this point" for every clause. The browser avoids it by rendering
 * each sparse page to an image and handing the images to a vision model
 * (`src/lib/documents.ts`'s `renderPageToJpeg`). Moving the engine
 * server-side without this function would have moved the review away from
 * the only thing that reads a scan.
 *
 * NOTHING HERE IS EVER PERSISTED. Page images are derived data — roughly a
 * third larger, base64, than the bytes they came from — regenerated on
 * demand and never written to Postgres or to the blob store. That is a
 * promise the README makes, and `pageImages.compose.test.ts` scans this file
 * to keep it true. The original file's bytes come IN; base64 images go OUT;
 * this module holds no store, no pool and no cache.
 */

/**
 * The SAME shape `DocumentFile.pageImages` and `InferRequest.images` already
 * use — not a bare `string[]`.
 *
 * The mime type travels WITH the data deliberately. A caller handed bare
 * base64 has to decide what to call it, and the two sides would then be free
 * to disagree: a PNG announced to a provider as `image/jpeg` is a request a
 * model may simply refuse, and it would refuse it for a scanned document,
 * which is the one case that cannot fall back to text.
 */
export interface PageImage {
  mime: string;
  data: string;
}

export interface RenderPageImagesOptions {
  /** Hard ceiling on pages rendered in one call. Exceeding it is reported
   *  through `renderedPages` < `totalPages`, never silently absorbed. */
  maxPages: number;
  /** Wall-clock budget for the whole document. Exceeding it THROWS — see
   *  `PageRenderTimeoutError`. */
  timeoutMs: number;
  /**
   * 1-based page numbers to render, or every page when omitted.
   *
   * This module deliberately does NOT decide which pages are scans.
   * `SCAN_TEXT_THRESHOLD` is applied per page in exactly one place
   * (`src/lib/documents.ts`, and its server successor); a second copy of
   * that rule here is the blind spot CLAUDE.md records having had to fix
   * three times. The caller that already extracted the per-page text names
   * the pages; this function renders them.
   */
  pages?: number[];
}

export interface RenderPageImagesResult {
  images: PageImage[];
  /** How many pages were actually rendered. */
  renderedPages: number;
  /** How many pages the document has. A caller MUST compare the two: a
   *  `renderedPages` short of the pages it asked for is a partially-read
   *  document, and reporting it as a whole one is this app's founding
   *  defect wearing a different hat. */
  totalPages: number;
}

/**
 * The render did not finish inside its budget.
 *
 * Thrown, never returned as a partial result. A half-rendered scan handed to
 * a model produces a fluent, confident answer about the half it could read
 * and "silent on this point" about the half it could not — the worst
 * available failure, because it is indistinguishable from a real finding.
 * The caller turns this into a `parseError` the reviewer can act on.
 */
export class PageRenderTimeoutError extends Error {
  // Plain fields assigned in the body, NOT constructor parameter
  // properties. `apps/api` runs under `node --experimental-strip-types`,
  // which is strip-only: a parameter property is not a type annotation it
  // can erase, and the whole module fails to load with
  // ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — at import time, in the container,
  // where `npx tsc` had nothing to say about it.
  readonly renderedPages: number;
  readonly totalPages: number;

  constructor(renderedPages: number, totalPages: number, timeoutMs: number) {
    super(
      `Rendering this document's pages took longer than ${timeoutMs}ms; ${renderedPages} of `
      + `${totalPages} page(s) were rendered before the budget ran out. The document has not been `
      + 'reviewed — a partly-rendered scan would be read as though the missing pages were blank.',
    );
    this.name = 'PageRenderTimeoutError';
    this.renderedPages = renderedPages;
    this.totalPages = totalPages;
  }
}

/**
 * `pdfjs-dist/legacy/build/pdf.mjs`, and the path is not interchangeable
 * with the bare specifier.
 *
 * `import('pdfjs-dist')` and `pdfjs-dist/build/pdf.mjs` both throw
 * `DOMMatrix is not defined` under Node 22 — the modern build assumes a
 * browser's geometry globals — and pdf.js prints "Please use the `legacy`
 * build in Node.js environments" on the way past. Memoised because the
 * import costs ~110ms cold and a review renders many documents.
 */
type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;

function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as Promise<PdfjsModule>;
  return pdfjsPromise;
}

/**
 * Scale 2.0, JPEG, quality 0.8 — copied from `renderPageToJpeg` in
 * `src/lib/documents.ts` and NOT re-chosen.
 *
 * These three numbers decide what a model actually sees of a scanned page.
 * Picking different ones here would mean the same document reviewed in the
 * browser and reviewed on the server got different pictures and could
 * therefore reach different findings, with nothing on either card saying
 * why. When the browser's values change, change these in the same commit.
 */
const RENDER_SCALE = 2.0;
const JPEG_QUALITY = 0.8;
export const PAGE_IMAGE_MIME = 'image/jpeg';

export async function renderPageImages(
  bytes: Uint8Array,
  opts: RenderPageImagesOptions,
): Promise<RenderPageImagesResult> {
  const pdfjs = await loadPdfjs();
  const { createCanvas } = await import('@napi-rs/canvas');

  // NO `isEvalSupported: false`, and that is not an omission. pdf.js used
  // to JIT font programs and PostScript functions through `eval`, and that
  // flag turned it off; v6 removed the mechanism entirely — the option is
  // gone from `DocumentInitParameters` and there is not one `new Function(`
  // left in `pdf.worker.mjs`. Passing it anyway typechecked as an error and
  // did nothing at runtime, which is worse than not passing it: a comment
  // claiming a protection that is not happening is how a real one gets
  // removed later by someone who believes it is still there.
  //
  // The LOADING TASK is kept, not discarded: in pdf.js v6 `destroy()` lives
  // on the task, and the document proxy `.promise` resolves to has only
  // `cleanup()`. `doc.destroy()` is not a function, and calling it throws at
  // the end of a render that had otherwise just succeeded.
  //
  // `data` is a COPY, and that is not defensive tidiness. pdf.js TRANSFERS
  // the buffer it is handed to its worker port, which DETACHES the caller's
  // `Uint8Array`: every later read of it sees length 0, and handing the same
  // array to a second `getDocument` dies with `DataCloneError: Cannot
  // transfer object of unsupported type`. The caller here is a parse worker
  // that has just read the same document's text out of the same bytes, so
  // that second call is the normal case, not an unusual one — and a
  // document whose bytes silently became empty between two reads is this
  // app's founding defect with no error attached to it.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
  const doc = await task.promise;
  const deadline = Date.now() + opts.timeoutMs;

  try {
    const totalPages = doc.numPages;
    const wanted = (opts.pages ?? Array.from({ length: totalPages }, (_, i) => i + 1))
      .filter(n => n >= 1 && n <= totalPages)
      .slice(0, opts.maxPages);

    const images: PageImage[] = [];
    for (const pageNumber of wanted) {
      if (Date.now() > deadline) {
        throw new PageRenderTimeoutError(images.length, totalPages, opts.timeoutMs);
      }
      const page = await doc.getPage(pageNumber);
      try {
        const viewport = page.getViewport({ scale: RENDER_SCALE });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        // A canvas with no 2D backend must fail here, before render() is
        // handed something it will draw nothing onto — a blank page is a
        // valid image and would be reviewed as an empty one.
        if (!canvas.getContext('2d')) {
          throw new Error(`No 2D canvas backend is available to render page ${pageNumber}.`);
        }
        // Cast, not coerced: `@napi-rs/canvas`'s `Canvas` implements the
        // surface pdf.js draws through, but the .d.ts names the DOM's
        // `HTMLCanvasElement`, and `apps/api`'s tsconfig has no DOM lib at
        // all (`lib: ["ES2022"]`) — so the name does not even resolve here.
        await page.render({ canvas, viewport } as unknown as Parameters<typeof page.render>[0]).promise;
        images.push({
          mime: PAGE_IMAGE_MIME,
          data: canvas.toDataURL(PAGE_IMAGE_MIME, JPEG_QUALITY).split(',')[1],
        });
      } finally {
        page.cleanup();
      }
    }

    return { images, renderedPages: images.length, totalPages };
  } finally {
    // Frees the worker and the parsed document. Without it a long-running
    // process accumulates one parsed PDF per review, which is the largest
    // object this service touches.
    await task.destroy();
  }
}
