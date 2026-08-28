import React, { useState } from 'react';
import { Plus, Trash2, Briefcase } from 'lucide-react';
import type { Matter } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

export interface MattersListItem {
  matter: Matter;
  /** Number of reviews recorded against this matter. `undefined` means the
   *  count could not be determined (e.g. the reviews repository is not
   *  available yet) — rendered as omitted rather than as "0", since those
   *  two things mean different things to a user deciding whether it's safe
   *  to delete a matter. */
  reviewCount?: number;
}

export interface CreateMatterParams {
  name: string;
  client?: string;
}

export interface MattersListProps {
  matters: MattersListItem[];
  onCreate: (params: CreateMatterParams) => void;
  onDelete: (id: string) => void;
  /** Opens the matter home screen for a row (Task 11). Optional so this
   *  component still renders sensibly if a future caller genuinely has no
   *  destination to send it to; the app itself always supplies one. */
  onOpen?: (id: string) => void;
}

export interface DeleteMatterModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Shared confirmation copy for permanently deleting a matter — used here
 *  and by `MatterHome` (Task 11), so the cascade warning can't drift
 *  between the two places a matter can be deleted from. */
export function DeleteMatterModal({ isOpen, onClose, onConfirm }: DeleteMatterModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      title="Delete Matter"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>Confirm</Button>
        </>
      }
    >
      <p className="text-sm text-ink-3 leading-relaxed">
        Are you sure you want to permanently delete this matter? This will also delete all of
        its documents and reviews. This action cannot be undone.
      </p>
    </Modal>
  );
}

function formatLastActivity(updatedAt: number): string {
  return new Date(updatedAt).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** The app's entry point: every matter the user has, most recently active
 *  first (that ordering comes from `listMatters()`; this component does not
 *  re-sort). Create via a modal; delete via the existing confirmation
 *  pattern used by the playbook library, with wording specific to a
 *  matter's cascade (Task 6: deleting a matter deletes its documents and
 *  their stored bytes, not just the index entry — a user must learn that
 *  before confirming, not after). */
export function MattersList({ matters, onCreate, onDelete, onOpen }: MattersListProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [client, setClient] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const canSubmit = name.trim() !== '';

  const closeCreate = () => {
    setCreateOpen(false);
    setName('');
    setClient('');
  };

  const handleCreate = () => {
    if (!canSubmit) return;
    onCreate({ name: name.trim(), client: client.trim() || undefined });
    closeCreate();
  };

  const confirmDelete = () => {
    if (deleteId) {
      onDelete(deleteId);
      setDeleteId(null);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h2 className="font-prose text-screen-title text-ink-1 mb-2">Matters</h2>
          <p className="text-ink-3">Every matter's documents and reviews, kept together.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New Matter</Button>
      </div>

      <div className="flex flex-col gap-3">
        {matters.map(({ matter, reviewCount }) => (
          <div
            key={matter.id}
            role={onOpen ? 'button' : undefined}
            tabIndex={onOpen ? 0 : undefined}
            onClick={() => onOpen?.(matter.id)}
            onKeyDown={(e) => {
              if (onOpen && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onOpen(matter.id); }
            }}
            className={`group relative flex items-center gap-4 bg-card border border-rule rounded-card px-5 py-4 hover:border-accent-edge transition-colors ${onOpen ? 'cursor-pointer' : ''}`}
          >
            <div className="w-10 h-10 rounded-card bg-accent-tint text-accent flex items-center justify-center shrink-0">
              <Briefcase className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-prose text-matter-title text-ink-1 truncate">{matter.name}</h3>
              <p className="font-mono text-pin text-ink-4 truncate">
                {matter.client && <span>{matter.client}</span>}
                {matter.client && ' · '}
                {reviewCount !== undefined && (
                  <span>{reviewCount} {reviewCount === 1 ? 'review' : 'reviews'}</span>
                )}
                {reviewCount !== undefined && ' · '}
                <span>Last activity {formatLastActivity(matter.updatedAt)}</span>
              </p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setDeleteId(matter.id); }}
              className="p-2 bg-paper border border-rule text-ink-4 hover:text-risk-high hover:bg-risk-high-tint hover:border-risk-high-edge rounded-control transition-all shrink-0"
              title="Delete Matter"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {matters.length === 0 && (
          <div className="text-ink-4 border border-dashed border-rule p-8 rounded-card text-center">
            No matters yet. Create one to get started.
          </div>
        )}
      </div>

      <Modal
        isOpen={createOpen}
        title="New Matter"
        onClose={closeCreate}
        footer={
          <>
            <Button variant="ghost" onClick={closeCreate}>Cancel</Button>
            <Button onClick={handleCreate} disabled={!canSubmit}>
              <Plus className="h-4 w-4" /> Create
            </Button>
          </>
        }
      >
        <div>
          <label className="block font-mono text-label text-ink-4 uppercase mb-1">Matter Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Acme Corp — Series B Financing"
            className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
            autoFocus
          />
        </div>
        <div>
          <label className="block font-mono text-label text-ink-4 uppercase mb-1">Client (Optional)</label>
          <input
            value={client}
            onChange={e => setClient(e.target.value)}
            placeholder="e.g. Acme Corp"
            className="w-full bg-paper border border-rule rounded-control p-3 text-ink-1 text-sm outline-none focus:border-accent transition-colors placeholder-ink-5"
          />
        </div>
      </Modal>

      <DeleteMatterModal
        isOpen={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
