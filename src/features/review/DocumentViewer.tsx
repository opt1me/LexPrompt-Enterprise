import React, { Suspense } from 'react';
import { FileWarning } from 'lucide-react';
import type { DocumentFile } from '../../types';

// pdfjs-dist is heavy; lazy-loading PdfCanvas keeps it out of the initial
// bundle for the (common) case where the user never opens a PDF.
const PdfCanvas = React.lazy(() => import('./PdfCanvas'));

interface DocumentViewerProps {
  doc: DocumentFile | null;
  highlights: string[];
}

/**
 * The provenance caveat, rendered beside the document it qualifies.
 *
 * Same visual register as `PdfCanvas`'s honest decline for a scan ("This
 * document is a scan with no searchable text, so citations can't be located
 * in it") — yellow, non-blocking, stated plainly — because it is the same
 * kind of statement: what the app can and cannot vouch for about the text
 * on screen. Deliberately NOT the red `parseError` treatment below, which
 * replaces the document; this one sits above it, because the document is
 * genuinely readable and the review genuinely ran.
 *
 * It lives here rather than only at upload because the person reading a
 * review is often not the person who uploaded the file, and may be reading
 * it weeks later — an upload-time toast is gone by then, and what they act
 * on is what is beside the findings.
 */
function MarkupNotice({ notice }: { notice: string }) {
  return (
    <div
      role="status"
      className="shrink-0 flex items-start gap-2 bg-risk-med-tint border-b border-risk-med-edge text-risk-med font-ui text-ui-sm px-4 py-2"
    >
      <FileWarning className="w-4 h-4 shrink-0 mt-px" aria-hidden="true" />
      <span>{notice}</span>
    </div>
  );
}

/** Dispatches on document kind: PDF gets the canvas renderer with citation
 *  highlighting, DOCX/TXT get a scrollable text pane, and a failed parse
 *  gets an error message instead of a blank viewer. A document whose text
 *  is readable but not faithful to the file (`markupNotice`) gets the
 *  document *and* the caveat — never one instead of the other. */
export function DocumentViewer({ doc, highlights }: DocumentViewerProps) {
  if (!doc) {
    return (
      <div className="h-full flex items-center justify-center bg-doc-gutter font-ui text-ui text-ink-4">
        No document loaded
      </div>
    );
  }

  if (doc.parseError) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center bg-doc-gutter p-8 gap-2">
        <span className="font-ui text-ui font-medium text-ink-1">{doc.name}</span>
        <span className="font-ui text-ui-sm text-risk-high">Could not read this file: {doc.parseError}</span>
      </div>
    );
  }

  const body = doc.kind === 'pdf'
    ? (
      <Suspense
        fallback={(
          <div className="h-full flex items-center justify-center bg-doc-gutter font-ui text-ui-sm text-ink-4">
            Loading PDF…
          </div>
        )}
      >
        <PdfCanvas file={doc.file} highlights={highlights} />
      </Suspense>
    )
    : (
      <div className="h-full overflow-y-auto bg-doc-gutter">
        <div className="p-8 whitespace-pre-wrap bg-page shadow-page rounded-inset font-prose text-finding text-ink-prose max-w-3xl mx-auto my-4">
          {doc.text}
        </div>
      </div>
    );

  if (!doc.markupNotice) return body;

  return (
    <div className="h-full flex flex-col min-h-0">
      <MarkupNotice notice={doc.markupNotice} />
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  );
}

export default DocumentViewer;
