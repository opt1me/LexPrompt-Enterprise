import React, { useState, useEffect } from 'react';
import { X, Wand2, PenTool, BarChart3, AlignLeft, Plus, Copy, ToggleLeft, ToggleRight, MessageSquare, Code, Sparkles, Loader, ArrowRightLeft, AlertTriangle } from 'lucide-react';
import { Template } from '../types';

interface CreateTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: any) => void;
  loading: boolean;
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
                <p className="text-[10px] text-gray-500 mt-1.5 px-1 italic">
                  {templateDetail === 'Light-Touch' && "Generates 3-5 key clauses."}
                  {templateDetail === 'Standard' && "Generates 5-8 standard clauses."}
                  {templateDetail === 'Detailed' && "Generates 10-15 comprehensive clauses."}
                </p>
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase mb-2 font-semibold tracking-wider flex items-center gap-2"><AlignLeft className="h-3 w-3" /> Output Verbosity</label>
                <div className="flex bg-black/50 border border-white/10 rounded-lg p-1">
                  {['Concise', 'Standard', 'Lengthy'].map((level) => (
                    <button key={level} onClick={() => setOutputDetail(level)} className={`flex-1 py-1.5 text-[10px] sm:text-xs font-medium rounded-md transition-all ${outputDetail === level ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>{level}</button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-gray-500 uppercase mb-1 font-semibold tracking-wider">Context (Optional)</label>
                <textarea value={context} onChange={e => setContext(e.target.value)} placeholder="e.g. Focus on strict liability caps..." className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 transition-colors resize-none h-20 placeholder-gray-600" />
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
          <button onClick={handleGenerate} disabled={loading || (mode === 'ai' && !contractType) || (mode === 'manual' && !templateName)} className={`flex items-center gap-2 px-6 py-2 rounded-lg text-white transition-colors font-bold text-sm shadow-lg ${loading ? 'bg-gray-700 cursor-not-allowed' : mode === 'ai' ? 'bg-violet-600 hover:bg-violet-500 hover:shadow-violet-500/20' : 'bg-white/10 hover:bg-white/20'}`}>
            {loading ? <Loader className="animate-spin h-4 w-4" /> : (mode === 'ai' ? <><Wand2 className="h-4 w-4" /> Generate (25c)</> : <><Plus className="h-4 w-4" /> Create</>)}
          </button>
        </div>
      </div>
    </div>
  );
};

interface MegaPromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  template?: Template;
}

export const MegaPromptModal: React.FC<MegaPromptModalProps> = ({ isOpen, onClose, template }) => {
  const [promptText, setPromptText] = useState("");
  const [format, setFormat] = useState<'copilot' | 'json'>('copilot');
  const [includeRisk, setIncludeRisk] = useState(true);

  useEffect(() => {
    if (!template || !isOpen) return;

    const clauses = template.clauses || [];
    const riskTolerance = template.riskTolerance || "Use standard commercial risk judgment.";

    const clauseListStr = clauses.map((c, i) => {
      let str = `${i + 1}. **${c.title}**`;
      str += `\n   - Instruction: ${c.prompt}`;
      if (includeRisk && c.riskCriteria) {
        str += `\n   - Risk Criteria: ${c.riskCriteria}`;
      }
      return str;
    }).join("\n\n");

    let generated = "";

    if (format === 'copilot') {
      generated = `
# ROLE
${template.systemPrompt}

# TASK
I will upload one or more contract documents. You must review them against the rules below.

# EXTRACTION RULES
${template.formatPrompt}

${includeRisk ? `# RISK ASSESSMENT RULES\n- Assess risk based on: "${riskTolerance}"\n- Flag specific clauses as High/Medium/Low risk.` : '# RISK ASSESSMENT\n- Risk reporting is DISABLED.'}

# CLAUSES TO REVIEW
${clauseListStr}

# OUTPUT FORMAT
Please provide a clear, structured report.
${includeRisk ? 'Include: Clause Name, Summary, Verbatim Quote, Risk Level, Risk Analysis.' : 'Include: Clause Name, Summary, Verbatim Quote.'}

# INSTRUCTIONS
Acknowledge this prompt and tell me when you are ready.
      `.trim();
    } else {
      const jsonStructure = {
        role: template.systemPrompt,
        task: "Extract and analyze contract clauses.",
        clauses: clauses.map(c => ({
          title: c.title,
          instruction: c.prompt,
          ...(includeRisk ? { risk_criteria: c.riskCriteria || "Use global tolerance" } : {})
        }))
      };
      generated = `
*** SYSTEM PROMPT ***
You are a JSON-only API. 
${JSON.stringify(jsonStructure, null, 2)}
      `.trim();
    }
    setPromptText(generated);
  }, [template, format, includeRisk, isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col h-[85vh]">
        <div className="flex justify-between items-center p-4 border-b border-white/10 bg-[#222]">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">DIY Prompt Builder</h3>
          <div className="flex items-center gap-3 bg-black/40 p-1 rounded-lg border border-white/5">
             <div className="flex rounded-md overflow-hidden">
                <button onClick={() => setFormat('copilot')} className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 ${format === 'copilot' ? 'bg-violet-600 text-white' : 'text-gray-400'}`}><MessageSquare className="h-3 w-3" /> CoPilot</button>
                <button onClick={() => setFormat('json')} className={`px-3 py-1.5 text-xs font-medium flex items-center gap-1 ${format === 'json' ? 'bg-blue-600 text-white' : 'text-gray-400'}`}><Code className="h-3 w-3" /> JSON API</button>
             </div>
             <button onClick={() => setIncludeRisk(!includeRisk)} className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1 ${includeRisk ? 'bg-red-500/20 text-red-300' : 'text-gray-400'}`}>{includeRisk ? <ToggleRight className="h-3 w-3"/> : <ToggleLeft className="h-3 w-3"/>} Risk</button>
          </div>
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

interface ModifyTemplateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onModify: (instruction: string) => void;
  loading: boolean;
}

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
           <p className="text-xs text-gray-400">Describe how you want to change the template (e.g., "Add GDPR clauses", "Remove financial terms").</p>
           <textarea value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="Instruction..." className="w-full bg-black/50 border border-white/10 rounded-lg p-3 text-white text-sm outline-none focus:border-violet-500 h-24 resize-none" />
        </div>
        <div className="p-4 border-t border-white/10 flex justify-end gap-3 bg-[#222]">
           <button onClick={onClose} className="px-4 py-2 rounded-lg text-gray-400 hover:text-white text-sm">Cancel</button>
           <button onClick={() => onModify(instruction)} disabled={loading || !instruction} className="flex items-center gap-2 px-6 py-2 rounded-lg bg-violet-600 text-white font-bold text-sm hover:bg-violet-500 disabled:opacity-50">{loading ? <Loader className="animate-spin h-4 w-4"/> : "Update (10c)"}</button>
        </div>
      </div>
    </div>
  );
};

interface RevisionModalProps {
    isOpen: boolean;
    onClose: () => void;
    data: { title: string; original: string; revised: string } | null;
}

export const RevisionModal: React.FC<RevisionModalProps> = ({ isOpen, onClose, data }) => {
    if (!isOpen || !data) return null;
    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur p-4">
            <div className="bg-[#1a1a1a] border border-white/10 w-full max-w-5xl h-[80vh] rounded-2xl flex flex-col shadow-2xl animate-in zoom-in-95 duration-200">
                <div className="p-4 border-b border-white/10 flex justify-between items-center bg-[#222]">
                    <h3 className="font-bold text-white flex items-center gap-2"><ArrowRightLeft className="h-5 w-5 text-violet-500" /> Revision Comparison: {data.title}</h3>
                    <button onClick={onClose}><X className="h-5 w-5 text-gray-400 hover:text-white" /></button>
                </div>
                <div className="flex-1 grid grid-cols-1 md:grid-cols-2 divide-x divide-white/10 overflow-hidden">
                    <div className="p-6 overflow-y-auto bg-red-900/5">
                        <span className="text-xs font-bold text-red-400 uppercase mb-4 block tracking-wider">Original Text</span>
                        <p className="text-gray-300 whitespace-pre-wrap font-serif text-sm leading-relaxed">{data.original}</p>
                    </div>
                    <div className="p-6 overflow-y-auto bg-green-900/5">
                        <span className="text-xs font-bold text-green-400 uppercase mb-4 block tracking-wider flex items-center gap-2"><Sparkles className="h-3 w-3"/> AI Suggestion</span>
                        <p className="text-gray-300 whitespace-pre-wrap font-serif text-sm leading-relaxed">{data.revised}</p>
                    </div>
                </div>
                <div className="p-4 border-t border-white/10 bg-[#222] flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-gray-400 hover:text-white text-sm">Close</button>
                    <button onClick={() => navigator.clipboard.writeText(data.revised)} className="px-4 py-2 bg-violet-600 hover:bg-violet-500 text-white rounded-lg text-sm font-medium shadow-lg">Copy New Clause</button>
                </div>
            </div>
        </div>
    );
};

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
}

export const ConfirmationModal: React.FC<ConfirmationModalProps> = ({ isOpen, onClose, onConfirm, title, message }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#1a1a1a] border border-white/10 rounded-xl w-full max-w-sm shadow-2xl animate-in fade-in zoom-in-95">
        <div className="p-5">
           <div className="w-10 h-10 bg-red-900/20 rounded-full flex items-center justify-center mb-4">
             <AlertTriangle className="w-5 h-5 text-red-500" />
           </div>
           <h3 className="text-lg font-bold text-white mb-2">{title}</h3>
           <p className="text-sm text-gray-400 leading-relaxed">{message}</p>
        </div>
        <div className="p-4 border-t border-white/10 bg-[#222] flex justify-end gap-3 rounded-b-xl">
           <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-colors">Cancel</button>
           <button onClick={() => { onConfirm(); onClose(); }} className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium shadow-lg transition-colors">Confirm</button>
        </div>
      </div>
    </div>
  );
};