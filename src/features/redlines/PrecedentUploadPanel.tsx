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
      <div className="border border-dashed border-rule rounded-card p-4 flex flex-wrap items-center justify-between gap-3 bg-card">
        <div>
          {/* No heading and no storage promise here. `PrecedentIntake`, which
              renders directly below this panel, already states both — and it
              stated the promise in DIFFERENT words ("Not stored with the
              playbook" against this panel's "never stored"). Two wordings of
              the same guarantee is how a promise quietly weakens: a reader
              cannot tell whether the difference is careless or deliberate,
              and the narrower phrasing reads as leaving room for storage
              somewhere else. The guarantee is that a precedent document is
              never persisted anywhere, so it is said once, in the strong
              form, by the screen that owns the header. */}
          <p className="font-ui text-meta text-ink-3">
            Marked-up .docx files are read for tracked changes; anything else, including PDFs, can be
            compared against another version instead.
          </p>
        </div>
        <label
          className={`shrink-0 px-3 py-2 rounded-control font-ui text-button font-semibold ${
            busy
              ? 'bg-chip-fill text-ink-4 cursor-not-allowed'
              : 'bg-accent text-page hover:bg-accent-strong cursor-pointer'
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
