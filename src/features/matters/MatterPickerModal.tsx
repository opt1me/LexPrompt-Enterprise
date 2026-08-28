import React, { useState } from 'react';
import { Plus, Briefcase, Loader } from 'lucide-react';
import type { Matter } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { LoadErrorPanel } from '../../components/LoadErrorPanel';

export interface MatterPickerModalProps {
  isOpen: boolean;
  /** Name of the playbook being run, for the modal's title. */
  templateName: string;
  matters: Matter[];
  mattersError: string | null;
  onRetryMatters: () => void;
  onClose: () => void;
  /** Runs the review against an existing matter's documents. */
  onPick: (matterId: string) => Promise<void>;
  /** Creates a new matter, then runs the review against it. */
  onCreateAndPick: (params: { name: string; client?: string }) => Promise<void>;
}

/**
 * Important 3: a review run from the Library used to be silently
 * session-only — nothing persisted it, and nothing in the UI or docs said
 * so. Matters are now the top-level object everything else in the app
 * persists against, so a second, invisible, non-persisting path contradicts
 * that. This modal is the fix: running a playbook from the Library now
 * requires picking (or creating) a matter first, exactly like starting a
 * review from Matter Home already does — the two entry points converge on
 * the same matter-scoped run instead of one of them being a trap door.
 */
export function MatterPickerModal({
  isOpen,
  templateName,
  matters,
  mattersError,
  onRetryMatters,
  onClose,
  onPick,
  onCreateAndPick,
}: MatterPickerModalProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [busyMatterId, setBusyMatterId] = useState<string | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);

  const busy = busyMatterId !== null || creatingBusy;

  const reset = () => {
    setCreating(false);
    setName('');
    setClient('');
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  const handlePick = async (matterId: string) => {
    setBusyMatterId(matterId);
    try {
      await onPick(matterId);
    } finally {
      setBusyMatterId(null);
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreatingBusy(true);
    try {
      await onCreateAndPick({ name: name.trim(), client: client.trim() || undefined });
      reset();
    } finally {
      setCreatingBusy(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title={`Run "${templateName}" against a matter`}
      onClose={handleClose}
      footer={<Button variant="ghost" onClick={handleClose} disabled={busy}>Cancel</Button>}
    >
      <p className="font-ui text-meta text-ink-4">
        Reviews are saved to a matter, alongside its documents, so every run — including this one — needs a matter
        to belong to. Choose an existing matter or create a new one.
      </p>

      {mattersError ? (
        <LoadErrorPanel compact message={mattersError} onRetry={onRetryMatters} />
      ) : creating ? (
        <div className="space-y-3">
          <div>
            <label className="block font-mono text-label text-ink-4 uppercase mb-1">
              Matter name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme Corp — Series B Financing"
              autoFocus
              className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
            />
          </div>
          <div>
            <label className="block font-mono text-label text-ink-4 uppercase mb-1">
              Client (optional)
            </label>
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="e.g. Acme Corp"
              className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleCreate} disabled={!name.trim() || busy}>
              {creatingBusy ? <Loader className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Create and run
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)} disabled={busy}>Back</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {matters.length === 0 ? (
            <p className="text-sm text-ink-3">
              No matters yet. Create one below to run this review against it.
            </p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {matters.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handlePick(m.id)}
                  disabled={busy}
                  className="w-full flex items-center gap-3 bg-chip-fill hover:bg-rule-soft border border-rule rounded-control px-3 py-2.5 text-left text-sm text-ink-1 transition-colors disabled:opacity-50"
                >
                  <Briefcase className="w-4 h-4 text-accent shrink-0" />
                  <span className="truncate flex-1">{m.name}</span>
                  {busyMatterId === m.id && (
                    <span data-busy="true" aria-live="polite" className="shrink-0">
                      <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          <Button variant="ghost" onClick={() => setCreating(true)} disabled={busy} className="w-full">
            <Plus className="w-4 h-4" /> New matter
          </Button>
        </div>
      )}
    </Modal>
  );
}
