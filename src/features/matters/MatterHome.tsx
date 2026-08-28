import React, { useRef, useState } from 'react';
import { Upload, Trash2, Play, FileWarning, FileText, ClipboardList, Loader, Layers, Lightbulb, X } from 'lucide-react';
import type { Collection, DocumentRecord, Matter, Playbook, Review, ReviewTarget } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';
import { DeleteMatterModal } from './MattersList';
import { CollectionCard } from './CollectionCard';
import { GroupDocumentsDialog } from './GroupDocumentsDialog';
import { MatterStats } from './MatterStats';
import { MatterActivity } from './MatterActivity';
import { IntakeWizard } from './IntakeWizard';
import { suggestCollections, type CollectionSuggestion } from '../../lib/collectionSuggest';
import { progressLabel } from '../../lib/reviewProgress';

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

  /** This matter's collections (Task 7) — loaded and errored independently
   *  of `documents`/`reviews`, for the same reason those two are already
   *  independent of each other: one failing must never hide the other two
   *  succeeding. */
  collections: Collection[];
  collectionsError: string | null;
  onRetryCollections: () => void;
  onCreateCollection: (params: { name: string; baseDocumentId: string; variesDocumentIds: string[] }) => Promise<void>;
  /** Deletes the collection record and returns every member to
   *  `standalone` — never deletes a document. */
  onUngroupCollection: (collectionId: string) => Promise<void>;
  /** Promotes a surviving member to base on a collection whose base
   *  document was deleted out from under it. */
  onRepairCollection: (collectionId: string, newBaseDocumentId: string) => Promise<void>;

  reviews: Review[];
  reviewsError: string | null;
  onRetryReviews: () => void;
  onOpenReview: (review: Review) => void;

  /** Playbooks available to run against this matter's documents — the same
   *  list the Library screen already loads; passed through rather than
   *  fetched again here. */
  playbooks: Playbook[];
  playbooksError: string | null;
  /** Retries the same library load `playbooksError` came from (Important 4:
   *  this used to have no retry at all — a bare paragraph telling the user
   *  to go to the Library and come back — the third of three drifted load-
   *  error idioms this component and App.tsx had grown between them). */
  onRetryPlaybooks: () => void;
  /** An omitted `target` runs today's standalone review over the matter's
   *  own documents, byte for byte unchanged (Task 7 widened this from
   *  `(playbook) => Promise<void>` without adding a second entry point).
   *  A collection's own `Run a review` action supplies one. */
  onRunReview: (playbook: Playbook, target?: ReviewTarget) => Promise<void>;

  onDeleteMatter: (matterId: string) => Promise<void>;

  /** The local profile's id (ruling R1 — this app has one user). Threaded
   *  through so the activity list can check attribution against it rather
   *  than assume: an event authored by this id reads "You …"; anything
   *  else reads with no actor at all. The only consumer is
   *  `MatterActivity`; nothing else in this screen needs an identity. */
  localUserId: string;

  /** Task 19: the model a review will run on, shown in the intake wizard's
   *  footer. The only consumer is `IntakeWizard`, rendered below in place
   *  of the empty-documents placeholder — nothing else in this screen
   *  names a model. */
  modelId: string;
  /** Task 19: opens Settings, for the intake wizard's "change the model"
   *  link. The only consumer is `IntakeWizard`. */
  onOpenSettings: () => void;
  /** Task 19: opens the route chooser that starts a new playbook (the same
   *  entry point `TemplateLibrary`'s "New" button opens), for the intake
   *  wizard's step 3 when the user has no playbooks yet. The only consumer
   *  is `IntakeWizard`. */
  onCreatePlaybook: () => void;
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

/** Stable identity for a suggestion across re-renders, so dismissing one
 *  survives the next render's fresh `suggestCollections` call — a plain
 *  array index would misattribute a dismissal if an earlier suggestion
 *  disappeared (e.g. its base got grouped some other way) and shifted the
 *  rest up. */
function suggestionKey(s: CollectionSuggestion): string {
  return `${s.baseDocumentId}:${s.variesDocumentIds.slice().sort().join(',')}`;
}

