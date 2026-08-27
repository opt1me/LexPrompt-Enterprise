import React, { useEffect, useState } from 'react';
import { X, FileText, BookOpen } from 'lucide-react';
import type { Clause, DocumentFile, Finding } from '../../types';
import type { VerificationChange } from '../../lib/verification';
import { FindingCard } from '../review/FindingCard';
import { DocumentViewer } from '../review/DocumentViewer';

export interface CellDetailProps {
  doc: DocumentFile | null;
  clause: Clause;
  finding: Finding | undefined;
  onClose: () => void;
  onRetry: (clauseId: string) => void;
  /** Persists the human's verification intent for this one finding (Task
   *  10). Optional: omitted, the card shows its state chip with no controls. */
  onVerify?: (change: VerificationChange) => Promise<void>;
  /** True while this finding's verification or note write is in flight. */
  verifyBusy?: boolean;
  /** Persists a new note against this finding (Task 10). */
  onAddNote?: (text: string) => Promise<void>;
  /** The local profile's initials, for a note's author placeholder. */
  authorInitials?: string;
  /** The grid's way out of triage: hands this clicked cell off to the
   *  ledger (Task 10). Optional, same reasoning as `onVerify`/`onAddNote` —
   *  omitted, no such affordance renders rather than a button that goes
   *  nowhere. */
  onOpenInReview?: () => void;
}

/**
 * Side panel for one clicked cell. It renders the exact same `<FindingCard>`
 * the card view uses — same summary, risk badge, risk analysis and citation
 * buttons — so the detail panel can never drift from what the card shows for
 * the same finding. A `<DocumentViewer>` sits beneath it; clicking a citation
 * button feeds that single quote to the viewer as its highlight, scrolling
 * to it, exactly as `ResultsView` wires `FindingCard` to `DocumentViewer`.
 */
export function CellDetail({ doc, clause, finding, onClose, onRetry, onVerify, verifyBusy, onAddNote, authorInitials, onOpenInReview }: CellDetailProps) {
  const [highlights, setHighlights] = useState<string[]>([]);

  // A stale highlight from the previously-opened cell must not linger when
  // the panel switches to a different document/clause.
  useEffect(() => {
    setHighlights([]);
  }, [doc?.id, clause.id]);

  return (
    <div className="w-full lg:w-[420px] shrink-0 border-l border-white/10 bg-[#0e0e0e] flex flex-col h-full">
      <div className="h-14 border-b border-white/10 flex items-center justify-between px-4 bg-[#161616] shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileText className="w-4 h-4 text-violet-400 shrink-0" />
          <span className="text-xs font-bold text-gray-200 truncate" title={doc?.name}>
            {doc?.name ?? 'Document'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenInReview && (
            <button
              onClick={onOpenInReview}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 px-2 py-1 rounded transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" /> Open in review
            </button>
          )}
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white p-1 hover:bg-white/10 rounded transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-white/10 overflow-y-auto max-h-[50%] shrink-0">
        <FindingCard
          clause={clause}
          finding={finding}
          onCiteClick={setHighlights}
          onRetry={onRetry}
          onVerify={onVerify}
          verifyBusy={verifyBusy}
          onAddNote={onAddNote}
          noteBusy={verifyBusy}
          documentNames={doc ? { [doc.id]: doc.name } : {}}
          authorInitials={authorInitials}
        />
      </div>

      <div className="flex-1 min-h-0">
        <DocumentViewer doc={doc} highlights={highlights} />
      </div>
    </div>
  );
}
