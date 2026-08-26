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
export function MattersList({ matters, onCreate, onDelete }: MattersListProps) {
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
          <h2 className="text-3xl font-bold text-white mb-2">Matters</h2>
          <p className="text-gray-400">Every matter's documents and reviews, kept together.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New Matter</Button>
      </div>

      <div className="flex flex-col gap-3">
        {matters.map(({ matter, reviewCount }) => (
          <div
            key={matter.id}
            className="group relative flex items-center gap-4 bg-[#1a1a1a] border border-white/10 rounded-xl px-5 py-4 hover:border-violet-500/50 transition-colors shadow-lg"
          >
            <div className="w-10 h-10 rounded-lg bg-violet-600/20 text-violet-300 flex items-center justify-center shrink-0">
              <Briefcase className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-bold text-white text-base truncate">{matter.name}</h3>
              <p className="text-xs text-gray-500 truncate">
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
              className="p-2 bg-[#222] border border-white/10 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/50 rounded-lg transition-all shadow-md shrink-0"
              title="Delete Matter"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {matters.length === 0 && (
          <div className="text-gray-500 border border-dashed border-white/10 p-8 rounded-xl text-center">
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
          <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Matter Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Acme Corp — Series B Financing"
            className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors placeholder-gray-600"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Client (Optional)</label>
          <input
            value={client}
            onChange={e => setClient(e.target.value)}
            placeholder="e.g. Acme Corp"
            className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors placeholder-gray-600"
          />
        </div>
      </Modal>

      <Modal
        isOpen={deleteId !== null}
        title="Delete Matter"
        onClose={() => setDeleteId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Confirm</Button>
          </>
        }
      >
        <p className="text-sm text-gray-400 leading-relaxed">
          Are you sure you want to permanently delete this matter? This will also delete all of
          its documents and reviews. This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