/**
 * The matter home screen (Task 11): one matter's documents and reviews, and
 * the entry point to running a new review over them. Replaces v1's run
 * panel as the place a review starts from — the run panel itself becomes
 * "add documents and run" *within* a matter (`onRunReview` below).
 *
 * Task 7 adds grouping documents into collections here: collection cards
 * render above the standalone document rows (never mixed into the same
 * list — a collection member is never ALSO shown as if it were a loose
 * document), a dismissible suggestion appears above both when
 * `suggestCollections` finds a plausible one (ruling R-C4: it only ever
 * proposes; nothing here creates a collection without this screen's own
 * confirm dialog), and each collection card carries its own `Run a
 * review` alongside the matter-wide one.
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
  collections,
  collectionsError,
  onRetryCollections,
  onCreateCollection,
  onUngroupCollection,
  onRepairCollection,
  reviews,
  reviewsError,
  onRetryReviews,
  onOpenReview,
  playbooks,
  playbooksError,
  onRetryPlaybooks,
  onRunReview,
  onDeleteMatter,
  localUserId,
  modelId,
  onOpenSettings,
  onCreatePlaybook,
}: MatterHomeProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [addingDocuments, setAddingDocuments] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [deleteMatterOpen, setDeleteMatterOpen] = useState(false);
  const [deletingMatter, setDeletingMatter] = useState(false);
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const [startingReviewId, setStartingReviewId] = useState<string | null>(null);
  // The target the run picker is currently choosing a playbook FOR —
  // `undefined` for the matter-wide button (today's behaviour, unchanged),
  // set to a specific collection's target when opened from its card.
  const [runTarget, setRunTarget] = useState<ReviewTarget | undefined>(undefined);

  // Documents not already claimed by a collection — the only rows that can
  // be selected for a NEW one, and the only ones `suggestCollections`
  // should ever propose grouping (a document already in a collection isn't
  // "loose" for the heuristic to notice).
  //
  // Membership is read from the COLLECTION RECORDS, not from each
  // document's `role`. The two can briefly disagree: creating or ungrouping
  // a collection writes the collection record and the member roles as two
  // sequential writes, because `saveCollection`'s sequence allocator is
  // typed to a single-store transaction and relaxing that type would
  // weaken a guard against a subtler bug. Both writes are ordered so a
  // partial failure can never make a document invisible — but it could
  // leave `role` saying 'standalone' while a collection still lists the
  // document as a member.
  //
  // Treating the collection record as authoritative makes that
  // disagreement invisible too: the document appears once, inside its
  // collection, instead of simultaneously in the collection card and in
  // the loose-documents list. `role` stays as the denormalised convenience
  // it is, and nothing renders a document twice because two writes did not
  // land together.
  const collectionMemberIds = new Set(
    collections.flatMap(c => [c.baseDocumentId, ...c.variesDocumentIds]),
  );
  const standaloneDocuments = documents.filter(d => !collectionMemberIds.has(d.id));
  // Preserves the order the user actually clicked in — `GroupDocumentsDialog`
  // relies on that order for "the base defaults to the first selected" and
  // "amendments keep the order the user put them in".
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());

  // Not `useMemo`: `standaloneDocuments` above is a fresh array every
  // render (a `.filter()` result), so memoizing on it would never actually
  // hit — and `suggestCollections` is cheap enough over a matter's
  // document count that recomputing plainly is simpler than a memo that
  // buys nothing.
  const suggestions = suggestCollections(standaloneDocuments).filter(s => !dismissedSuggestions.has(suggestionKey(s)));

  const selectedDocuments = selectedIds
    .map(id => standaloneDocuments.find(d => d.id === id))
    .filter((d): d is DocumentRecord => !!d);

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const openGroupDialogFromSuggestion = (s: CollectionSuggestion) => {
    setSelectedIds([s.baseDocumentId, ...s.variesDocumentIds]);
    setGroupDialogOpen(true);
  };

  const dismissSuggestion = (s: CollectionSuggestion) => {
    setDismissedSuggestions(prev => new Set(prev).add(suggestionKey(s)));
  };

  const handleConfirmGroup = async (params: { name: string; baseDocumentId: string; variesDocumentIds: string[] }) => {
    // Await-then-apply: the dialog itself only clears its own submitting
    // state, so closing it and dropping the selection here happens only
    // once the store write this represents has actually been attempted.
    // `onCreateCollection` (App.tsx) reports a failure via toast rather
    // than throwing, so this always reaches the same place either way —
    // exactly `DeleteMatterModal`'s own precedent: close and let the user
    // retry from a clean state rather than leaving a dialog stuck open on
    // a write that already failed once.
    await onCreateCollection(params);
    setGroupDialogOpen(false);
    setSelectedIds([]);
  };

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

  const openRunPicker = (target?: ReviewTarget) => {
    setRunTarget(target);
    setRunPickerOpen(true);
  };

  const handlePickPlaybook = async (playbook: Playbook) => {
    setStartingReviewId(playbook.id);
    try {
      await onRunReview(playbook, runTarget);
      setRunPickerOpen(false);
    } finally {
      setStartingReviewId(null);
    }
  };

  const runTargetCollectionName = runTarget?.kind === 'collection'
    ? collections.find(c => c.id === runTarget.collectionId)?.name
    : undefined;

  return (
    <div className="p-8 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-start mb-8">
        <div>
          <h2 className="font-prose text-matter-title text-ink-1 mb-1">{matter.name}</h2>
          <p className="font-ui text-meta text-ink-4">
            {matter.client && <span>{matter.client}</span>}
            {matter.client && matter.reference && ' · '}
            {matter.reference && <span>{matter.reference}</span>}
            {!matter.client && !matter.reference && <span>No client on file</span>}
          </p>
        </div>
        <button
          onClick={() => setDeleteMatterOpen(true)}
          className="p-2 bg-card border border-rule text-ink-4 hover:text-risk-high hover:bg-risk-high-tint hover:border-risk-high-edge rounded-control transition-all shrink-0"
          title="Delete Matter"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {/* Stat row (Task 15, spec §10.1): how much of this matter a human has
          actually checked, before anything else on the screen. Its own
          error/empty branches are R-G10, distinct from the reviews
          section's own error branch below — one says "the statistics are
          unknown", the other says "the review list is unknown", and
          suppressing either would leave a screen that looks partly fine. */}
      <div className="mb-8">
        <MatterStats reviews={reviews} reviewsError={reviewsError} onRetryReviews={onRetryReviews} />
      </div>

      {/* Lower grid (spec §10.1): documents and reviews on the left,
          this matter's activity list on the right. The two columns read
          from independent loads that fail independently — a reviews
          failure replaces ONLY the activity column with the same compact
          panel the Reviews section below already shows, never a feed
          rendered from data that could not be read (an empty feed there
          would silently read as "nothing has happened"). */}
      <div className="grid gap-6 lg:grid-cols-[1.5fr_1fr] items-start">
      <div>
      {/* Documents */}
      <section className="mb-10">
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-prose text-section text-ink-1 flex items-center gap-2">
            <FileText className="w-4 h-4 text-ink-4" /> Documents
          </h3>
          <div className="flex items-center gap-2">
            <span title={selectedIds.length < 2 ? 'Select at least two documents to group them into a collection.' : undefined}>
              <Button variant="ghost" onClick={() => setGroupDialogOpen(true)} disabled={selectedIds.length < 2}>
                <Layers className="w-4 h-4" /> Group as a collection
              </Button>
            </span>
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

        {!documentsError && suggestions.map(s => (
          <div
            key={suggestionKey(s)}
            className="mb-3 flex items-start gap-3 bg-accent-tint border border-accent-edge rounded-card px-4 py-3"
          >
            <Lightbulb className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink-1">Group "{s.name}"?</p>
              <p className="text-xs text-ink-3 mt-0.5">{s.reason}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Button variant="ghost" onClick={() => openGroupDialogFromSuggestion(s)}>Review</Button>
              <button
                onClick={() => dismissSuggestion(s)}
                aria-label="Dismiss suggestion"
                className="p-1.5 text-ink-4 hover:text-ink-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}

        {/* The two loads are independent and their failures are reported
            independently. A documents failure used to hide collection cards
            that had loaded perfectly well; a collections failure is handled
            below, where it matters most. */}
        {collectionsError && (
          <div className="mb-3">
            <LoadErrorPanel compact message={collectionsError} onRetry={onRetryCollections} />
          </div>
        )}
        {!collectionsError && collections.length > 0 && (
          <div className="flex flex-col gap-3 mb-3">
            {collections.map(c => (
              <CollectionCard
                key={c.id}
                collection={c}
                documents={documents}
                onUngroup={onUngroupCollection}
                onRepair={onRepairCollection}
                onRunReview={openRunPicker}
              />
            ))}
          </div>
        )}

        {documentsError ? (
          <LoadErrorPanel compact message={documentsError} onRetry={onRetryDocuments} />
        ) : collectionsError ? (
          /* Membership is UNKNOWN, not empty. The loose-documents list is
             derived from the collection records, so without them this
             component cannot say which documents are loose — and saying
             "all of them" would show grouped documents as ungrouped, which
             is worse than saying nothing: a reader would believe it and
             might regroup a document that is already in a collection.
             So the documents are listed plainly, with no selection and no
             grouping affordance, and the error above says why. Distinguish
             "empty" from "broken" — never present a broken read as a
             confident answer. */
          <div className="flex flex-col gap-2">
            {documents.map(doc => (
              <div
                key={doc.id}
                className="flex items-center gap-4 bg-card border border-rule rounded-card px-4 py-3"
              >
                <FileText className="w-4 h-4 text-ink-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-1 truncate">{doc.name}</div>
                  <div className="font-mono text-pin text-ink-4">
                    {doc.kind.toUpperCase()} · grouping unavailable until collections load
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <>
            {documents.length === 0 ? (
              // Spec §10.2 / the handoff's own instruction: an empty matter
              // shows the first-run intake wizard, not an empty table. It
              // is genuinely a different fact from "the documents failed to
              // load" (the `documentsError` branch above, which this
              // ternary never reaches when there IS an error) — "this
              // matter has no documents yet" and "we could not read this
              // matter's documents" must never look alike.
              <IntakeWizard
                matter={matter}
                documents={documents}
                documentsError={documentsError}
                onRetryDocuments={onRetryDocuments}
                onAddDocuments={onAddDocuments}
                onRemoveDocument={onRemoveDocument}
                onCreateCollection={onCreateCollection}
                playbooks={playbooks}
                playbooksError={playbooksError}
                onRetryPlaybooks={onRetryPlaybooks}
                onRunReview={(playbook) => onRunReview(playbook)}
                onCreatePlaybook={onCreatePlaybook}
                modelId={modelId}
                onOpenSettings={onOpenSettings}
              />
            ) : standaloneDocuments.length > 0 ? (
              <div className="flex flex-col gap-2">
                {standaloneDocuments.map(doc => (
                  <div
                    key={doc.id}
                    className="flex items-center gap-4 bg-card border border-rule rounded-card px-4 py-3"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(doc.id)}
                      onChange={() => toggleSelected(doc.id)}
                      aria-label={`Select ${doc.name}`}
                      className="shrink-0"
                    />
                    {doc.parseError
                      ? <FileWarning className="w-4 h-4 text-risk-high shrink-0" />
                      : doc.markupNotice
                        ? <FileWarning className="w-4 h-4 text-risk-med shrink-0" />
                        : <FileText className="w-4 h-4 text-ink-4 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-1 truncate">{doc.name}</p>
                      <p className="font-mono text-pin text-ink-4">
                        {doc.kind.toUpperCase()} · Added {formatDate(doc.addedAt)}
                      </p>
                      {doc.parseError && (
                        <p className="text-xs text-risk-high mt-0.5">Unreadable: {doc.parseError}</p>
                      )}
                      {/* risk-med, not risk-high, and never "unreadable":
                          this document parsed and is reviewable — the
                          caveat is that its text is the file with every
                          tracked change accepted. The same wording appears
                          beside the findings (`DocumentViewer`), because
                          whoever reads the review may never have seen this
                          screen. */}
                      {doc.markupNotice && (
                        <p className="text-xs text-risk-med mt-0.5">{doc.markupNotice}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleRemove(doc)}
                      disabled={removingId === doc.id}
                      className="p-1.5 text-ink-4 hover:text-risk-high disabled:opacity-50 shrink-0"
                      aria-label={`Remove ${doc.name}`}
                    >
                      {removingId === doc.id ? <Loader className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </section>

      {/* Reviews */}
      <section>
        <div className="flex justify-between items-center mb-4">
          <h3 className="font-prose text-section text-ink-1 flex items-center gap-2">
            <ClipboardList className="w-4 h-4 text-ink-4" /> Reviews
          </h3>
          <Button onClick={() => openRunPicker(undefined)}>
            <Play className="w-4 h-4" /> Run a review
          </Button>
        </div>

        {reviewsError ? (
          <LoadErrorPanel compact message={reviewsError} onRetry={onRetryReviews} />
        ) : reviews.length === 0 ? (
          <div className="text-ink-4 border border-dashed border-rule p-6 rounded-card text-center text-sm">
            No reviews yet. Run one to get started.
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {reviews.map(review => (
              <button
                key={review.id}
                onClick={() => onOpenReview(review)}
                className="flex items-center gap-4 bg-card border border-rule rounded-card px-4 py-3 text-left hover:border-accent-edge transition-colors"
              >
                <div className="w-9 h-9 rounded-card bg-accent-tint text-accent flex items-center justify-center shrink-0">
                  <ClipboardList className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink-1 truncate">{review.playbookSnapshot.name}</p>
                  <p className="font-mono text-pin text-ink-4">
                    Started {formatDate(review.startedAt)} · {reviewStatusLabel(review)}
                  </p>
                  <span className="font-mono text-pin text-ink-4">{progressLabel(review.findings)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      </div>

      {reviewsError ? (
        <LoadErrorPanel compact message={reviewsError} onRetry={onRetryReviews} />
      ) : (
        <MatterActivity reviews={reviews} localUserId={localUserId} />
      )}
      </div>

      <DeleteMatterModal
        isOpen={deleteMatterOpen}
        onClose={() => { if (!deletingMatter) setDeleteMatterOpen(false); }}
        onConfirm={handleConfirmDeleteMatter}
      />

      <GroupDocumentsDialog
        isOpen={groupDialogOpen}
        documents={selectedDocuments}
        onClose={() => setGroupDialogOpen(false)}
        onConfirm={handleConfirmGroup}
      />

      <Modal
        isOpen={runPickerOpen}
        title="Run a review"
        onClose={() => { if (!startingReviewId) setRunPickerOpen(false); }}
        footer={<Button variant="ghost" onClick={() => setRunPickerOpen(false)} disabled={!!startingReviewId}>Cancel</Button>}
      >
        {runTargetCollectionName && (
          <p className="font-mono text-pin text-ink-4">
            Reviewing the <span className="text-ink-1">{runTargetCollectionName}</span> collection.
          </p>
        )}
        {playbooksError ? (
          <LoadErrorPanel compact message={playbooksError} onRetry={onRetryPlaybooks} />
        ) : playbooks.length === 0 ? (
          <p className="text-sm text-ink-3">
            No playbooks yet. Create one in Playbooks first, then run it against this matter's documents.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-label text-ink-4 uppercase mb-1">Choose a playbook</p>
            {playbooks.map(playbook => (
              <button
                key={playbook.id}
                onClick={() => handlePickPlaybook(playbook)}
                disabled={!!startingReviewId}
                className="w-full flex items-center justify-between gap-3 bg-chip-fill hover:bg-rule-soft border border-rule rounded-control px-3 py-2.5 text-left text-sm text-ink-1 transition-colors disabled:opacity-50"
              >
                <span className="truncate">{playbook.name}</span>
                {startingReviewId === playbook.id && (
                  <span data-busy="true" aria-live="polite" className="shrink-0">
                    <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
                  </span>
                )}
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
              <p
                data-busy="true"
                aria-live="polite"
                className="text-xs text-ink-2 flex items-center gap-2 pt-1"
              >
                <Loader className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                Preparing documents for review — scanned pages can take a moment to render…
              </p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
