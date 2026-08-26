import React, { useRef, useState } from 'react';
import { Upload, Trash2, Play, FileWarning, FileText, ClipboardList, Loader } from 'lucide-react';
import type { DocumentRecord, Matter, Review, Template } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { DeleteMatterModal } from './MattersList';

export interface MatterHomeProps {
  matter: Matter;

  documents: DocumentRecord[];
  /** Mirrors `App.tsx`'s `mattersLoadError`/`libraryLoadError` pattern for
   *  this matter's own documents list: a dedicated, honest error state that
   *  renders instead of the (possibly correctly-empty) list, never a silent
   *  fallback to "no documents". */
  documentsError: string | null;
  onRetryDocuments: () => void;
  onAddDocuments: (files: File[]) => Promise<void>;
  onRemoveDocument: (documentId: string) => Promise<void>;

  reviews: Review[];
  reviewsError: string | null;
  onRetryReviews: () => void;
  onOpenReview: (review: Review) => void;

  /** Playbooks available to run against this matter's documents — the same
   *  list the Library screen already loads; passed through rather than
   *  fetched again here. */
  playbooks: Template[];
  playbooksError: string | null;
  onRunReview: (playbook: Template) => Promise<void>;

  onDeleteMatter: (matterId: string) => Promise<void>;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Counts findings by outcome across every document in a review, purely
 *  from `review.findings` — deliberately not shared with
 *  `runReview.ts#runProgress` (v1 code this sub-project does not touch),
 *  even though the shape is the same. */
function reviewProgress(review: Review): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const byClause of Object.values(review.findings)) {
    for (const finding of Object.values(byClause)) {
      total++;
      if (finding.status === 'done' || finding.status === 'error' || finding.status === 'cancelled') done++;
    }
  }
  return { done, total };
}

function reviewStatusLabel(review: Review): string {
  const { done, total } = reviewProgress(review);
  if (review.completedAt) return `Completed ${formatDate(review.completedAt)}`;
  if (review.cancelledAt) return `Cancelled — ${done}/${total} clauses reviewed`;
  return `In progress — ${done}/${total} clauses reviewed`;
}

/** A dedicated error block for a section's load failure — rendered INSTEAD
 *  OF that section's content, never alongside an empty-looking list, and
 *  always with a working retry. Mirrors the pattern `App.tsx` uses for the
 *  matters list and playbook library load failures. */
function SectionLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="p-6 text-center space-y-3 border border-dashed border-red-500/30 rounded-xl bg-red-950/10">
      <p className="text-red-400 text-sm">{message}</p>
      <button
        onClick={onRetry}
        className="px-3 py-1.5 rounded-md bg-violet-600 text-white text-sm hover:bg-violet-500"
      >
        Retry
      </button>
    </div>
  );
}

/**
 * The matter home screen (Task 11): one matter's documents and reviews, and
 * the entry point to running a new review over them. Replaces v1's run
 * panel as the place a review starts from — the run panel itself becomes
 * "add documents and run" *within* a matter (`onRunReview` below).
 *
 * Three states this screen must never paper over (spec §9):
 *  - a document that failed to parse still appears, marked unreadable with
 *    its actual error, never silently dropped from the list;
 *  - a documents or reviews load failure is its own visible state with a
 *    retry, never indistinguishable from "this matter has none yet";
 *  - opening a review whose documents were since deleted still shows its
 *    findings (handled by the caller's hydration) rather than refusing to
 *    open at all.
 */
