
import React, { useState, useEffect } from 'react';
import { X, Wand2, PenTool, BarChart3, AlignLeft, Plus, Copy, ToggleLeft, ToggleRight, MessageSquare, Code, Sparkles, Loader, ArrowRightLeft, AlertTriangle, Key, ShieldCheck } from 'lucide-react';
import { Template, ProviderKeys, ResidencySettings } from '../types';
import { getRegionLabel, loadAuditEvents } from '../services/residencyService';

interface CreateTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: any) => void;
  loading: boolean;
}

// Added missing interface for MegaPromptModalProps to fix line 162 error
interface MegaPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  template?: Template;
}

// Added missing interface for ModifyTemplateModalProps to fix line 196 error
interface ModifyTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onModify: (instruction: string) => void;
  loading: boolean;
}

// Added missing interface for RevisionModalProps to fix line 218 error
interface RevisionModalProps {
  isOpen: boolean;
  onClose: () => void;
  data: {
    title: string;
    original: string;
    revised: string;
  } | null;
}

// Added missing interface for ConfirmationModalProps to fix line 240 error
interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
}

export const CreateTemplateModal: React.FC<CreateTemplateModalProps> = ({ isOpen, onClose, onCreate, loading }) => {
  const [mode, setMode] = useState<'ai' | 'manual'>('ai');
  const [contractType, setContractType] = useState('');
  const [context, setContext] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateDetail, setTemplateDetail] = useState('Standard');
  const [outputDetail, setOutputDetail] = useState('Standard');

  if (!isOpen) return null;

  const handleGenerate = () => {
    if (mode === 'ai' && !contractType) return;
    if (mode === 'manual' && !templateName) return;

    if (mode === 'ai') {
      onCreate({ type: 'ai', contractType, context, templateDetail, outputDetail });
    } else {
      onCreate({ type: 'manual', templateName });
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-md shadow-2xl flex flex-col overflow-hidden animate-fade-in-up">
        <div className="p-4 border-b border-white/10 flex justify-between items-center bg-[#222]">
          <h3 className="text-lg font-bold text-white">Create New Template</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex border-b border-white/10">
          <button onClick={() => setMode('ai')} className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${mode === 'ai' ? 'bg-violet-600/10 text-violet-400 border-b-2 border-violet-500' : 'text-gray-400 hover:bg-white/5'}`}><Wand2 className="h-4 w-4" /> AI Generator</button>
          <button onClick={() => setMode('manual')} className={`flex-1 py-3 text-sm font-medium transition-colors flex items-center justify-center gap-2 ${mode === 'manual' ? 'bg-white/5 text-white border-b-2 border-white' : 'text-gray-400 hover:bg-white/5'}`}><PenTool className="h-4 w-4" /> Blank Template</button>
        </div>

        <div className="p-6 space-y-5 bg-[#1a1a1a] overflow-y-auto max-h-[60vh]">
          {mode === 'ai' ? (
            <>
              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Contract Type</label>
                <input value={contractType} onChange={e => setContractType(e.target.value)} placeholder="e.g. SaaS Agreement, NDA, Employment Contract" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors placeholder-gray-600" autoFocus />
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider flex items-center gap-2"><BarChart3 className="h-3 w-3" /> Template Depth</label>
                <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
                  {['Light-Touch', 'Standard', 'Detailed'].map((level) => (
                    <button key={level} onClick={() => setTemplateDetail(level)} className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-md transition-all ${templateDetail === level ? 'bg-violet-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{level}</button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider flex items-center gap-2"><AlignLeft className="h-3 w-3" /> Output Verbosity</label>
                <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
                  {['Concise', 'Standard', 'Lengthy'].map((level) => (
                    <button key={level} onClick={() => setOutputDetail(level)} className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-md transition-all ${outputDetail === level ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{level}</button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div>
              <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Template Name</label>
              <input value={templateName} onChange={e => setTemplateName(e.target.value)} placeholder="e.g. Custom Review Template" className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-white transition-colors placeholder-gray-600" autoFocus />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end gap-3 bg-[#222]">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/5 transition-colors text-sm font-medium">Cancel</button>
          <button onClick={handleGenerate} disabled={loading} className="flex items-center gap-2 px-6 py-2 rounded-lg text-white transition-colors font-bold text-sm shadow-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50">
            {loading ? <Loader className="animate-spin h-4 w-4" /> : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ProviderSettingsModal: React.FC<{
    isOpen: boolean;
    onClose: () => void;
    keys: ProviderKeys;
    onSave: (keys: ProviderKeys) => void;
    residency: ResidencySettings;
    onSaveResidency: (settings: ResidencySettings) => void;
    keyPolicy?: 'platform' | 'byok' | 'hybrid';
}> = ({ isOpen, onClose, keys, onSave, residency, onSaveResidency, keyPolicy = 'hybrid' }) => {
    const [localKeys, setLocalKeys] = useState(keys);
    const [localResidency, setLocalResidency] = useState(residency);
    const [auditPreview, setAuditPreview] = useState(() => loadAuditEvents().slice(0, 5));

    useEffect(() => {
      setLocalKeys(keys);
      setLocalResidency(residency);
      setAuditPreview(loadAuditEvents().slice(0, 5));
    }, [keys, residency, isOpen]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
            <div className="bg-[#111] border border-white/10 rounded-[32px] w-full max-w-lg shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95">
                <div className="p-8 border-b border-white/5 flex justify-between items-center bg-white/5">
                    <div className="space-y-1">
                        <h3 className="text-xl font-black text-white">Engine Settings</h3>
                        <p className="text-xs text-gray-400 font-medium tracking-tight">Configure keys for multi-provider analysis.</p>
                    </div>
                    <button onClick={onClose} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 transition-colors"><X className="h-6 w-6 text-gray-400" /></button>
                </div>

                <div className="p-8 space-y-6">
                    {keyPolicy !== 'hybrid' && (
                        <div className={`rounded-2xl border px-4 py-3 text-xs ${
                            keyPolicy === 'platform'
                                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                                : 'bg-amber-500/10 border-amber-500/30 text-amber-200'
                        }`}>
                            {keyPolicy === 'platform'
                                ? 'Platform-managed AI mode is active. Users do not need to enter personal API keys.'
                                : 'BYOK mode is active. Each user must add their own provider API key before running AI actions.'}
                        </div>
                    )}
                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-violet-400 font-black text-[10px] uppercase tracking-widest"><Key className="w-3.5 h-3.5"/> Google Gemini Key</div>
                        <input 
                            type="password"
                            value={localKeys.google || ''}
                            onChange={e => setLocalKeys({...localKeys, google: e.target.value})}
                            placeholder="Managed by environment (optional)..."
                            className="w-full bg-black/50 border border-white/10 rounded-2xl p-4 text-sm text-white focus:border-violet-500 outline-none transition-all placeholder-gray-700"
                        />
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-emerald-400 font-black text-[10px] uppercase tracking-widest"><Key className="w-3.5 h-3.5"/> OpenAI (GPT-5 family) Key</div>
                        <input 
                            type="password"
                            value={localKeys.openai || ''}
                            onChange={e => setLocalKeys({...localKeys, openai: e.target.value})}
                            placeholder="sk-..."
                            className="w-full bg-black/50 border border-white/10 rounded-2xl p-4 text-sm text-white focus:border-emerald-500 outline-none transition-all placeholder-gray-700"
                        />
                    </div>

                    <div className="space-y-3">
                        <div className="flex items-center gap-2 text-amber-400 font-black text-[10px] uppercase tracking-widest"><Key className="w-3.5 h-3.5"/> Anthropic (Claude 4.5 family) Key</div>
                        <input 
                            type="password"
                            value={localKeys.anthropic || ''}
                            onChange={e => setLocalKeys({...localKeys, anthropic: e.target.value})}
                            placeholder="sk-ant-..."
                            className="w-full bg-black/50 border border-white/10 rounded-2xl p-4 text-sm text-white focus:border-amber-500 outline-none transition-all placeholder-gray-700"
                        />
                    </div>

                    <div className="space-y-3 pt-2 border-t border-white/10">
                        <div className="text-cyan-300 font-black text-[10px] uppercase tracking-widest">Data Residency Policy</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                            <div className="space-y-1">
                                <label className="text-[10px] text-gray-500 font-black uppercase tracking-widest">Primary Region</label>
                                <select
                                    value={localResidency.primaryRegion}
                                    onChange={(e) => setLocalResidency({ ...localResidency, primaryRegion: e.target.value as ResidencySettings['primaryRegion'] })}
                                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white outline-none"
                                >
                                    <option value="uk-london">UK (London)</option>
                                    <option value="eu-frankfurt">EU (Frankfurt)</option>
                                    <option value="eu-ireland">EU (Ireland)</option>
                                </select>
                            </div>
                            <div className="space-y-1">
                                <label className="text-[10px] text-gray-500 font-black uppercase tracking-widest">Fallback Region</label>
                                <select
                                    value={localResidency.fallbackRegion}
                                    onChange={(e) => setLocalResidency({ ...localResidency, fallbackRegion: e.target.value as ResidencySettings['fallbackRegion'] })}
                                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white outline-none"
                                >
                                    <option value="eu-frankfurt">EU (Frankfurt)</option>
                                    <option value="eu-ireland">EU (Ireland)</option>
                                </select>
                            </div>
                            <div className="space-y-1 sm:col-span-2">
                                <label className="text-[10px] text-gray-500 font-black uppercase tracking-widest">Residency Mode</label>
                                <select
                                    value={localResidency.residencyMode}
                                    onChange={(e) => setLocalResidency({ ...localResidency, residencyMode: e.target.value as ResidencySettings['residencyMode'] })}
                                    className="w-full bg-black/50 border border-white/10 rounded-xl p-3 text-xs text-white outline-none"
                                >
                                    <option value="uk_preferred_eu_fallback">UK-only preferred, EU fallback</option>
                                    <option value="strict_uk_only">Strict UK-only</option>
                                    <option value="eu_only">EU-only</option>
                                </select>
                            </div>
                        </div>
                        <div className="flex items-center justify-between bg-black/40 border border-white/10 rounded-xl px-3 py-2">
                            <span className="text-xs text-gray-300">No model training use</span>
                            <button onClick={() => setLocalResidency({ ...localResidency, noTraining: !localResidency.noTraining })} className="text-xs text-cyan-300 font-bold">
                                {localResidency.noTraining ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>
                        <div className="flex items-center justify-between bg-black/40 border border-white/10 rounded-xl px-3 py-2">
                            <span className="text-xs text-gray-300">Minimal provider retention</span>
                            <button onClick={() => setLocalResidency({ ...localResidency, minRetention: !localResidency.minRetention })} className="text-xs text-cyan-300 font-bold">
                                {localResidency.minRetention ? 'Enabled' : 'Disabled'}
                            </button>
                        </div>
                        <div className="text-[11px] text-gray-400">
                            Active Region: <span className="text-emerald-300 font-bold">{getRegionLabel(localResidency.residencyMode === 'strict_uk_only' ? 'uk-london' : localResidency.residencyMode === 'eu_only' ? localResidency.fallbackRegion : localResidency.primaryRegion)}</span>
                        </div>
                        {auditPreview.length > 0 && (
                            <div className="pt-2 border-t border-white/10">
                                <div className="text-[10px] text-gray-500 uppercase tracking-widest font-black mb-2">Residency Audit Preview</div>
                                <div className="space-y-2 max-h-32 overflow-y-auto pr-1">
                                    {auditPreview.map((event) => (
                                        <div key={event.id} className="text-[11px] bg-black/40 border border-white/10 rounded-lg px-2 py-1.5 text-gray-300">
                                            <span className="text-emerald-300 font-bold">{event.region}</span> · {event.provider}/{event.model} · {event.eventType}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="p-8 bg-white/5 border-t border-white/5 flex justify-end gap-3">
                    <button onClick={onClose} className="px-6 py-3 rounded-2xl text-sm font-bold text-gray-400 hover:text-white transition-colors">Discard</button>
                    <button 
                        onClick={() => { onSave(localKeys); onSaveResidency(localResidency); onClose(); }} 
                        className="px-10 py-3 bg-violet-600 hover:bg-violet-500 text-white rounded-2xl text-sm font-black shadow-xl shadow-violet-900/20 transition-all active:scale-95"
                    >
                        Save Configuration
                    </button>
                </div>
            </div>
        </div>
    );
};

export const MegaPromptModal: React.FC<MegaPromptModalProps> = ({ isOpen, onClose, template }) => {
  const [promptText, setPromptText] = useState("");
  const [format, setFormat] = useState<'copilot' | 'json'>('copilot');
  const [includeRisk, setIncludeRisk] = useState(true);

  useEffect(() => {
    if (!template || !isOpen) return;
    const clauses = template.clauses || [];
    const riskTolerance = template.riskTolerance || "Use standard commercial risk judgment.";
    const clauseListStr = clauses.map((c, i) => `${i + 1}. **${c.title}**\n   - Instruction: ${c.prompt}`).join("\n\n");
    let generated = `SYSTEM ROLE: ${template.systemPrompt}\nTASK: Review documents against: \n${clauseListStr}\nGLOBAL RISK: ${riskTolerance}`;
    setPromptText(generated);
  }, [template, format, includeRisk, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col h-[85vh]">
        <div className="flex justify-between items-center p-4 border-b border-white/10 bg-[#222]">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">DIY Prompt Builder</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-4 flex-1 overflow-hidden bg-[#111]">
          <textarea value={promptText} readOnly className="w-full h-full bg-black/50 border border-white/10 rounded-lg p-6 text-sm text-gray-300 font-mono resize-none focus:outline-none" />
        </div>
        <div className="p-4 border-t border-white/10 flex justify-end gap-3 bg-[#222]">
           <button onClick={() => navigator.clipboard.writeText(promptText)} className="flex items-center gap-2 px-6 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors font-medium"><Copy className="h-4 w-4" /> Copy Prompt</button>
        </div>
      </div>
    </div>
  );
};

export const ModifyTemplateModal: React.FC<ModifyTemplateModalProps> = ({ isOpen, onClose, onModify, loading }) => {
  const [instruction, setInstruction] = useState('');
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col">
        <div className="p-4 border-b border-white/10 flex justify-between items-center bg-[#222]">
          <h3 className="text-lg font-bold text-white flex items-center gap-2"><Sparkles className="h-5 w-5 text-violet-400" /> Modify with AI</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white"><X className="h-5 w-5" /></button>
        </div>
        <div className="p-6 space-y-4 bg-[#1a1a1a]">
           <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="e.g. Add liability cap check..." className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 h-24 resize-none" />
        </div>
        <div className="p-4 border-t border-white/10 flex justify-end gap-3 bg-[#222]">
           <button onClick={onClose} className="px-4 py-2 rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
           <button onClick={() => onModify(instruction)} className="flex items-center gap-2 px-6 py-2 rounded-lg bg-violet-600 text-white font-bold text-sm hover:bg-violet-500">Update (10c)</button>
        </div>
      </div>
    </div>
  );
};

export const RevisionModal: React.FC<RevisionModalProps> = ({ isOpen, onClose, data }) => {
    if (!isOpen || !data) return null;
    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur p-4">
            <div className="bg-[#1a1a1a] border border-white/10 w-full max-w-5xl h-[80vh] rounded-2xl flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="p-4 border-b border-white/10 flex justify-between items-center bg-[#222]">
                    <h3 className="font-bold text-white flex items-center gap-2"><ArrowRightLeft className="h-5 w-5 text-violet-500" /> Revision Comparison</h3>
                    <button onClick={onClose}><X className="h-5 w-5 text-gray-400 hover:text-white" /></button>
                </div>
                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 divide-x divide-white/10 overflow-hidden">
                    <div className="p-6 overflow-y-auto"><p className="text-gray-300 text-sm">{data.original}</p></div>
                    <div className="p-6 overflow-y-auto"><p className="text-gray-300 text-sm">{data.revised}</p></div>
                </div>
                <div className="p-4 border-t border-white/10 bg-[#222] flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Close</button>
                    <button onClick={() => navigator.clipboard.writeText(data.revised)} className="px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium">Copy Clause</button>
                </div>
            </div>
        </div>
    );
};

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({ isOpen, onClose, onConfirm, title, message }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-xl w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95">
        <div className="p-5">
           <div className="w-10 h-10 bg-red-900/20 rounded-full flex items-center justify-center mb-4"><AlertTriangle className="w-5 h-5 text-red-500" /></div>
           <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
           <p className="text-sm text-gray-400 leading-relaxed">{message}</p>
        </div>
        <div className="p-4 border-t border-white/10 bg-[#222] flex justify-end gap-3 rounded-b-xl">
           <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white rounded-lg">Cancel</button>
           <button onClick={() => { onConfirm(); onClose(); }} className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg font-medium">Confirm</button>
        </div>
      </div>
    </div>
  );
};
