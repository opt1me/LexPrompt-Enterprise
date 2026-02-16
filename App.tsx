
import React, { useState, useEffect, useRef } from 'react';
import { Template, DocumentFile, AnalysisResult, ProviderKeys } from './types';
import { generateTemplate, analyzeContract, draftEmail, suggestRevision, chatWithDoc, AVAILABLE_MODELS } from './services/aiService';
import { parseFileContent } from './services/docService';
import { ResultsView } from './components/ResultsView';
import { CreateTemplateModal, MegaPromptModal, ModifyTemplateModal, RevisionModal, ConfirmationModal, ProviderSettingsModal } from './components/Modals';
import { TemplateEditor } from './components/TemplateEditor';
import { TabularReview } from './components/TabularReview';
import { FileText, Plus, Upload, Play, Loader, LogOut, Layout, Layers, Users, Trash2, Check, AlertCircle, Table, Coins, Zap, ShieldCheck, Key, Settings2, Sliders } from 'lucide-react';

const mockUser = { uid: 'demo-user', email: 'demo@lexprompt.ai', role: 'reviewer' };
const STORAGE_KEY = 'lexprompt_templates_v3';
const KEYS_STORAGE_KEY = 'lexprompt_api_keys';

const loadTemplates = (): Template[] => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) return JSON.parse(saved);
    } catch (e) { console.error(e); }
    return [
        {
            id: 'demo-1',
            name: 'Enterprise SaaS MSA',
            contractType: 'SaaS',
            mode: 'risk',
            systemPrompt: 'Senior Legal Counsel with 20+ years experience reviewing enterprise contracts.',
            formatPrompt: 'Extract liability, indemnity, and data protection terms.',
            riskTolerance: 'Low - we avoid uncapped liability.',
            clauses: [
                { id: '1', title: 'Indemnity', prompt: 'Review third-party IP indemnity obligations.' },
                { id: '2', title: 'Liability Cap', prompt: 'Is there an aggregate liability cap? If so, what is the amount?' }
            ],
            createdAt: new Date().toISOString(),
            scope: 'private'
        }
    ];
};

const getModelCost = (model: string): number => {
    if (model.includes('o1') || model.includes('pro')) return 50;
    if (model.includes('4o') || model.includes('sonnet') || model.includes('o3')) return 30;
    return 15;
};

export const COSTS = {
    TEMPLATE_GEN: 25,
    CHAT: 1,
    REVISION: 5,
    EMAIL: 2
};

declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    aistudio?: AIStudio;
  }
}

