import React, { useState } from 'react';
import { Wand2, PenTool, BarChart3, AlignLeft, Plus, Loader } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import type { Depth, Verbosity } from './generateTemplate';

export type CreateTemplateParams =
  | { type: 'ai'; contractType: string; depth: Depth; verbosity: Verbosity; context?: string }
  | { type: 'manual'; name: string };

export interface CreateTemplateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (params: CreateTemplateParams) => void;
  loading: boolean;
  status: string;
  /** False when no OpenRouter key/model is configured — disables the AI path rather than letting it fail. */
  canGenerate?: boolean;
}

const DEPTHS: Depth[] = ['Light-Touch', 'Standard', 'Detailed'];
const VERBOSITIES: Verbosity[] = ['Concise', 'Standard', 'Lengthy'];

const DEPTH_HINTS: Record<Depth, string> = {
  'Light-Touch': 'Generates a small set of key clauses.',
  Standard: 'Generates a balanced set of standard clauses.',
  Detailed: 'Generates a comprehensive, deep-dive set of clauses.',
};

export function CreateTemplateDialog({ isOpen, onClose, onCreate, loading, status, canGenerate = true }: CreateTemplateDialogProps) {
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [contractType, setContractType] = useState('');
  const [context, setContext] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [depth, setDepth] = useState<Depth>('Standard');
  const [verbosity, setVerbosity] = useState<Verbosity>('Standard');

  const canSubmit = mode === 'ai'
    ? contractType.trim() !== '' && canGenerate
    : templateName.trim() !== '';

  const handleGenerate = () => {
    if (!canSubmit) return;
    if (mode === 'ai') {
      onCreate({ type: 'ai', contractType, depth, verbosity, context: context.trim() || undefined });
    } else {
      onCreate({ type: 'manual', name: templateName });
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      title="Create New Template"
      onClose={onClose}
      footer={
        <div className="w-full flex flex-col gap-4">
          {loading && (
            <div className="flex items-center gap-3 px-2 py-2 bg-violet-600/10 border border-violet-500/20 rounded-lg animate-pulse">
              <Loader className="animate-spin h-4 w-4 text-violet-400" />
              <span className="text-[11px] text-violet-300 font-medium">{status || 'Creating template...'}</span>
            </div>
          )}
          <div className="flex justify-end gap-3">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={loading || !canSubmit} loading={loading}>
              {!loading && (mode === 'ai' ? <><Wand2 className="h-4 w-4" /> Generate</> : <><Plus className="h-4 w-4" /> Create</>)}
              {loading && 'Generating...'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="-mx-6 -mt-6 mb-5 flex border-b border-white/10">
        <button
          onClick={() => setMode('ai')}
          className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${mode === 'ai' ? 'bg-violet-600/10 text-violet-400 border-b-2 border-violet-500' : 'text-gray-400 hover:bg-white/5'}`}
        >
          <Wand2 className="h-4 w-4" /> AI Generator
        </button>
        <button
          onClick={() => setMode('manual')}
          className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${mode === 'manual' ? 'bg-white/5 text-white border-b-2 border-white' : 'text-gray-400 hover:bg-white/5'}`}
        >
          <PenTool className="h-4 w-4" /> Blank Template
        </button>
      </div>

      {mode === 'ai' ? (
        <div className="space-y-5">
          {!canGenerate && (
            <p className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3">
              Add an OpenRouter key in Settings to generate a template with AI.
            </p>
          )}
          <div>
            <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Contract Type</label>
            <input
              value={contractType}
              onChange={e => setContractType(e.target.value)}
              placeholder="e.g. SaaS Agreement, NDA, Employment Contract"
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors placeholder-gray-600"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider flex items-center gap-2"><BarChart3 className="h-3 w-3" /> Template Depth</label>
            <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
              {DEPTHS.map((level) => (
                <button key={level} onClick={() => setDepth(level)} className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-md transition-all ${depth === level ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{level}</button>
              ))}
            </div>
            <p className="text-[10px] text-gray-500 mt-1.5 px-1 italic">{DEPTH_HINTS[depth]}</p>
          </div>

          <div>
            <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider flex items-center gap-2"><AlignLeft className="h-3 w-3" /> Output Verbosity</label>
            <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
              {VERBOSITIES.map((level) => (
                <button key={level} onClick={() => setVerbosity(level)} className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-md transition-all ${verbosity === level ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{level}</button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Context (Optional)</label>
            <textarea
              value={context}
              onChange={e => setContext(e.target.value)}
              placeholder="e.g. Focus on strict liability caps..."
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors resize-none h-20 placeholder-gray-600"
            />
          </div>
        </div>
      ) : (
        <div>
          <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Template Name</label>
          <input
            value={templateName}
            onChange={e => setTemplateName(e.target.value)}
            placeholder="e.g. Custom Review Template"
            className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-white transition-colors placeholder-gray-600"
            autoFocus
          />
        </div>
      )}
    </Modal>
  );
}
