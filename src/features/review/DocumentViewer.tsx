import React, { Suspense } from 'react';
import type { DocumentFile } from '../../types';

// pdfjs-dist is heavy; lazy-loading PdfCanvas keeps it out of the initial
// bundle for the (common) case where the user never opens a PDF.
const PdfCanvas = React.lazy(() => import('./PdfCanvas'));

interface DocumentViewerProps {
  doc: DocumentFile | null;
  highlights: string[];
}

/** Dispatches on document kind: PDF gets the canvas renderer with citation
 *  highlighting, DOCX/TXT get a scrollable text pane, and a failed parse
 *  gets an error message instead of a blank viewer. */
export function DocumentViewer({ doc, highlights }: DocumentViewerProps) {
  if (!doc) {
    return <div className="h-full flex items-center justify-center text-gray-500">No document loaded</div>;
  }

  if (doc.parseError) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center text-gray-400 p-8 gap-2">
        <span className="text-white font-medium">{doc.name}</span>
        <span className="text-sm text-red-400">Could not read this file: {doc.parseError}</span>
      </div>
    );
  }

  if (doc.kind === 'pdf') {
    return (
      <Suspense
        fallback={<div className="h-full flex items-center justify-center text-gray-500 text-sm">Loading PDF…</div>}
      >
        <PdfCanvas file={doc.file} highlights={highlights} />
      </Suspense>
    );
  }

  return (
    <div className="p-8 whitespace-pre-wrap font-serif text-sm text-gray-300 max-w-3xl mx-auto overflow-y-auto h-full bg-[#1a1a1a] shadow-2xl my-4 rounded">
      {doc.text}
    </div>
  );
}

export default DocumentViewer;