export default function App() {
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [user, setUser] = useState<any>(null);
  const [credits, setCredits] = useState(500);
  const [view, setView] = useState<'dashboard' | 'editor' | 'processor' | 'results' | 'tabular'>('dashboard');
  const [selectedModel, setSelectedModel] = useState(AVAILABLE_MODELS.GEMINI_3_FLASH);
  
  const [templates, setTemplates] = useState<Template[]>(loadTemplates());
  const [activeTemplate, setActiveTemplate] = useState<Template | null>(null);
  const [documents, setDocuments] = useState<DocumentFile[]>([]);
  const [results, setResults] = useState<AnalysisResult[]>([]);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  
  const [loading, setLoading] = useState(false);
  const [notification, setNotification] = useState<{msg: string, type: 'success' | 'error'} | null>(null);
  
  const [apiKeys, setApiKeys] = useState<ProviderKeys>(() => {
      const saved = localStorage.getItem(KEYS_STORAGE_KEY);
      return saved ? JSON.parse(saved) : {};
  });

  // Modals
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [megaPromptOpen, setMegaPromptOpen] = useState(false);
  const [modifyModalOpen, setModifyModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [revisionData, setRevisionData] = useState<{title: string, original: string, revised: string} | null>(null);

  useEffect(() => {
    const checkKey = async () => {
      try {
        const selected = await window.aistudio?.hasSelectedApiKey();
        setHasKey(!!selected || !!apiKeys.google);
      } catch (e) {
        setHasKey(false);
      }
    };
    checkKey();
    const u = sessionStorage.getItem('lexprompt_user');
    if (u) setUser(JSON.parse(u));
  }, [apiKeys]);

  const saveKeys = (newKeys: ProviderKeys) => {
      setApiKeys(newKeys);
      localStorage.setItem(KEYS_STORAGE_KEY, JSON.stringify(newKeys));
      showNotify("Keys updated successfully");
  };

  const showNotify = (msg: string, type: 'success' | 'error' = 'success') => {
      setNotification({ msg, type });
      setTimeout(() => setNotification(null), 3000);
  };

  const handleCreateTemplate = async (params: any) => {
    if (params.type === 'ai' && credits < COSTS.TEMPLATE_GEN) return showNotify("Insufficient credits", 'error');
    setLoading(true);
    try {
      let newT: Partial<Template>;
      if (params.type === 'manual') {
          newT = { name: params.templateName, contractType: 'Custom', mode: 'extraction', systemPrompt: "Expert counsel.", formatPrompt: "Extract accurately.", clauses: [], scope: 'private' };
      } else {
          newT = await generateTemplate(params.contractType, params.templateDetail, params.outputDetail, params.context);
          setCredits(prev => prev - COSTS.TEMPLATE_GEN);
      }
      const finalT: Template = { ...newT as Template, id: Math.random().toString(36).substr(2, 9), name: params.templateName || params.contractType, createdAt: new Date().toISOString() };
      const updated = [...templates, finalT];
      setTemplates(updated);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      setActiveTemplate(finalT);
      setCreateModalOpen(false);
      setView('editor');
    } catch (e: any) { showNotify(e.message || "Failed to create template", 'error'); }
    setLoading(false);
  };

  const handleAnalysis = async () => {
    if (!activeTemplate || documents.length === 0) return;
    const perDocCost = getModelCost(selectedModel);
    const cost = documents.length * perDocCost;
    
    if (credits < cost) return showNotify("Insufficient credits", 'error');
    setLoading(true);
    try {
      const data = await analyzeContract(activeTemplate, documents, selectedModel);
      setCredits(prev => prev - cost);
      const newResult: AnalysisResult = { id: Math.random().toString(), title: "Contract Analysis", data, docIndices: documents.map((_, i) => i), timestamp: new Date(), modelUsed: selectedModel };
      setResults([newResult]);
      setView('results');
      showNotify(`Analysis Complete: ${selectedModel}`);
    } catch (e: any) { showNotify(e.message || "Analysis failed", 'error'); }
    setLoading(false);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setLoading(true);
      const files: DocumentFile[] = [];
      for (const file of Array.from(e.target.files)) {
        files.push(await parseFileContent(file as File));
      }
      setDocuments(files);
      setLoading(false);
      showNotify(`${files.length} documents uploaded`);
    }
  };

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-md p-10 bg-[#111] rounded-[32px] border border-white/10 shadow-2xl">
        <h1 className="text-3xl font-black text-white mb-8 flex items-center gap-3"><Layout className="text-violet-500 w-8 h-8"/> LexPrompt</h1>
        <button onClick={() => { sessionStorage.setItem('lexprompt_user', JSON.stringify(mockUser)); setUser(mockUser); }} className="w-full p-4 bg-violet-600 hover:bg-violet-500 rounded-2xl text-white font-bold transition-all">Enterprise Login</button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#09090b]">
      {notification && (
        <div className={`fixed bottom-8 right-8 px-6 py-3 rounded-2xl shadow-2xl z-[100] flex items-center gap-3 border ${notification.type === 'error' ? 'bg-red-900 border-red-500 text-red-100' : 'bg-violet-900 border-violet-500 text-violet-100'} backdrop-blur-xl animate-in fade-in slide-in-from-bottom-5`}>
            {notification.type === 'error' ? <AlertCircle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
            <span className="font-bold text-sm">{notification.msg}</span>
        </div>
      )}

      <header className="h-16 border-b border-white/10 bg-[#111]/80 backdrop-blur-md flex items-center justify-between px-6 shrink-0 z-50">
        <div className="flex items-center gap-2 cursor-pointer" onClick={() => setView('dashboard')}>
          <div className="w-9 h-9 bg-gradient-to-br from-violet-600 to-indigo-600 rounded-xl flex items-center justify-center text-white"><FileText className="w-5 h-5" /></div>
          <span className="font-black text-xl text-white tracking-tight">LexPrompt</span>
        </div>
        
        <div className="flex items-center gap-6">
          <div className="hidden md:flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/5">
             <Settings2 className="w-4 h-4 text-gray-500" />
             <select 
                value={selectedModel} 
                onChange={(e) => setSelectedModel(e.target.value)}
                className="bg-transparent text-[10px] font-black uppercase tracking-widest text-gray-300 outline-none cursor-pointer"
             >
                <optgroup label="Google Gemini" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.GEMINI_3_FLASH}>Gemini 3 Flash</option>
                    <option value={AVAILABLE_MODELS.GEMINI_3_PRO}>Gemini 3 Pro</option>
                </optgroup>
                <optgroup label="Anthropic Claude" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.CLAUDE_3_7_SONNET}>Claude 3.7 Sonnet</option>
                    <option value={AVAILABLE_MODELS.CLAUDE_3_5_SONNET}>Claude 3.5 Sonnet</option>
                    <option value={AVAILABLE_MODELS.CLAUDE_3_5_HAIKU}>Claude 3.5 Haiku</option>
                </optgroup>
                <optgroup label="OpenAI GPT" className="bg-[#111]">
                    <option value={AVAILABLE_MODELS.GPT_4O}>GPT-4o</option>
                    <option value={AVAILABLE_MODELS.O3_MINI}>O3 Mini</option>
                    <option value={AVAILABLE_MODELS.O1_PREVIEW}>O1 Preview</option>
                </optgroup>
             </select>
          </div>
          <button onClick={() => setSettingsOpen(true)} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 text-gray-400 transition-colors" title="Engine Setup"><Sliders className="w-5 h-5"/></button>
          <div className="flex items-center gap-2 bg-black/40 px-3 py-1.5 rounded-xl border border-white/5">
             <Coins className="w-4 h-4 text-yellow-500" />
             <span className="text-sm font-bold text-white">{credits}</span>
          </div>
          <button onClick={() => setUser(null)} className="text-gray-400 hover:text-white"><LogOut className="w-4 h-4" /></button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        {view === 'dashboard' && (
          <div className="p-8 max-w-7xl mx-auto h-full overflow-y-auto">
            <div className="flex justify-between items-end mb-10">
              <h2 className="text-4xl font-black text-white">Playbooks</h2>
              <button onClick={() => setCreateModalOpen(true)} className="px-6 py-3 bg-violet-600 text-white rounded-2xl flex items-center gap-2 text-sm font-bold"><Plus className="w-5 h-5" /> New Playbook</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {templates.map(t => (
                <div key={t.id} className="bg-[#111] border border-white/10 p-6 rounded-[24px] flex flex-col h-64 hover:border-violet-500/50 transition-all">
                   <h3 className="text-lg font-bold text-white mb-2">{t.name}</h3>
                   <p className="text-xs text-gray-500 mb-6 line-clamp-2">{t.systemPrompt}</p>
                   <div className="mt-auto flex gap-2">
                      <button onClick={() => { setActiveTemplate(t); setView('editor'); }} className="flex-1 py-2 bg-white/5 text-gray-400 rounded-xl text-xs font-bold">Edit</button>
                      <button onClick={() => { setActiveTemplate(t); setView('processor'); }} className="flex-1 py-2 bg-violet-600 text-white rounded-xl text-xs font-bold"><Play className="w-3 h-3 inline mr-1"/> Run</button>
                   </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === 'processor' && activeTemplate && (
          <div className="p-8 max-w-4xl mx-auto h-full flex flex-col justify-center items-center">
             <div className="w-full bg-[#111] border border-white/10 rounded-[40px] p-12 shadow-2xl space-y-8">
                <div className="text-center"><h2 className="text-3xl font-black text-white">Analyze with {activeTemplate.name}</h2></div>
                <div className="border-2 border-dashed border-white/10 rounded-[32px] p-16 text-center hover:bg-white/5 relative cursor-pointer">
                    <input type="file" multiple onChange={handleFileUpload} className="absolute inset-0 opacity-0 cursor-pointer" />
                    <Upload className="w-8 h-8 text-gray-400 mx-auto mb-4" />
                    <p className="text-sm text-gray-400 font-bold">Select contracts for automated review</p>
                </div>
                <div className="flex gap-4">
                   <button onClick={handleAnalysis} disabled={loading || !documents.length} className="flex-1 py-4 bg-violet-600 text-white rounded-2xl font-black flex items-center justify-center gap-2">
                      {loading ? <><Loader className="w-5 h-5 animate-spin" /> Analyzing via {selectedModel}...</> : <><Zap className="w-5 h-5"/> Start Analysis ({documents.length * getModelCost(selectedModel)}c)</>}
                   </button>
                </div>
             </div>
          </div>
        )}

        {view === 'editor' && activeTemplate && (
          <TemplateEditor template={activeTemplate} setTemplate={setActiveTemplate} onSave={() => showNotify("Saved")} onExport={() => {}} onShowMegaPrompt={() => setMegaPromptOpen(true)} onModifyWithAI={() => setModifyModalOpen(true)} onClose={() => setView('dashboard')} />
        )}

        {view === 'results' && results.length > 0 && (
          <ResultsView results={results} documents={documents} onDraftEmail={async (d) => alert(await draftEmail(d))} onSuggestRevision={async (c, o, i) => { const r = await suggestRevision(c, o, i); setRevisionData({ title: c, original: o, revised: r }); }} onChat={(q) => chatWithDoc("", q, documents.map(d => d.content).join("\n"))} loadingAi={loading} userCredits={credits} onConsumeCredits={(c) => { if(credits >= c) { setCredits(prev => prev - c); return true; } return false; }} />
        )}
      </main>

      <CreateTemplateModal isOpen={createModalOpen} onClose={() => setCreateModalOpen(false)} onCreate={handleCreateTemplate} loading={loading} />
      <ProviderSettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} keys={apiKeys} onSave={saveKeys} />
      <MegaPromptModal isOpen={megaPromptOpen} onClose={() => setMegaPromptOpen(false)} template={activeTemplate || undefined} />
      <ModifyTemplateModal isOpen={modifyModalOpen} onClose={() => setModifyModalOpen(false)} onModify={() => {}} loading={loading} />
      <RevisionModal isOpen={!!revisionData} onClose={() => setRevisionData(null)} data={revisionData} />
    </div>
  );
}
