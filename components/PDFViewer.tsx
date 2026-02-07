import React, { useEffect, useRef, useState, useMemo } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';

interface PDFViewerProps {
  file: File | null;
  highlights: string[];
  initialScale?: number;
}

const strictNormalize = (text: string) => text.replace(/[^a-z0-9]/gi, '').toLowerCase();

const PDFPage: React.FC<{ pdfDoc: any; pageNum: number; scale: number; highlightRects: any[] }> = ({ pdfDoc, pageNum, scale, highlightRects }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const highlightRef = useRef<HTMLDivElement>(null);
    const [viewport, setViewport] = useState<any>(null);

    useEffect(() => {
        if (!pdfDoc || !canvasRef.current) return;
        
        pdfDoc.getPage(pageNum).then((page: any) => {
            const vp = page.getViewport({ scale });
            setViewport(vp);
            const canvas = canvasRef.current;
            if (canvas) {
                const context = canvas.getContext('2d');
                canvas.height = vp.height;
                canvas.width = vp.width;
                page.render({ canvasContext: context, viewport: vp });
            }
        });
    }, [pdfDoc, pageNum, scale]);

    useEffect(() => {
        if (highlightRects.length > 0 && highlightRef.current) {
            highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [highlightRects]);

    return (
        <div className="relative shadow-lg mb-4" style={{ width: viewport?.width, height: viewport?.height }}>
            <canvas ref={canvasRef} className="bg-white rounded" />
            {viewport && highlightRects.map((rect, i) => {
                // Approximate highlighting
                const pdfRect = [rect.x, rect.y, rect.x + rect.w, rect.y + rect.h];
                const viewRect = viewport.convertToViewportRectangle(pdfRect);
                return (
                    <div 
                        key={i} 
                        ref={i === 0 ? highlightRef : null}
                        style={{
                            left: viewRect[0],
                            top: viewRect[1] - (rect.h * scale),
                            width: viewRect[2] - viewRect[0],
                            height: rect.h * scale * 1.4,
                            position: 'absolute',
                            backgroundColor: 'rgba(255, 235, 59, 0.35)',
                            borderBottom: '2px solid rgba(255, 193, 7, 0.8)',
                            mixBlendMode: 'multiply',
                            pointerEvents: 'none'
                        }} 
                    />
                );
            })}
        </div>
    );
};

export const PDFViewer: React.FC<PDFViewerProps> = ({ file, highlights, initialScale = 1.2 }) => {
    const [pdfDoc, setPdfDoc] = useState<any>(null);
    const [pages, setPages] = useState<number[]>([]);
    const [scale, setScale] = useState(initialScale);
    const [pdfSearchIndex, setPdfSearchIndex] = useState<any[]>([]);

    useEffect(() => {
        if (!file) return;
        const loadPdf = async () => {
            try {
                // @ts-ignore
                const pdfjsLib = window['pdfjs-dist/build/pdf'];
                const doc = await pdfjsLib.getDocument(await file.arrayBuffer()).promise;
                setPdfDoc(doc);
                setPages(Array.from({ length: doc.numPages }, (_, i) => i + 1));
                
                // Build search index exactly as original
                const index = [];
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    const textContent = await page.getTextContent();
                    index.push({ pageNum: i, items: textContent.items });
                }
                setPdfSearchIndex(index);
            } catch (e) { console.error(e); }
        };
        loadPdf();
    }, [file]);

    const activeRects = useMemo(() => {
        if (!pdfSearchIndex.length || !highlights.length) return [];
        const rects: any[] = [];
        
        highlights.forEach(quote => {
            if (!quote) return;
            const searchStr = strictNormalize(quote);
            if(searchStr.length < 5) return; // Ignore very short matches

            pdfSearchIndex.forEach(({ pageNum, items }) => {
                // Robust logic from original algorithm
                let pageStr = "";
                const charToItemIndex: number[] = []; 
                
                items.forEach((item: any, itemIdx: number) => { 
                    const clean = strictNormalize(item.str); 
                    if (clean.length > 0) { 
                        for(let c = 0; c < clean.length; c++) charToItemIndex.push(itemIdx); 
                        pageStr += clean; 
                    } 
                });
                
                let startIndex = 0;
                while (true) {
                    const matchIndex = pageStr.indexOf(searchStr, startIndex);
                    if (matchIndex === -1) break;
                    
                    const endMatchIndex = matchIndex + searchStr.length - 1;
                    const startItemIdx = charToItemIndex[matchIndex];
                    const endItemIdx = charToItemIndex[endMatchIndex];
                    
                    if (startItemIdx !== undefined && endItemIdx !== undefined) {
                         const relevantItems = items.slice(startItemIdx, endItemIdx + 1);
                         relevantItems.forEach((item: any) => { 
                             if(item.str.trim().length === 0) return; 
                             rects.push({ 
                                 pageNum, 
                                 x: item.transform[4], 
                                 y: item.transform[5], 
                                 w: item.width, 
                                 h: item.height || 12 
                            }); 
                        });
                    }
                    startIndex = matchIndex + 1;
                }
            });
        });
        return rects;
    }, [pdfSearchIndex, highlights]);

    if (!file) return <div className="h-full flex items-center justify-center text-gray-500">No Document Loaded</div>;

    return (
        <div className="h-full w-full relative bg-slate-800 overflow-auto flex flex-col items-center p-8">
            <div className="sticky top-4 z-50 flex gap-2 bg-black/60 backdrop-blur px-4 py-2 rounded-full mb-6 shadow-xl border border-white/10">
                <button onClick={() => setScale(s => Math.max(0.5, s - 0.2))} className="text-white hover:text-violet-400 p-1"><ZoomOut className="w-4 h-4" /></button>
                <span className="text-xs text-gray-300 w-12 text-center pt-1">{Math.round(scale * 100)}%</span>
                <button onClick={() => setScale(s => Math.min(3, s + 0.2))} className="text-white hover:text-violet-400 p-1"><ZoomIn className="w-4 h-4" /></button>
            </div>
            {pages.map(p => (
                <PDFPage key={p} pdfDoc={pdfDoc} pageNum={p} scale={scale} highlightRects={activeRects.filter(r => r.pageNum === p)} />
            ))}
        </div>
    );
};