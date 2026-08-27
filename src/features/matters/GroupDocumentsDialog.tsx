import React, { useEffect, useState } from 'react';
import type { DocumentRecord } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

export interface GroupDocumentsDialogProps {
  isOpen: boolean;
  /** The documents offered to the dialog, in the order the user selected
   *  them on the matter home — that order is what seeds the amendments'
   *  reading order below, since a base can appear anywhere in it and the
   *  rest keep their relative order once it's picked out. */
  documents: DocumentRecord[];
  onClose: () => void;
  onConfirm: (params: { name: string; baseDocumentId: string; variesDocumentIds: string[] }) => Promise<void>;
}

/**
 * Names a new collection, picks its base, and orders its amendments —
 * from a set of standalone documents already selected on the matter home.
 * `documents.length < 2` is enforced by the caller (the `Group as a
 * collection` action only enables once two are selected), but this dialog
 * re-checks it before enabling `Confirm` too, since a prop can change
 * under an already-open dialog if a document disappears mid-session.
 *
 * The base defaults to the first document the user selected — never
 * guessed from filename or date — and stays a single, exclusive radio
 * choice: a collection has exactly one base by definition (`Collection`'s
 * own shape). Everything not chosen as base becomes an amendment, in the
 * SAME relative order `documents` arrived in — this dialog never
 * reorders them itself (no drag, no sort-by-date), matching ruling R-C3's
 * insistence that reading order is a human's explicit choice, not derived.
 */
export function GroupDocumentsDialog({ isOpen, documents, onClose, onConfirm }: GroupDocumentsDialogProps) {
  const [name, setName] = useState('');
  const [baseDocumentId, setBaseDocumentId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reopening for a different selection must not inherit the last one's
  // name or base choice — an amendment attached to the wrong base by a
  // stale radio pick would be a silent, wrong collection.
  useEffect(() => {
    if (isOpen) {
      setName('');
      setBaseDocumentId(documents[0]?.id ?? null);
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const trimmedName = name.trim();
  const canConfirm = documents.length >= 2 && baseDocumentId !== null && trimmedName !== '' && !submitting;

  const handleConfirm = async () => {
    if (!canConfirm || !baseDocumentId) return;
    const variesDocumentIds = documents.filter(d => d.id !== baseDocumentId).map(d => d.id);
    setSubmitting(true);
    try {
      await onConfirm({ name: trimmedName, baseDocumentId, variesDocumentIds });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Group as a collection"
      onClose={() => { if (!submitting) onClose(); }}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {submitting ? 'Creating…' : 'Create collection'}
          </Button>
        </>
      }
    >
      {documents.length < 2 ? (
        <p className="text-sm text-red-400">Select at least two documents to group them into a collection.</p>
      ) : (
        <>
          <div>
            <label className="text-xs text-gray-400 uppercase font-semibold tracking-wider" htmlFor="collection-name">
              Name
            </label>
            <input
              id="collection-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Lease as varied"
              className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-violet-500/50"
            />
          </div>

          <div className="space-y-2">
            <p className="text-xs text-gray-400 uppercase font-semibold tracking-wider">
              Choose the base document — the rest amend it, in this order
            </p>
            <ul className="space-y-1.5">
              {documents.map(doc => (
                <li key={doc.id} className="flex items-center gap-3 bg-white/5 rounded-lg px-3 py-2">
                  <input
                    type="radio"
                    name="base-document"
                    id={`base-${doc.id}`}
                    checked={baseDocumentId === doc.id}
                    onChange={() => setBaseDocumentId(doc.id)}
                    className="shrink-0"
                  />
                  <label htmlFor={`base-${doc.id}`} className="text-sm text-white truncate flex-1 cursor-pointer">
                    {doc.name}
                  </label>
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider shrink-0 bg-white/10 text-gray-300">
                    {baseDocumentId === doc.id ? 'Base' : 'Varies'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Modal>
  );
}
