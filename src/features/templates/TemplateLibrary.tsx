import React, { useRef, useState } from 'react';
import { Play, Plus, Trash2, Upload, Loader } from 'lucide-react';
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
    <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto">
      <div className="flex justify-between items-end mb-8">
        <div>
          <h2 className="text-3xl font-bold text-white mb-2">Playbooks</h2>
          <p className="text-gray-400">Manage your contract review templates.</p>
        </div>
        <div className="flex gap-4">
          <input type="file" accept=".json" ref={fileInputRef} onChange={handleFileChange} className="hidden" />
          <Button variant="ghost" onClick={handleImportClick} disabled={importing}>
            {importing ? <Loader className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Import
          </Button>
          <Button onClick={onCreate}><Plus className="w-4 h-4" /> Create Template</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {templates.map(t => (
          <div key={t.id} className="group relative bg-[#1a1a1a] border border-white/10 rounded-xl hover:border-violet-500/50 transition-colors shadow-lg flex flex-col">
            <div className="p-5 flex-1 flex flex-col cursor-pointer" onClick={() => onOpen(t)}>
              <h3 className="font-bold text-white text-lg truncate pr-8 mb-2">{t.name}</h3>
              <p className="text-xs text-gray-500 mb-4 line-clamp-2 min-h-[32px]">
                {t.draft
                  ? 'Unpublished changes'
                  : t.currentVersionId
                    ? `Updated ${new Date(t.updatedAt).toLocaleDateString()}`
                    : 'Not published yet'}
              </p>

              <div className="mt-auto flex gap-2">
                <button className="flex-1 py-2 bg-white/5 rounded text-xs text-gray-300 hover:bg-white/10 font-medium">Edit</button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRun(t); }}
                  className="flex-1 py-2 bg-violet-600/20 text-violet-300 rounded text-xs hover:bg-violet-600/30 font-bold flex items-center justify-center gap-2 z-10"
                >
                  <Play className="w-3 h-3" /> Run
                </button>
              </div>
            </div>

            <button
              onClick={(e) => { e.stopPropagation(); setDeleteId(t.id); }}
              className="absolute top-3 right-3 p-2 bg-[#222] border border-white/10 text-gray-400 hover:text-red-400 hover:bg-red-900/20 hover:border-red-500/50 rounded-lg transition-all shadow-md z-30"
              title="Delete Template"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
        {templates.length === 0 && (
          <div className="col-span-full text-gray-500 border border-dashed border-white/10 p-8 rounded-xl text-center">
            No templates yet. Create one to get started.
          </div>
        )}
      </div>

      <Modal
        isOpen={deleteId !== null}
        title="Delete Template"
        onClose={() => setDeleteId(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Confirm</Button>
          </>
        }
      >
        <p className="text-sm text-gray-400 leading-relaxed">
          Are you sure you want to permanently delete this template? This action cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
