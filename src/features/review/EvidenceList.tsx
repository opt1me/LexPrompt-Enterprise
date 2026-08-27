import React from 'react';
import { Quote } from 'lucide-react';
import type { Citation } from '../../types';

export interface EvidenceListProps {
  citations: Citation[];
  /** documentId to display name. A review can span several documents, so a
   *  quote's own document has to be named on the quote. */
  documentNames: Record<string, string>;
  /** Unchanged from the previous citation buttons: hands the viewer the one
   *  quote to highlight and scroll to. `findQuoteRects` takes plain strings
   *  and is not being changed, so this stays `string[]`. */
  onCiteClick: (quotes: string[]) => void;
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
      <div className="text-[10px] font-bold text-gray-500 uppercase tracking-wide flex items-center gap-1">
        <Quote className="w-3 h-3" aria-hidden="true" /> Evidence
      </div>
      {citations.map((citation, i) => (
        <button
          key={`${citation.documentId}-${i}`}
          type="button"
          onClick={() => onCiteClick([citation.quote])}
          className="w-full text-left bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/15 rounded-lg p-2.5 transition-colors group"
        >
          <p className="text-[11px] text-gray-300 leading-relaxed italic">&ldquo;{citation.quote}&rdquo;</p>
          <span className="mt-1.5 block text-[10px] text-gray-500 group-hover:text-violet-300 transition-colors">
            {pinLabel(citation, documentNames)}
          </span>
        </button>
      ))}
    </div>
  );
}