export function MatterHome({
  matter,
  documents,
  documentsError,
  onRetryDocuments,
  onAddDocuments,
  onRemoveDocument,
  reviews,
  reviewsError,
  onRetryReviews,
  onOpenReview,
  playbooks,
  playbooksError,
  onRunReview,
  onDeleteMatter,
}: MatterHomeProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addingDocuments, setAddingDocuments] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deleteMatterOpen, setDeleteMatterOpen] = useState(false);
  const [deletingMatter, setDeletingMatter] = useState(false);
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const [startingReviewId, setStartingReviewId] = useState<string | null>(null);

  const handleAddClick = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ''; // reset so the same file can be reselected
    if (files.length === 0) return;
    setAddingDocuments(true);
    try {
      await onAddDocuments(files);
    } finally {
      setAddingDocuments(false);
    }
  };

  const handleRemove = async (doc: DocumentRecord) => {
    if (!window.confirm(`Remove "${doc.name}" from this matter? This cannot be undone.`)) return;
    setRemovingId(doc.id);
    try {
      await onRemoveDocument(doc.id);
    } finally {
      setRemovingId(null);
    }
  };

  const handleConfirmDeleteMatter = async () => {
    setDeletingMatter(true);
    try {
      await onDeleteMatter(matter.id);
    } finally {
      // If deletion succeeded, the caller navigates away and this component
      // unmounts before this runs; if it failed, the modal should close and
      // the state reset so the user can try again.
      setDeletingMatter(false);
      setDeleteMatterOpen(false);
    }
  };

  const handlePickPlaybook = async (playbook: Template) => {
    setStartingReviewId(playbook.id);
    try {
      await onRunReview(playbook);
      setRunPickerOpen(false);
    } finally {
      setStartingReviewId(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white mb-1">{matter.name}</h2>
          <p className="text-gray-400 text-sm">
            {matter.client && <span>{matter.client}</span>}
            {matter.client && matter.reference && ' · '}
            {matter.reference && <span>{matter.reference}</span>}
            {!matter.client && !matter.reference && <span>No client on file</span>}
          </p>
        </div>
        <button
          onClick={() => setDeleteMatterOpen(true)}
          className="p-2 bg-[#1a1a1a] border border-white/10 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/50 rounded-lg transition-all shrink-0"
          title="Delete Matter"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Documents */}
      <section className="mb-10">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <FileText className="w-4 h-4 text-gray-500" /> Documents
          </h3>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={handleFileChange}
              className="hidden"
              aria-label="Add documents"
            />
            <Button variant="ghost" onClick={handleAddClick} disabled={addingDocuments}>
              {addingDocuments ? <Loader className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {addingDocuments ? 'Reading files…' : 'Add documents'}
            </Button>
          </div>
        </div>

        {documentsError ? (
          <SectionLoadError message={documentsError} onRetry={onRetryDocuments} />
        ) : documents.length === 0 ? (
          <div className="text-gray-500 border border-dashed border-white/10 p-6 rounded-xl text-center text-sm">
            No documents yet. Add one to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {documents.map(doc => (
              <div
                key={doc.id}
                className="flex items-center gap-4 bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-3"
              >
                {doc.parseError
                  ? <FileWarning className="w-4 h-4 text-red-400 shrink-0" />
                  : <FileText className="w-4 h-4 text-gray-500 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white truncate">{doc.name}</p>
                  <p className="text-xs text-gray-500">
                    {doc.kind.toUpperCase()} · Added {formatDate(doc.addedAt)}
                  </p>
                  {doc.parseError && (
                    <p className="text-xs text-red-400 mt-0.5">Unreadable: {doc.parseError}</p>
                  )}
                </div>
                <button
                  onClick={() => handleRemove(doc)}
                  disabled={removingId === doc.id}
                  className="p-1.5 text-gray-500 hover:text-red-400 disabled:opacity-50 shrink-0"
                  aria-label={`Remove ${doc.name}`}
                >
                  {removingId === doc.id ? <Loader className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Reviews */}
      <section>
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-gray-500" /> Reviews
          </h3>
          <Button onClick={() => setRunPickerOpen(true)}>
            <Play className="w-4 h-4" /> Run a review
          </Button>
        </div>

        {reviewsError ? (
          <SectionLoadError message={reviewsError} onRetry={onRetryReviews} />
        ) : reviews.length === 0 ? (
          <div className="text-gray-500 border border-dashed border-white/10 p-6 rounded-xl text-center text-sm">
            No reviews yet. Run one to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {reviews.map(review => (
              <button
                key={review.id}
                onClick={() => onOpenReview(review)}
                className="flex items-center gap-4 bg-[#1a1a1a] border border-white/10 rounded-xl px-4 py-3 text-left hover:border-violet-500/50 transition-colors"
              >
                <div className="w-9 h-9 rounded-lg bg-violet-600/20 text-violet-300 flex items-center justify-center shrink-0">
                  <ClipboardList className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{review.playbookSnapshot.name}</p>
                  <p className="text-xs text-gray-500">
                    Started {formatDate(review.startedAt)} · {reviewStatusLabel(review)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <DeleteMatterModal
        isOpen={deleteMatterOpen}
        onClose={() => { if (!deletingMatter) setDeleteMatterOpen(false); }}
        onConfirm={handleConfirmDeleteMatter}
      />

      <Modal
        isOpen={runPickerOpen}
        title="Run a review"
        onClose={() => { if (!startingReviewId) setRunPickerOpen(false); }}
        footer={<Button variant="ghost" onClick={() => setRunPickerOpen(false)} disabled={!!startingReviewId}>Cancel</Button>}
      >
        {playbooksError ? (
          <p className="text-sm text-red-400">
            Playbooks could not be loaded. Go to the Library to retry, then come back here.
          </p>
        ) : playbooks.length === 0 ? (
          <p className="text-sm text-gray-400">
            No playbooks yet. Create one in the Library first, then run it against this matter's documents.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-gray-500 uppercase font-semibold tracking-wider mb-1">Choose a playbook</p>
            {playbooks.map(playbook => (
              <button
                key={playbook.id}
                onClick={() => handlePickPlaybook(playbook)}
                disabled={!!startingReviewId}
                className="w-full flex items-center justify-between gap-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg px-3 py-2.5 text-left text-sm text-white transition-colors disabled:opacity-50"
              >
                <span className="truncate">{playbook.name}</span>
                {startingReviewId === playbook.id && <Loader className="w-4 h-4 animate-spin shrink-0" />}
              </button>
            ))}
            {/* A bare per-item spinner reads as "the click registered", not
               "this is going to take a while" — not enough signal when
               preparing this run means pdfjs re-rendering every page of a
               multi-page scan to nothing but text (see
               documentFileForReview/documentNeedsPageImages). This banner
               only appears once a playbook has actually been picked, so it
               never shows for a run that turns out to need no regeneration
               at all — it just doesn't stick around long in that case. */}
            {startingReviewId && (
              <p className="text-xs text-gray-400 flex items-center gap-2 pt-1">
                <Loader className="w-3.5 h-3.5 animate-spin shrink-0" />
                Preparing documents for review — scanned pages can take a moment to render…
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
