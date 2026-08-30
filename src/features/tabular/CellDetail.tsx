import React, { useEffect, useState } from 'react';
import { X, FileText, BookOpen } from 'lucide-react';
import type { PlaybookClause, DocumentFile, Finding } from '../../types';
import type { VerificationChange } from '@lexprompt/core';
import { Button } from '../../components/Button';
import { FindingCard } from '../review/FindingCard';
import { DocumentViewer } from '../review/DocumentViewer';

export interface CellDetailProps {
  doc: DocumentFile | null;
  /** Every document in the run, so a citation belonging to a document other
   *  than `doc` can be shown in the document it actually came from — and so
   *  its pin label can name that document instead of printing a raw id.
   *
   *  Written for the collection case: one finding per clause whose citations
   *  may span the whole collection, so `doc` would routinely not be the
   *  document a given quote came from.
   *
   *  **Currently unreachable, deliberately kept.** `TabularReview` returns
   *  `CollectionNotComparable` before it renders any grid for a collection
   *  target, so this panel never opens for one; and for a `documents` target
   *  every citation carries the reviewed document's own id (`repairCitations`),
   *  so the swap cannot fire. An earlier version of this comment claimed the
   *  panel WAS reachable from every row, which stopped being true when the
   *  grid's collection refusal landed — do not read it as evidence that the
   *  path runs today.
   *
   *  Kept rather than deleted because it is correct, costs nothing, and the
   *  grid's refusal is a product decision that could be revisited; deleting
   *  it would mean rediscovering that highlighting a quote in a document it
   *  did not come from makes the viewer report missing evidence that exists.
   *  Optional: omitted, the panel behaves exactly as it did — one document,
   *  no swap. */
  documents?: DocumentFile[];
  clause: PlaybookClause;
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
  /** The local profile's id, for deciding which notes read as "yours". */
  localUserId?: string;
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
export function CellDetail({ doc, documents, clause, finding, onClose, onRetry, onVerify, verifyBusy, onAddNote, authorInitials, localUserId, onOpenInReview }: CellDetailProps) {
  const [highlights, setHighlights] = useState<string[]>([]);
  /** Set when a clicked citation belongs to a document other than `doc`. */
  const [citedDocId, setCitedDocId] = useState<string | null>(null);

  const shownDoc = (citedDocId ? documents?.find(d => d.id === citedDocId) : undefined) ?? doc;
  const documentNames = documents
    ? Object.fromEntries(documents.map(d => [d.id, d.name]))
    : (doc ? { [doc.id]: doc.name } : {});

  /** Same rule as `ResultsView.handleCiteClick`, and here for the same
   *  reason: highlighting a quote in a document it did not come from makes
   *  the viewer report that the evidence cannot be found, about evidence
   *  that exists. A document not in `documents` leaves the panel on `doc`
   *  rather than blanking it. */
  const handleCiteClick = (quotes: string[], documentId?: string) => {
    if (documentId && documents?.some(d => d.id === documentId)) setCitedDocId(documentId);
    setHighlights(quotes);
  };

  // A stale highlight from the previously-opened cell must not linger when
  // the panel switches to a different document/clause.
  useEffect(() => {
    setHighlights([]);
    setCitedDocId(null);
  }, [doc?.id, clause.id]);

  return (
    <div className="w-full lg:w-[420px] shrink-0 border-l border-rule bg-card flex flex-col h-full">
      <div className="h-14 border-b border-rule flex items-center justify-between px-4 bg-card shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileText className="w-4 h-4 text-accent shrink-0" aria-hidden="true" />
          <span className="font-ui text-ui-sm font-semibold text-ink-1 truncate" title={doc?.name}>
            {doc?.name ?? 'Document'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {onOpenInReview && (
            <Button variant="ghost" onClick={onOpenInReview} className="py-1 text-[11px]">
              <BookOpen className="w-3.5 h-3.5" aria-hidden="true" /> Open in review
            </Button>
          )}
          <button
            onClick={onClose}
            className="text-ink-4 hover:text-ink-1 p-1 rounded-control hover:bg-chip-fill transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="p-4 border-b border-rule overflow-y-auto max-h-[50%] shrink-0">
        <FindingCard
          clause={clause}
          finding={finding}
          onCiteClick={handleCiteClick}
          onRetry={onRetry}
          onVerify={onVerify}
          verifyBusy={verifyBusy}
          onAddNote={onAddNote}
          noteBusy={verifyBusy}
          documentNames={documentNames}
          authorInitials={authorInitials}
          localUserId={localUserId}
        />
      </div>

      <div className="flex-1 min-h-0">
        <DocumentViewer doc={shownDoc} highlights={highlights} />
      </div>
    </div>
  );
}
