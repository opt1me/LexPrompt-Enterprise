import React, { useRef } from 'react';

/**
 * The file-picker for precedent intake (spec §7). Deliberately its own tiny
 * component, separate from `PrecedentIntake`: that component renders the
 * roles and chains a batch of files produced, not the control that produces
 * the batch — keeping the two apart is what lets `PrecedentIntake`'s
 * existing, already-committed tests stay exactly as they are.
 *
 * Accepts `.docx` (read for tracked changes, `App.tsx`'s
 * `handleAddRedlinesFiles`) and anything else, including `.pdf` — a PDF
 * carries no OOXML markup to read at all, so it can only ever be brought in
 * for the diff fallback (spec §3a, §8), never read for tracked changes.
 *
 * Nothing selected here is ever written anywhere: the caller reads each
 * `File` into memory (never `addDocument`/blob storage) and it is gone the
 * moment the tab closes (spec §4, §11 — "precedent documents are read and
 * never stored").
 */
export interface PrecedentUploadPanelProps {
  onFilesSelected: (files: File[]) => void;
  busy?: boolean;
}

export function PrecedentUploadPanel({ onFilesSelected, busy = false }: PrecedentUploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    // Reset the input's value even when nothing was picked (a cancelled
    // dialog) so re-selecting the SAME file a second time still fires
    // `onChange` — browsers otherwise treat an unchanged value as a no-op.
    if (inputRef.current) inputRef.current.value = '';
    if (files.length > 0) onFilesSelected(files);
  };

  return (
    <div className="max-w-5xl mx-auto px-6 pt-6">
      <div className="border border-dashed border-white/20 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 bg-white/5">
        <div>
          <p className="text-sm text-gray-200 font-semibold">Bring in what you negotiated</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Read once to learn from, never stored. Marked-up .docx files are read for tracked changes; anything
            else, including PDFs, can be compared against another version instead.
          </p>
        </div>
        <label
          className={`shrink-0 px-3 py-2 rounded-md text-sm font-semibold ${
            busy
              ? 'bg-white/10 text-gray-500 cursor-not-allowed'
              : 'bg-violet-600 text-white hover:bg-violet-500 cursor-pointer'
          }`}
        >
          {busy ? 'Reading…' : 'Add documents'}
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".docx,.pdf"
            onChange={handleChange}
            disabled={busy}
            className="hidden"
          />
        </label>
      </div>
    </div>
  );
}
