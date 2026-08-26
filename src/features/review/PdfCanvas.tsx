import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, PageViewport } from 'pdfjs-dist';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { extractPageText, readArrayBuffer } from '../../lib/documents';
import { findQuoteRects, type PdfPageText, type QuoteRect } from '../../lib/citations';
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
      try {
        await page.render({ canvas, viewport: vp }).promise;
      } catch (error) {
        debug('PdfPage render failed', pageNum, error);
      }
    });
    return () => {
      cancelled = true;
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
    <div className="relative shadow-lg mb-4" style={{ width: viewport?.width, height: viewport?.height }}>
      <canvas ref={canvasRef} className="bg-white rounded" />
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
              backgroundColor: 'rgba(255, 235, 59, 0.35)',
              borderBottom: '2px solid rgba(255, 193, 7, 0.8)',
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

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-red-400 text-sm p-8 text-center">
        Could not open PDF: {error}
      </div>
    );
  }

  if (!pdfDoc) {
    return <div className="h-full flex items-center justify-center text-gray-500 text-sm">Loading PDF…</div>;
  }

  const pageNumbers = Array.from({ length: pdfDoc.numPages }, (_, i) => i + 1);

  return (
    <div className="h-full w-full relative bg-slate-800 overflow-auto flex flex-col items-center p-8">
      <div className="sticky top-4 z-50 flex gap-2 bg-black/60 backdrop-blur px-4 py-2 rounded-full mb-6 shadow-xl border border-white/10">
        <button
          onClick={() => setScale(s => Math.max(0.5, s - 0.2))}
          className="text-white hover:text-violet-400 p-1"
          aria-label="Zoom out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="text-xs text-gray-300 w-12 text-center pt-1">{Math.round(scale * 100)}%</span>
        <button
          onClick={() => setScale(s => Math.min(3, s + 0.2))}
          className="text-white hover:text-violet-400 p-1"
          aria-label="Zoom in"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
      </div>
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
