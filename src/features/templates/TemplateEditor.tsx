import React from 'react';
import { Cpu, FileOutput, ShieldAlert, Plus, ChevronUp, ChevronDown, X, Save, Download, Copy, Settings } from 'lucide-react';
import type { PlaybookDraft } from '../../types';
import { AutoResizeTextarea } from '../../components/AutoResizeTextarea';

export interface TemplateEditorProps {
  /** The working copy. A playbook's published content is immutable, so what
   *  this edits is always a draft — Task 9 replaces these props with the
   *  full version/draft/publish set. */
  template: PlaybookDraft;
  onChange: (t: PlaybookDraft) => void;
  onSave: () => void;
  onExport: () => void;
  onShowMegaPrompt: () => void;
  onClose: () => void;
}

export function TemplateEditor({ template, onChange, onSave, onExport, onShowMegaPrompt, onClose }: TemplateEditorProps) {

  const moveClause = (index: number, direction: 'up' | 'down') => {
    const newClauses = [...template.clauses];
    if (direction === 'up' && index > 0) {
      [newClauses[index], newClauses[index - 1]] = [newClauses[index - 1], newClauses[index]];
    } else if (direction === 'down' && index < newClauses.length - 1) {
      [newClauses[index], newClauses[index + 1]] = [newClauses[index + 1], newClauses[index]];
    }
    onChange({ ...template, clauses: newClauses });
  };

  const addClause = () => {
    onChange({
      ...template,
      clauses: [...template.clauses, { id: Date.now().toString(), title: 'New Clause', extractPrompt: 'Instruction...', riskCriteria: '' }],
    });
  };

  const deleteClause = (index: number) => {
    const newClauses = template.clauses.filter((_, i) => i !== index);
    onChange({ ...template, clauses: newClauses });
  };

  const updateClause = (index: number, field: 'title' | 'extractPrompt' | 'riskCriteria', value: string) => {
    const newClauses = template.clauses.map((c, i) =>
      i === index ? { ...c, [field]: value } : c
    );
    onChange({ ...template, clauses: newClauses });
  };

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-64px)] flex flex-col bg-[#09090b]">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
        <div className="flex items-center gap-4 w-full md:w-auto">
          <input
            value={template.name}
            onChange={(e) => onChange({ ...template, name: e.target.value })}
            className="text-2xl font-bold bg-transparent text-white border-b border-transparent hover:border-white/20 focus:border-violet-500 outline-none px-1 w-full md:w-auto"
          />
        </div>

        <div className="flex flex-wrap gap-2 md:gap-3 w-full md:w-auto justify-end items-center">
          {/* Saving publishes a version, and every version after the first
              has to say what changed — a version history whose entries do
              not is a list of dates. `publishVersion` enforces that and
              throws a specific message if this is left empty; this is the
              field that lets the user satisfy it. Task 9 replaces it with a
              proper publish dialog that knows the next version number. */}
          <input
            value={template.changeSummary}
            onChange={(e) => onChange({ ...template, changeSummary: e.target.value })}
            placeholder="What changed? (required after v1)"
            aria-label="What changed?"
            className="px-3 py-2 rounded-lg bg-black/50 border border-white/10 text-xs md:text-sm text-gray-300 outline-none focus:border-violet-500 w-full md:w-64"
          />
          <button onClick={onShowMegaPrompt} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 transition-colors border border-blue-500/30 text-xs md:text-sm"><Copy className="h-4 w-4" /> DIY Mode</button>
          <button onClick={onExport} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/5 text-gray-300 hover:bg-white/10 transition-colors border border-white/10 text-xs md:text-sm"><Download className="h-4 w-4" /> Export</button>
          <button onClick={onSave} className="flex items-center gap-2 px-5 py-2 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition-colors border border-green-500/30 text-xs md:text-sm font-bold"><Save className="h-4 w-4" /> Save</button>
          <button onClick={onClose} className="text-gray-500 hover:text-white px-2">Close</button>
        </div>
      </div>

      {/* Grid Layout */}
      <div className="flex-1 overflow-hidden grid grid-cols-1 lg:grid-cols-3 gap-6 pb-2">
        {/* Left Column: Global Settings */}
        <div className="space-y-6 overflow-y-auto pr-2 custom-scrollbar">
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><Cpu className="h-4 w-4" /> System Persona</label>
            <AutoResizeTextarea
              value={template.systemPrompt}
              onChange={(e) => onChange({ ...template, systemPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          <div className="bg-[#111] border border-white/10 rounded-xl p-5 shadow-lg">
            <label className="block text-sm font-medium text-gray-400 mb-2 flex items-center gap-2"><FileOutput className="h-4 w-4" /> Format & Rules</label>
            <AutoResizeTextarea
              value={template.formatPrompt}
              onChange={(e) => onChange({ ...template, formatPrompt: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-sm text-gray-300 focus:border-violet-500 outline-none min-h-[120px]"
            />
          </div>
          {/* R-D1: always visible. The Standard/Risk toggle that used to hide
              this is gone, and what decides whether a review assesses risk is
              now whether this field (or a clause's own criteria) has anything
              in it — so a hidden field would be a hidden decision. */}
          <div className="bg-red-900/10 border border-red-500/30 rounded-xl p-5">
            <label className="block text-sm font-medium text-red-300 mb-2 flex items-center gap-2"><ShieldAlert className="h-4 w-4" /> Global Risk Tolerance</label>
            <AutoResizeTextarea
              value={template.riskTolerance || ''}
              onChange={(e) => onChange({ ...template, riskTolerance: e.target.value })}
              placeholder="e.g. We are risk-averse regarding uncapped liability..."
              className="w-full bg-black/50 border border-red-500/20 rounded-lg p-3 text-sm text-gray-300 focus:border-red-500 outline-none min-h-[100px]"
            />
            <p className="mt-2 text-[11px] text-gray-500">
              Applies to every clause that has no criteria of its own. Leave it empty and no risk criteria are sent at all.
            </p>
          </div>
        </div>

        {/* Right Column: Clauses (Spans 2 cols on large screens) */}
        <div className="lg:col-span-2 flex flex-col h-full bg-[#111] border border-white/10 rounded-xl overflow-hidden shadow-lg">
          <div className="p-4 border-b border-white/10 bg-[#161616] flex justify-between items-center shrink-0">
            <h3 className="text-lg font-semibold text-white flex items-center gap-2"><Settings className="h-4 w-4 text-violet-500" /> Extraction Clauses ({template.clauses.length})</h3>
            <button onClick={addClause} className="text-xs flex items-center gap-1 bg-violet-600 px-3 py-1.5 rounded hover:bg-violet-500 text-white transition-colors font-medium"><Plus className="h-3 w-3" /> Add Clause</button>
          </div>

          <div className="flex-1 overflow-y-auto p-4 space-y-4 custom-scrollbar">
            {template.clauses.map((clause, idx) => (
              <div key={clause.id} className={`group relative p-0.5 rounded-xl bg-gradient-to-r transition-all duration-300 from-white/5 to-white/10`}>
                <div className="bg-[#0a0a0a] p-4 rounded-[10px] flex flex-col md:flex-row gap-4 items-start relative border border-white/5">
                  {/* Reordering Controls */}
                  <div className="flex flex-col items-center gap-1 pt-1 md:border-r md:border-white/10 md:pr-4">
                    <button onClick={() => moveClause(idx, 'up')} disabled={idx === 0} className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"><ChevronUp className="h-4 w-4" /></button>
                    <span className="text-[10px] text-gray-600 font-mono font-bold">{idx + 1}</span>
                    <button onClick={() => moveClause(idx, 'down')} disabled={idx === template.clauses.length - 1} className="p-1 rounded hover:bg-white/10 text-gray-500 hover:text-white transition-colors disabled:opacity-30"><ChevronDown className="h-4 w-4" /></button>
                  </div>

                  {/* Content */}
                  <div className="flex-1 w-full space-y-3">
                    <div className="flex justify-between items-start">
                      <input
                        value={clause.title}
                        onChange={(e) => updateClause(idx, 'title', e.target.value)}
                        className="bg-transparent font-bold text-white outline-none w-[90%] focus:text-violet-400 transition-colors text-sm md:text-base border-b border-transparent focus:border-violet-500/50"
                        placeholder="Clause Title"
                      />
                      <button onClick={() => deleteClause(idx)} className="text-gray-600 hover:text-red-400 transition-colors p-1 opacity-0 group-hover:opacity-100"><X className="h-4 w-4" /></button>
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 uppercase tracking-wider font-bold mb-1 block">Extraction Instruction</label>
                      <AutoResizeTextarea
                        value={clause.extractPrompt}
                        onChange={(e) => updateClause(idx, 'extractPrompt', e.target.value)}
                        className="w-full bg-white/5 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:ring-1 focus:ring-violet-500/50 border border-transparent focus:border-violet-500/30"
                        placeholder="What to extract..."
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-red-400 uppercase tracking-wider flex items-center gap-1 font-bold mb-1"><ShieldAlert className="h-3 w-3" /> Risk Scorer</label>
                      <AutoResizeTextarea
                        value={clause.riskCriteria || ''}
                        onChange={(e) => updateClause(idx, 'riskCriteria', e.target.value)}
                        className="w-full bg-red-900/10 border border-red-500/10 rounded-md p-2 text-xs text-gray-300 outline-none min-h-[50px] focus:border-red-500/50"
                        placeholder="Specific criteria (e.g., 'Must be mutual'). Leave blank to use Global Risk."
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
            {template.clauses.length === 0 && <div className="text-center text-gray-500 py-10 border border-dashed border-white/10 rounded-xl">No clauses defined. Add one to get started.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
