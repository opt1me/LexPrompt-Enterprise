import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PageViewport, RenderTask } from 'pdfjs-dist';
import { ZoomIn, ZoomOut, ScanSearch, SearchX } from 'lucide-react';
import { extractPageText, loadPdfjs, readArrayBuffer } from '../../lib/documents';
import { findQuoteRects, hasNoTextLayer, type PdfPageText, type QuoteRect } from '../../lib/citations';
import { debug } from '../../lib/debug';

interface PdfCanvasProps {
  file: File;
  highlights: string[];
}

interface PdfPageProps {
  pdfDoc: PDFDocumentProxy;
  pageNum: number;
  scale: number;
  highlightRects: QuoteRect[];
}

/** One rendered page plus its highlight overlay. Ported from
 *  `components/PDFViewer.tsx` (deleted; see git history at 2b77c31),
 *  updated for the pdfjs-dist v6 render() signature. */
function PdfPage({ pdfDoc, pageNum, scale, highlightRects }: PdfPageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: RenderTask | null = null;

    pdfDoc.getPage(pageNum).then(async page => {
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      setViewport(vp);
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      // v6's RenderParameters takes `canvas` directly; `canvasContext` is
      // kept only for backwards compatibility (see src/lib/documents.ts).
      const task = page.render({ canvas, viewport: vp });
      renderTask = task;
      try {
        await task.promise;
      } catch (error) {
        // pdf.js rejects the in-flight render's promise with a
        // RenderingCancelledException when `.cancel()` below fires (rapid
        // zoom clicks each trigger a new render before the previous one
        // finishes). That is expected and silent; only a genuine render
        // failure is worth logging.
        if (!cancelled) debug('PdfPage render failed', pageNum, error);
      }
    });

    return () => {
      cancelled = true;
      // Without this, a second render (triggered by a scale/page change
      // before the first finished) ran concurrently against the same
      // canvas — pdf.js throws "Cannot use the same canvas during multiple
      // render() operations", which was being swallowed into `debug()`
      // above and left the canvas blank with no visible error. Cancelling
      // the superseded task here means only the current one ever touches
      // the canvas.
      renderTask?.cancel();
    };
  }, [pdfDoc, pageNum, scale]);

  // Scroll this page's first highlight into view whenever the set of
  // highlights landing on this page changes (PDFViewer.tsx:33-37).
  useEffect(() => {
    if (highlightRects.length > 0 && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightRects]);

  return (
    <div className="relative shadow-page mb-4" style={{ width: viewport?.width, height: viewport?.height }}>
      <canvas ref={canvasRef} className="bg-page rounded-inset" />
      {viewport && highlightRects.map((rect, i) => {
        // pdfjs-dist v6 dropped PageViewport.convertToViewportRectangle;
        // it was defined as exactly these two convertToViewportPoint calls,
        // so this reproduces it rather than reimplementing the transform.
        const topLeft = viewport.convertToViewportPoint(rect.x, rect.y);
        const bottomRight = viewport.convertToViewportPoint(rect.x + rect.w, rect.y + rect.h);
        const viewRect = [topLeft[0], topLeft[1], bottomRight[0], bottomRight[1]];
        return (
          <div
            key={i}
            ref={i === 0 ? highlightRef : null}
            style={{
              position: 'absolute',
              // pdf.js reports a text item's origin at its baseline, not its
              // top, so the box is pulled up by one glyph-height and made
              // 1.4x tall to actually cover the glyphs above the baseline.
              left: viewRect[0],
              top: viewRect[1] - rect.h * scale,
              width: viewRect[2] - viewRect[0],
              height: rect.h * scale * 1.4,
              backgroundColor: 'var(--color-highlight-fill)',
              borderBottom: '2px solid var(--color-highlight-edge)',
              mixBlendMode: 'multiply',
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </div>
  );
}

/** Renders a PDF, one canvas per page, with citation quotes highlighted.
 *  Loaded lazily by DocumentViewer so pdfjs-dist stays out of the main bundle. */
export function PdfCanvas({ file, highlights }: PdfCanvasProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pageTexts, setPageTexts] = useState<PdfPageText[]>([]);
  const [scale, setScale] = useState(1.2);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPdfDoc(null);
    setPageTexts([]);
    setError(null);

    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        // v6's getDocument() takes { data } rather than a bare ArrayBuffer.
        const doc = await pdfjs.getDocument({ data: await readArrayBuffer(file) }).promise;
        if (cancelled) return;
        setPdfDoc(doc);

        const texts = await extractPageText(doc);
        if (cancelled) return;
        setPageTexts(texts);
      } catch (e) {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        debug('PdfCanvas failed to load PDF', message);
        setError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  const rects = useMemo(
    () => (pageTexts.length > 0 && highlights.length > 0 ? findQuoteRects(pageTexts, highlights) : []),
    [pageTexts, highlights],
  );

  // A scan with no OCR text layer renders and extracts fine (the page image
  // fallback elsewhere handles that), but `findQuoteRects` can never locate
  // a citation in it — clicking a "Ref N" button would otherwise do nothing
  // at all, with no way for the user to tell why. Computed once pageTexts
  // has actually loaded, not before, so a normal PDF never flashes it.
  const noTextLayer = pageTexts.length > 0 && hasNoTextLayer(pageTexts);

  // Document-wide `noTextLayer` misses a real case: a mixed document (a
  // typed cover page plus scanned signature pages) has plenty of text
  // overall, so the banner above stays silent, yet a citation that happens
  // to land on a scanned page still can't be found. Attaching the feedback
  // to the actual failed lookup instead of to a document-wide proxy also
  // catches a third case neither `noTextLayer` nor a per-page threshold
  // would: an ordinary text PDF where the model's quote doesn't match
  // exactly (paraphrased, or the text layer split oddly). This is a plain
  // derived value, not accumulated state, so a later successful click
  // clears it automatically (`rects` becomes non-empty) and clicking the
  // same failing citation twice can't stack duplicate messages — there's
  // only ever the one condition, recomputed each render.
  const citationNotFound = highlights.length > 0 && pageTexts.length > 0 && rects.length === 0;

  if (error) {
    return (
      <div className="h-full flex items-center justify-center bg-doc-gutter font-ui text-ui-sm text-risk-high p-8 text-center">
        Could not open PDF: {error}
      </div>
    );
  }

  if (!pdfDoc) {
    return (
      <div className="h-full flex items-center justify-center bg-doc-gutter font-ui text-ui-sm text-ink-4">
        Loading PDF…
      </div>
    );
  }

  const pageNumbers = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);

  return (
    <div className="h-full w-full relative bg-doc-gutter overflow-auto flex flex-col items-center p-8">
      <div className="sticky top-4 z-50 flex items-center gap-2 bg-card border border-rule shadow-tab px-4 py-2 rounded-full mb-6">
        <button
          onClick={() => setScale(s => Math.max(0.5, s - 0.2))}
          className="text-ink-4 hover:text-ink-1 hover:bg-chip-fill p-1 rounded-control"
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="font-ui text-ui-sm text-ink-3 w-12 text-center pt-1">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale(s => Math.min(3, s + 0.2))}
          className="text-ink-4 hover:text-ink-1 hover:bg-chip-fill p-1 rounded-control"
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>
      {/* risk-med here, matching DocumentViewer's MarkupNotice — a document-wide
          caveat about what the app can vouch for, not yet a failed lookup.
          citationNotFound below is risk-high: a specific citation that could
          not be placed. Different ink so the two are never confused with
          each other (R-G19). */}
      {noTextLayer && (
        <div className="sticky top-[4.5rem] z-40 flex items-center gap-2 bg-risk-med-tint border border-risk-med-edge text-risk-med font-ui text-ui-sm px-4 py-2 rounded-panel mb-6 max-w-md text-center shadow-tab">
          <ScanSearch className="w-4 h-4 shrink-0" />
          <span>This document is a scan with no searchable text, so citations can&apos;t be located in it.</span>
        </div>
      )}
      {citationNotFound && (
        <div
          className={`sticky z-40 flex items-center gap-2 bg-risk-high-tint border border-risk-high-edge text-risk-high font-ui text-ui-sm px-4 py-2 rounded-panel mb-6 max-w-md text-center shadow-tab ${noTextLayer ? 'top-[8rem]' : 'top-[4.5rem]'}`}
        >
          <SearchX className="w-4 h-4 shrink-0" />
          <span>
            Couldn&apos;t locate this quote in the document. The page may be a scan with no searchable text, or the
            wording may not match exactly.
          </span>
        </div>
      )}
      {pageNumbers.map(p => (
        <PdfPage
          key={p}
          pdfDoc={pdfDoc}
          pageNum={p}
          scale={scale}
          highlightRects={rects.filter(r => r.pageNum === p)}
        />
      ))}
    </div>
  );
}

export default PdfCanvas;
