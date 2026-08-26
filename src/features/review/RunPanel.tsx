import React, { useState } from 'react';
import { Upload, X, Play, FileWarning, CircleSlash } from 'lucide-react';
import type { DocumentFile, ReviewRun, Template } from '../../types';
import { parseFiles } from '../../lib/documents';
import { Button } from '../../components/Button';
import { runProgress } from './runReview';

export interface RunPanelProps {
  template: Template;
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
      <div className="w-full bg-[#1a1a1a] border border-white/10 rounded-2xl p-8 shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold text-white">Run review: {template.name}</h2>
          <button onClick={onBack} className="text-xs text-gray-500 hover:text-white">Cancel</button>
        </div>

        <div className="border-2 border-dashed border-white/10 rounded-xl p-10 text-center mb-6 hover:bg-white/5 transition-colors relative bg-[#111]">
          <input
            type="file"
            multiple
            onChange={(e) => { void handleFiles(e.target.files); e.target.value = ''; }}
            className="absolute inset-0 opacity-0 cursor-pointer"
            aria-label="Upload documents"
          />
          <Upload className="w-8 h-8 text-gray-500 mx-auto mb-2" />
          <p className="text-sm text-gray-400">{parsing ? 'Reading files…' : 'Drag files here or click to upload'}</p>
          <p className="text-xs text-gray-600 mt-2">Supports PDF, DOCX, TXT</p>
        </div>

        {documents.length > 0 && (
          <div className="mb-6 space-y-2 max-h-48 overflow-y-auto">
            {documents.map(d => (
              <div key={d.id} className="flex items-center justify-between gap-3 text-xs text-gray-300 bg-white/5 p-2 rounded border border-white/5">
                <span className="truncate flex items-center gap-2 min-w-0">
                  {d.parseError && <FileWarning className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                  <span className="truncate">{d.name}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  {d.parseError ? (
                    <span className="text-red-400 max-w-[12rem] truncate" title={d.parseError}>{d.parseError}</span>
                  ) : (
                    <span className="opacity-50">Ready</span>
                  )}
                  <button
                    onClick={() => removeDocument(d.id)}
                    className="text-gray-500 hover:text-white"
                    aria-label={`Remove ${d.name}`}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-gray-500 mb-3 text-center">
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
    <div className="shrink-0 border-b border-white/10 bg-[#111] px-6 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex justify-between text-xs text-gray-400 mb-1.5">
          <span>Reviewing… {done} of {total} clauses</span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 bg-white/10 rounded-full overflow-hidden">
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${pct}%` }} />
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
    <div className="shrink-0 border-b border-white/10 bg-[#111] px-6 py-3 flex items-center gap-3 text-sm text-gray-400">
      <CircleSlash className="w-4 h-4 shrink-0" />
      <span>Run cancelled — {done} of {total} clauses were reviewed before it stopped.</span>
    </div>
  );
}
