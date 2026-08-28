import React from 'react';
import { Quote } from 'lucide-react';
import type { Citation } from '../../types';

export interface EvidenceListProps {
  citations: Citation[];
  /** documentId to display name. A review can span several documents, so a
   *  quote's own document has to be named on the quote. */
  documentNames: Record<string, string>;
  /** Hands the viewer the one quote to highlight and scroll to, together
   *  with the id of the document that quote actually came from.
   *  `findQuoteRects` takes plain strings and is not being changed, so the
   *  quotes stay `string[]`.
   *
   *  The document id is not decoration. A collection review produces ONE
   *  finding per clause whose citations can belong to several different
   *  documents, so a quote alone does not say where to look — and a viewer
   *  handed a quote with no document searches whichever document happens to
   *  be on screen. Driving the real app, that reported "Couldn't locate this
   *  quote in the document ... the wording may not match exactly" about a
   *  quote sitting verbatim in the tab next door: the evidence-cannot-be-
   *  found message is the one thing worse than no message, because a reader
   *  believes it. The id is already on the `Citation` and already rendered
   *  in `pinLabel`; it simply travels with the click now. */
  onCiteClick: (quotes: string[], documentId?: string) => void;
}

/** "MSA.pdf - p. 2 - cl. 14.2", with each part omitted when it is not known.
 *  A page is only ever present when it was derived from the document's own
 *  page markers, never guessed (`src/lib/citationPage.ts`). */
function pinLabel(citation: Citation, documentNames: Record<string, string>): string {
  const parts = [documentNames[citation.documentId] ?? citation.documentId];
  if (citation.page !== undefined) parts.push(`p. ${citation.page}`);
  if (citation.clauseRef) parts.push(`cl. ${citation.clauseRef}`);
  return parts.join(' · ');
}

/**
 * The evidence behind a finding, readable on the page.
 *
 * This replaces a hover tooltip. The quote was previously visible only while
 * a pointer rested on a "Ref 1" button — so it was absent on touch, absent
 * for keyboard users, and absent from any screenshot of a review. Evidence
 * that has to be hunted for is evidence most readers never see, and a
 * finding whose support is invisible is indistinguishable from one with no
 * support at all.
 *
 * The whole block is still the click target that drives the document
 * viewer's highlight, so nothing is lost: reading is free, and locating the
 * passage is one click, exactly as before.
 */
export function EvidenceList({ citations, documentNames, onCiteClick }: EvidenceListProps) {
  if (citations.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <div className="font-mono text-label uppercase text-ink-4 flex items-center gap-1">
        <Quote className="w-3 h-3" aria-hidden="true" /> Evidence
      </div>
      {citations.map((citation, i) => (
        <button
          key={`${citation.documentId}-${i}`}
          type="button"
          onClick={() => onCiteClick([citation.quote], citation.documentId)}
          className="w-full text-left border-l-2 border-l-rule pl-3.5 py-2 pr-2.5 bg-chip-fill/40 hover:bg-chip-fill transition-colors group"
        >
          <p className="font-prose italic text-quote text-ink-quote">&ldquo;{citation.quote}&rdquo;</p>
          <span className="mt-1.5 flex items-center justify-between gap-2">
            <span className="font-mono text-pin text-ink-4 uppercase">{pinLabel(citation, documentNames)}</span>
            <span className="font-ui text-meta text-accent group-hover:underline shrink-0">Show in document</span>
          </span>
        </button>
      ))}
    </div>
  );
}
