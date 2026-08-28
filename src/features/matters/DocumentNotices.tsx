import React from 'react';
import type { DocumentRecord } from '../../types';
import { assessDocument } from '../../lib/modelContext';

/**
 * A document record carries no page images by design (derived data,
 * regenerated on demand, never stored), so this asks the narrower question
 * the record can answer: did any usable text come out of it?
 * `assessDocument` with `modelSupportsImages: false` returns `unreadable`
 * exactly when it did not.
 */
export function noUsableText(doc: DocumentRecord): boolean {
  return assessDocument({ text: doc.text }, false).kind === 'unreadable';
}

/**
 * R-G13's replacement for the mockup's fake OCR progress bar. This app does
 * not OCR, so a progress bar for work it never does would be a lie; the
 * honest replacement is this sentence, stated ONCE before the run rather
 * than met as a per-clause refusal from `modelContext` after the tokens
 * have been spent.
 *
 * A single exported constant because the reason it exists is that it must
 * be said, and a second hand-written copy is how it stops being said in one
 * of the places (CLAUDE.md's sibling-drift rule; `verificationLabel` is the
 * same pattern for export wording).
 */
export const SCAN_DISCLOSURE =
  'No text could be extracted from this document — it looks like a scan. ' +
  'Reviewing it needs a vision-capable model.';

/**
 * Everything ingestion actually discovered about one document, rendered
 * wherever that document is listed.
 *
 * This lives in its own module rather than inline in `MatterHome` because
 * a matter lists its documents in more than one place (the standalone list,
 * and the plain list shown when collections failed to load), and the whole
 * point of the scan line is that a user meets it before they run — which
 * only holds if every list that shows a document shows it.
 */
export function DocumentNotices({ doc }: { doc: DocumentRecord }) {
  return (
    <>
      {doc.parseError && (
        <p className="text-xs text-risk-high mt-0.5">Unreadable: {doc.parseError}</p>
      )}
      {/* Only when the document did not also fail to parse: a parse error
          already says why there is no text, and two explanations for one
          fact read as two problems. */}
      {!doc.parseError && noUsableText(doc) && (
        <p className="text-xs text-risk-med mt-0.5">{SCAN_DISCLOSURE}</p>
      )}
      {/* risk-med, not risk-high, and never "unreadable": this document
          parsed and is reviewable — the caveat is that its text is the file
          with every tracked change accepted. The same wording appears beside
          the findings (`DocumentViewer`), because whoever reads the review
          may never have seen this screen. */}
      {doc.markupNotice && (
        <p className="text-xs text-risk-med mt-0.5">{doc.markupNotice}</p>
      )}
    </>
  );
}
