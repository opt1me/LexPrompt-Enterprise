import React, { useRef, useState } from 'react';
import { Play, Plus, Trash2, Upload } from 'lucide-react';
import type { Playbook } from '../../types';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';

export interface TemplateLibraryProps {
  /** IDENTITY records, not content. A playbook's clauses and prompts live in
   *  its `PlaybookVersion`s now, and handing this component a version would
   *  give it a `id` that is the VERSION's — which `onDelete` would then
   *  delete nothing by. */
  templates: Playbook[];
  onOpen: (template: Playbook) => void;
  onRun: (template: Playbook) => void;
  onDelete: (id: string) => void;
  onCreate: () => void;
  onImport: (file: File) => void;
  importing?: boolean;
}

export function TemplateLibrary({ templates, onOpen, onRun, onDelete, onCreate, onImport, importing = false }: TemplateLibraryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImport(file);
    e.target.value = ''; // reset so the same file can be reselected
  };

  const confirmDelete = () => {
    if (deleteId) {
      onDelete(deleteId);
      setDeleteId(null);
    }
  };

  return (
    <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto bg-paper">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h2 className="font-prose text-screen-title text-ink-1 mb-2">Playbooks</h2>
          <p className="font-ui text-ui text-ink-3">Manage your contract review playbooks.</p>
        </div>
        <div className="flex gap-4">
          <input type="file" accept=".json" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
          <Button variant="ghost" onClick={handleImportClick} disabled={importing} loading={importing}>
            {!importing && <Upload className="w-4 h-4" />}
            Import
          </Button>
          <Button onClick={onCreate}><Plus className="w-4 h-4" /> Create playbook</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {templates.map(t => (
          <div key={t.id} className="group relative bg-card border border-rule rounded-card hover:border-accent-edge transition-colors flex flex-col">
            <div className="p-5 flex-1 flex flex-col cursor-pointer" onClick={() => onOpen(t)}>
              <h3 className="font-prose text-clause font-medium text-ink-1 truncate pr-8 mb-2">{t.name}</h3>
              <p className="font-ui text-meta text-ink-4 mb-4 line-clamp-2 min-h-[32px]">
                {t.draft
                  ? 'Unpublished changes'
                  : t.currentVersionId
                    ? `Updated ${new Date(t.updatedAt).toLocaleDateString()}`
                    : 'Not published yet'}
              </p>

              <div className="mt-auto flex gap-2">
                <button className="flex-1 py-2 bg-chip-fill rounded-control font-ui text-button font-medium text-ink-2 hover:bg-rule-soft">Edit</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRun(t); }}
                  className="flex-1 py-2 bg-accent-tint text-accent rounded-control font-ui text-button font-bold hover:bg-accent/20 flex items-center justify-center gap-2 z-10"
                >
                  <Play className="w-3 h-3" /> Run
                </button>
              </div>
            </div>

            <button
              onClick={(e) => { e.stopPropagation(); setDeleteId(t.id); }}
              className="absolute top-3 right-3 p-2 bg-card border border-rule text-ink-4 hover:text-risk-high hover:bg-risk-high-tint hover:border-risk-high-edge rounded-control transition-colors z-30"
              title="Delete playbook"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="col-span-full font-ui text-ui text-ink-4 border border-dashed border-rule p-8 rounded-card text-center">
            No playbooks yet. Create one to get started.
          </div>
        )}
      </div>

      <Modal
        isOpen={deleteId !== null}
        title="Delete playbook"
        onClose={() => setDeleteId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Confirm</Button>
          </>
        }
      >
        <p className="font-ui text-ui text-ink-3 leading-relaxed">
          Are you sure you want to permanently delete this playbook? This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
