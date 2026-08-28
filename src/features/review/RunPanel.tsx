import React, { useState } from 'react';
import { Upload, X, Play, FileWarning, CircleSlash, TriangleAlert, AlertOctagon } from 'lucide-react';
import type { DocumentFile, ReviewRun, PlaybookVersion } from '../../types';
import { parseFiles } from '../../lib/documents';
import { Button } from '../../components/Button';
import { runProgress, countNoContent } from './runReview';

export interface RunPanelProps {
  template: PlaybookVersion;
  onBack: () => void;
  onRun: (documents: DocumentFile[]) => void;
  /** Pre-populates the document list (Task 11: "Run a review" from a
   *  matter reuses this panel scoped to that matter's own documents,
   *  already hydrated by the caller, rather than asking the user to
   *  re-upload what they already added to the matter). Still fully
   *  editable from here — more can be added, and any of these can be
   *  removed for just this run. Defaults to empty, preserving the
   *  Library's original standalone upload-from-scratch flow. */
  initialDocuments?: DocumentFile[];
}

/**
 * Upload + configure screen. One button, not three: every run is per
 * document now, so there is nothing left to choose between "batch",
 * "collection" and "tabular" — just how many documents and how many clauses.
 */
export function RunPanel({ template, onBack, onRun, initialDocuments = [] }: RunPanelProps) {
  const [documents, setDocuments] = useState<DocumentFile[]>(initialDocuments);
  const [parsing, setParsing] = useState(false);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setParsing(true);
    try {
      // Never throws: a bad file comes back with parseError set and the
      // rest of the batch intact, so a single corrupt upload can't block
      // the others.
      const parsed = await parseFiles(Array.from(fileList));
      setDocuments(prev => [...prev, ...parsed]);
    } finally {
      setParsing(false);
    }
  };

  const removeDocument = (id: string) => setDocuments(prev => prev.filter(d => d.id !== id));

  const docCount = documents.length;
  const clauseCount = template.clauses.length;

  return (
    <div className="p-8 max-w-2xl mx-auto h-full flex flex-col justify-center">
      <div className="w-full bg-card border border-rule rounded-panel p-8">
        <div className="flex justify-between items-center mb-6">
          <h2 className="font-prose text-section text-ink-1">Run review: {template.name}</h2>
          <button onClick={onBack} className="font-ui text-meta text-ink-3 hover:text-ink-1">Cancel</button>
        </div>

        <div className="border-2 border-dashed border-rule rounded-card p-10 text-center mb-6 hover:bg-chip-fill transition-colors relative bg-paper">
          <input
            type="file"
            multiple
            onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label="Upload documents"
          />
          <Upload className="w-8 h-8 text-ink-4 mx-auto mb-2" aria-hidden="true" />
          <p className="font-ui text-ui text-ink-2">{parsing ? 'Reading files…' : 'Drag files here or click to upload'}</p>
          <p className="font-ui text-meta text-ink-4 mt-2">Supports PDF, DOCX, TXT</p>
        </div>

        {documents.length > 0 && (
          <div className="mb-6 space-y-2 max-h-48 overflow-y-auto">
            {documents.map(d => (
              <div key={d.id} className="flex items-center justify-between gap-3 font-ui text-ui-sm text-ink-2 bg-paper p-2 rounded-control border border-rule">
                <span className="truncate flex items-center gap-2 min-w-0">
                  {d.parseError && <FileWarning className="w-3.5 h-3.5 text-risk-high shrink-0" aria-hidden="true" />}
                  <span className="truncate">{d.name}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {d.parseError ? (
                    <span className="text-risk-high max-w-[12rem] truncate" title={d.parseError}>{d.parseError}</span>
                  ) : (
                    <span className="text-ink-4">Ready</span>
                  )}
                  <button
                    onClick={() => removeDocument(d.id)}
                    className="text-ink-4 hover:text-ink-1"
                    aria-label={`Remove ${d.name}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="font-ui text-meta text-ink-3 mb-3 text-center">
          {docCount} document{docCount === 1 ? '' : 's'} &times; {clauseCount} clause{clauseCount === 1 ? '' : 's'}
        </p>

        <Button onClick={() => onRun(documents)} disabled={docCount === 0} className="w-full">
          <Play className="w-4 h-4" /> Run review
        </Button>
      </div>
    </div>
  );
}

export interface RunProgressBarProps {
  run: ReviewRun;
  onCancel: () => void;
}

/**
 * Slim status bar shown above the results while a run is in flight: real
 * progress from `runProgress`, plus a Cancel button that aborts the
 * in-flight `AbortController`. It sits alongside (not instead of) the
 * findings cards so completed cards stay visible the whole time — cancelling
 * never tears anything down, it only stops new work from starting.
 */
export function RunProgressBar({ run, onCancel }: RunProgressBarProps) {
  const { done, total } = runProgress(run);
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="shrink-0 border-b border-rule bg-card px-6 py-3 flex items-center gap-4" data-busy="true" aria-live="polite">
      <div className="flex-1 min-w-0">
        <div className="flex justify-between font-ui text-meta text-ink-3 mb-1.5">
          <span>Reviewing… {done} of {total} clauses</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-chip-fill rounded-meter overflow-hidden">
          <div className="h-full bg-accent transition-all duration-150" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Button variant="ghost" onClick={onCancel} className="shrink-0">Cancel</Button>
    </div>
  );
}

/**
 * Shown once a run has stopped via cancellation rather than running to
 * completion — the two are told apart by `run.cancelledAt` vs
 * `run.completedAt` (Important 5: before this, `completedAt` was written
 * and never read anywhere, so nothing distinguished a finished run from a
 * cancelled one once the progress bar disappeared).
 */
export function RunCancelledBanner({ run }: { run: ReviewRun }) {
  const { done, total } = runProgress(run);
  return (
    <div className="shrink-0 border-b border-rule bg-card px-6 py-3 flex items-center gap-3 font-ui text-ui text-ink-2">
      <CircleSlash className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>Run cancelled — {done} of {total} clauses were reviewed before it stopped.</span>
    </div>
  );
}

/**
 * Shown once a completed run includes one or more clauses the model
 * answered with a schema-valid but empty response (`Finding.noContent`,
 * set by `extractClause` — see empty-review-investigation.md). A single
 * empty clause among populated ones is unremarkable; a review where most or
 * all clauses came back empty looks, at a glance, exactly like a fully
 * answered one — no error, no risk badge, just quiet blank cards. This is
 * a plain count, not a threshold or a block on the run: it makes the raw
 * number visible so the user can judge for themselves whether the pattern
 * looks like genuine silence or a model that couldn't read the document.
 *
 * Placed here, next to `RunProgressBar`/`RunCancelledBanner` above the
 * results pane in App.tsx, so it is visible across both the per-document
 * ResultsView and the all-documents TabularReview, and doesn't disappear
 * when the user switches documents (unlike a per-document header count
 * would).
 */
/**
 * Shown when a review is reopened neither completed nor cancelled, and is
 * not the live run this session started (Important 1). Before this, such a
 * review rendered with no banner at all — `isRunning` was false, so nothing
 * said anything was wrong — while its `pending`/`running` cells kept
 * painting an animated spinner and skeleton indistinguishable from work
 * genuinely in flight, with no way to finish it (see `FindingCard`'s
 * `interrupted` prop, wired up alongside this banner in App.tsx). This says
 * plainly what happened and that Retry (on every stalled cell) is how to
 * pick it back up.
 */
export function RunInterruptedBanner({ run }: { run: ReviewRun }) {
  const { done, total } = runProgress(run);
  return (
    <div className="shrink-0 border-b border-risk-med-edge bg-risk-med-tint px-6 py-3 flex items-center gap-3 font-ui text-ui text-risk-med">
      <AlertOctagon className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>
        This review was interrupted before it finished — {done} of {total} clauses were reviewed. It will not
        resume on its own; use Retry on any stalled clause below to continue.
      </span>
    </div>
  );
}

export function RunEmptyFindingsBanner({ run }: { run: ReviewRun }) {
  const noContent = countNoContent(run);
  const { total } = runProgress(run);
  if (noContent === 0) return null;

  return (
    <div className="shrink-0 border-b border-risk-med-edge bg-risk-med-tint px-6 py-3 flex items-center gap-3 font-ui text-ui text-risk-med">
      <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span>{noContent} of {total} clauses returned no content from the model.</span>
    </div>
  );
}
